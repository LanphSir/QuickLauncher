import { net, protocol, session } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { listPlugins, type PluginRecord } from './manager'
import { pluginHostOf, PLUGIN_SCHEME } from './urls'

/**
 * 插件专属协议：plugin://<插件 id>/<相对路径>
 *
 * 为什么不用 file://：file:// 的 origin 语义是"不透明"的，localStorage / cookie 边界不可靠，
 * 运行时 fetch 本地文件还会被 CORS 拦。换成自定义标准协议后：
 * - 每个插件一个真实 origin（plugin://com.launcher.handbook），存储天然按插件隔离
 * - 同源 fetch 自己的 json/md 直接可用，不必再靠构建期 `?raw` 打包
 * - 路径只在主进程解析，插件仍然拿不到任何文件系统句柄（铁律 4）
 */
/** 必须在 app ready 之前调用，否则 scheme 注册不生效 */
export function registerPluginSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PLUGIN_SCHEME,
      privileges: {
        standard: true, // 有 host，origin 语义完整（localStorage / fetch 边界成立）
        secure: true, // 视为安全上下文：crypto.subtle、Clipboard API 等可用
        supportFetchAPI: true, // 允许 fetch 本插件内的资源
        corsEnabled: true, // 走标准 CORS 检查：跨插件读取会被拦
        stream: true // 支持 <video>/<audio> 的流式读取与 Range 请求
      }
    }
  ])
}

function findPlugin(host: string): PluginRecord | undefined {
  const key = host.toLowerCase()
  // URL 的 host 会被规范化成小写，插件 id 可能是混合大小写，这里按不区分大小写匹配
  return listPlugins().find((rec) => rec.manifest.id.toLowerCase() === key)
}

function textResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
  })
}

type Resolved = { file: string } | { error: Response }

/**
 * 把 URL 解析成插件目录内的真实文件路径。
 * 两道守卫：① 解析后必须仍在插件目录内；② 拒绝任何以 . 开头的路径段（.git / .env 之类）。
 */
function resolveTarget(rec: PluginRecord, url: URL): Resolved {
  let rel: string
  try {
    rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  } catch {
    return { error: textResponse(400, '非法路径编码') }
  }
  if (rel.split(/[\\/]/).some((seg) => seg.startsWith('.'))) {
    return { error: textResponse(403, '禁止访问隐藏文件') }
  }

  const root = resolve(rec.dir)
  let target = resolve(root, rel || rec.manifest.entry || 'index.html')
  if (target !== root && !target.startsWith(root + sep)) {
    return { error: textResponse(403, '路径越界') }
  }
  if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'index.html')
  if (!existsSync(target) || !statSync(target).isFile()) {
    return { error: textResponse(404, `资源不存在: ${rel || rec.manifest.entry}`) }
  }
  return { file: target }
}

/**
 * 请求处理：交给 Chromium 自己的网络栈读文件，
 * MIME 推断、Range、流式传输都由它处理，比手写 readFile 更完整。
 */
export async function handlePluginRequest(request: Request): Promise<Response> {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return textResponse(400, '非法请求')
  }
  const rec = findPlugin(url.hostname)
  if (!rec) return textResponse(404, `插件不存在: ${url.hostname || '(空)'}`)

  // 兜底：请求若来自另一个插件页，直接拒绝（session 层已拦，这里防绕过）
  const from = pluginHostOf(request.referrer ?? '')
  if (from && from !== rec.manifest.id.toLowerCase()) {
    return textResponse(403, '禁止跨插件读取资源')
  }

  const resolved = resolveTarget(rec, url)
  if ('error' in resolved) return resolved.error

  try {
    const res = await net.fetch(pathToFileURL(resolved.file).toString())
    const headers = new Headers(res.headers)
    // 插件升级后同名文件内容会变，宁可每次读盘也不要给旧代码
    headers.set('cache-control', 'no-store')
    headers.set('x-content-type-options', 'nosniff')
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  } catch (err) {
    console.error(`[plugin] 读取资源失败 ${resolved.file}`, err)
    return textResponse(500, '资源读取失败')
  }
}

/** 默认 session 上注册一次（插件视图都走独立分区，这里兜底） */
export function installPluginProtocol(): void {
  installOnSession(session.defaultSession)
}

export function installOnSession(ses: Electron.Session): void {
  if (ses.protocol.isProtocolHandled(PLUGIN_SCHEME)) return
  ses.protocol.handle(PLUGIN_SCHEME, handlePluginRequest)
}
