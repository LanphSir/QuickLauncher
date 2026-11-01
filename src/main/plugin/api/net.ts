import { net } from 'electron'
import type { PluginRecord } from '../manager'
import { defineApi } from './define'
import { int, object, oneOf, optional, str, stringRecord } from './validate'

/**
 * 网络能力：插件页跑在 plugin:// 下，直接 fetch 三方 API 会被 CORS 拦，
 * 所以 HTTP 请求统一交给主进程转发。权限有两层：
 *   1. manifest 声明 `net` 权限（网关校验）
 *   2. manifest 的 `hosts` 白名单（本文件校验，逐跳校验重定向）
 * 换句话说：拿到 net 权限 ≠ 能访问任意地址，还得把域写进 hosts。
 *
 * 为什么不用 net.fetch：它不支持「先看 302 目标再决定跟不跟」——
 * `redirect: 'manual'` 会直接以 "Redirect was cancelled" 失败。用 net.request
 * 的 redirect 事件才能逐跳裁定，避免被一个 302 带到白名单之外的域。
 */

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_REQUEST_BODY = 2 * 1024 * 1024
const DEFAULT_TIMEOUT = 15_000
const MAX_TIMEOUT = 60_000
const MAX_REDIRECTS = 5

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const

/** 逐跳头 + 身份头由主进程接管：插件不能自己指定 Host/Cookie，也不能伪造长度 */
const BLOCKED_HEADERS = new Set([
  'host',
  'cookie',
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization'
])

interface HostRule {
  wildcard: boolean
  host: string
  port?: string
}

function parseRule(raw: string): HostRule | null {
  const idx = raw.lastIndexOf(':')
  const hasPort = idx > 0 && /^\d+$/.test(raw.slice(idx + 1))
  const hostPart = hasPort ? raw.slice(0, idx) : raw
  const port = hasPort ? raw.slice(idx + 1) : undefined
  if (!hostPart) return null
  const wildcard = hostPart.startsWith('*.')
  return {
    wildcard,
    host: (wildcard ? hostPart.slice(2) : hostPart).toLowerCase(),
    port
  }
}

function rulesOf(rec: PluginRecord): HostRule[] {
  return (rec.manifest.hosts ?? [])
    .map(parseRule)
    .filter((rule): rule is HostRule => rule !== null && Boolean(rule.host))
}

function matchHost(rules: HostRule[], url: URL): boolean {
  const host = url.hostname.toLowerCase()
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  return rules.some((rule) => {
    if (rule.port && rule.port !== port) return false
    // *.example.com 同时匹配裸域 example.com（与浏览器扩展的 match pattern 一致）
    if (rule.wildcard) return host === rule.host || host.endsWith(`.${rule.host}`)
    return host === rule.host
  })
}

function assertAllowed(rec: PluginRecord, target: URL): void {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`参数非法: 仅允许 http(s)，收到 ${target.protocol}`)
  }
  const rules = rulesOf(rec)
  if (!rules.length) {
    throw new Error(`插件 ${rec.manifest.id} 未在 plugin.json 的 hosts 中声明任何域，网络请求已拒绝`)
  }
  if (!matchHost(rules, target)) {
    const declared = rules.map((r) => `${r.wildcard ? '*.' : ''}${r.host}${r.port ? `:${r.port}` : ''}`).join(', ')
    throw new Error(`网络请求被拒: ${target.hostname} 不在 manifest.hosts 白名单内（已声明 ${declared}）`)
  }
}

function sanitizeHeaders(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    if (BLOCKED_HEADERS.has(key.toLowerCase())) {
      console.warn(`[net] 已忽略受控请求头: ${key}`)
      continue
    }
    out[key] = value
  }
  return out
}

interface RawResponse {
  status: number
  headers: Record<string, string>
  body: string
  truncated: boolean
  url: string
}

/**
 * 发一次请求：redirect 事件里逐跳校验，白名单外直接 abort 并抛策略错误。
 * 响应体边读边计数，超过上限立即截断并中断下载（不把几十 MB 拉进内存）。
 */
function send(
  rec: PluginRecord,
  target: URL,
  verb: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeout: number
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let settled = false
    let policyError: Error | null = null
    let current = target
    let redirects = 0

    const request = net.request({
      url: target.toString(),
      method: verb,
      redirect: 'manual',
      // 不带任何 cookie：插件拿不到主面板/其他插件的登录态
      credentials: 'omit',
      headers
    })

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`请求超时（${timeout}ms）: ${target.hostname}`)))
      request.abort()
    }, timeout)

    function finish(fn: () => void): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    request.on('redirect', (_status, _method, redirectUrl) => {
      if (settled) return
      // 策略性拒绝：abort() 在 redirect 阶段不会触发 error 事件，必须自己把 Promise 结掉
      const blockWith = (err: Error): void => {
        policyError = err
        finish(() => reject(err))
        request.abort()
      }
      if (++redirects > MAX_REDIRECTS) {
        blockWith(new Error(`重定向次数过多（上限 ${MAX_REDIRECTS} 次）`))
        return
      }
      let next: URL
      try {
        next = new URL(redirectUrl, current)
      } catch {
        blockWith(new Error(`重定向目标非法: ${redirectUrl}`))
        return
      }
      try {
        assertAllowed(rec, next)
      } catch (err) {
        blockWith(err as Error)
        return
      }
      current = next
      request.followRedirect()
    })

    request.on('response', (response) => {
      const outHeaders: Record<string, string> = {}
      for (const [key, value] of Object.entries(response.headers)) {
        outHeaders[key] = Array.isArray(value) ? value.join(', ') : String(value)
      }
      const chunks: Buffer[] = []
      let size = 0
      let truncated = false

      response.on('data', (chunk: Buffer) => {
        if (settled) return
        if (size + chunk.length > MAX_RESPONSE_BYTES) {
          chunks.push(chunk.subarray(0, MAX_RESPONSE_BYTES - size))
          truncated = true
          const body = Buffer.concat(chunks).toString('utf-8')
          finish(() =>
            resolve({ status: response.statusCode, headers: outHeaders, body, truncated: true, url: current.toString() })
          )
          request.abort()
          return
        }
        chunks.push(chunk)
        size += chunk.length
      })

      response.on('end', () => {
        finish(() =>
          resolve({
            status: response.statusCode,
            headers: outHeaders,
            body: Buffer.concat(chunks).toString('utf-8'),
            truncated,
            url: current.toString()
          })
        )
      })

      response.on('error', (err) => finish(() => reject(policyError ?? err)))
    })

    request.on('error', (err) => finish(() => reject(policyError ?? err)))

    if (body !== undefined) request.write(body)
    request.end()
  })
}

export const netApi = [
  defineApi('plugin:net.request', {
    parse: object({
      url: str('url', { max: 2048 }),
      method: optional(oneOf('method', METHODS, { upper: true })),
      headers: optional(stringRecord('headers')),
      body: optional(str('body', { max: MAX_REQUEST_BODY, min: 0 })),
      timeoutMs: optional(int('timeoutMs', { min: 1000, max: MAX_TIMEOUT }))
    }),
    handle: async ({ rec }, { url, method, headers, body, timeoutMs }) => {
      const verb = method ?? 'GET'
      let target: URL
      try {
        target = new URL(url)
      } catch {
        throw new Error('参数非法: url 格式不正确')
      }
      assertAllowed(rec, target)

      const safeHeaders = sanitizeHeaders(headers ?? {})
      const res = await send(
        rec,
        target,
        verb,
        safeHeaders,
        verb === 'GET' || verb === 'HEAD' ? undefined : body,
        timeoutMs ?? DEFAULT_TIMEOUT
      )
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        headers: res.headers,
        body: res.body,
        truncated: res.truncated,
        url: res.url
      }
    }
  })
]
