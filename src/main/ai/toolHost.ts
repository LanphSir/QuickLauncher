/**
 * 工具宿主（v0.6.3）：把一次工具调用送进插件页，等它执行完，把结果带回来。
 *
 * 插件工具的执行**必须发生在插件自己的页面里**。理由不是优雅，是隔离：
 * 插件的数据、权限、存储都在它自己的渲染进程里，主进程只负责传参和收结果；
 * 如果主进程替它执行，等于把插件的能力搬进了一个权限更高的地方。
 *
 * 四个必须处理的现实：
 * 1. **页面可能还没起来**。懒创建 + 等待加载（TOOL_HOST_READY_MS），
 *    等不到就回一句「插件没就绪」，而不是让模型干等到超时。
 * 2. **插件可能不回话**。工具声明了 timeoutMs，到点就按超时收尾；迟到的回执
 *    按 callId 找不到等待者，直接丢弃（不能让它覆盖下一轮的结果）。
 * 3. **页面可能崩溃**。崩溃后视图已被 pluginHost 卸载，这里重建一次再试；
 *    再失败就如实回报——重试一次的成本远低于「用户看到一句不知所谓的失败」。
 * 4. **用完要还内存**。空闲 TOOL_HOST_IDLE_MS 后回收视图，但用户正开着它就不动。
 */
import type { WebContents } from 'electron'
import { AI_TOOL_CALL_CHANNEL } from '../../shared/pluginApi'
import { TOOL_HOST_IDLE_MS, TOOL_HOST_READY_MS, type AiToolReply } from '../../shared/ai'
import { getPlugin } from '../plugin/manager'
import { getCaller } from '../plugin/callerRegistry'
import { releaseIdlePluginView, warmPluginContents } from '../windows/pluginHost'

export interface PluginToolResult {
  ok: boolean
  text: string
  error?: string
  /** 页面级故障（崩溃/被回收/没起来）：调用方可以重建视图后重试一次 */
  retryable?: boolean
}

interface Pending {
  callId: string
  pluginId: string
  resolve(reply: AiToolReply): void
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, Pending>()

/** 每个插件最近一次被工具调用的时间，用于空闲回收 */
const lastUsed = new Map<string, number>()

let sweeper: ReturnType<typeof setInterval> | null = null

function ensureSweeper(): void {
  if (sweeper) return
  sweeper = setInterval(() => {
    const now = Date.now()
    for (const [pluginId, at] of [...lastUsed]) {
      if (now - at < TOOL_HOST_IDLE_MS) continue
      if (releaseIdlePluginView(pluginId)) lastUsed.delete(pluginId)
    }
  }, 15_000)
  // 定时器不该拖住应用退出
  sweeper.unref?.()
}

/** 等待页面加载完成。返回 false 表示超时或页面没了 */
async function waitReady(wc: WebContents, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (wc.isDestroyed()) return false
    if (!wc.isLoading()) return true
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  return !wc.isDestroyed() && !wc.isLoading()
}

function callIdOf(): string {
  return `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** 把一次调用送进指定插件的页面，等回执 */
function invokeOnce(pluginId: string, shortName: string, args: Record<string, unknown>, timeoutMs: number): Promise<PluginToolResult> {
  const rec = getPlugin(pluginId)
  if (!rec) return Promise.resolve({ ok: false, text: '', error: `插件 ${pluginId} 不存在（可能已被卸载）` })
  if (rec.manifest.type !== 'web') {
    return Promise.resolve({ ok: false, text: '', error: `${rec.manifest.name} 不是网页型插件，无法执行工具` })
  }

  let wc: WebContents | null
  try {
    wc = warmPluginContents(rec)
  } catch (err) {
    return Promise.resolve({ ok: false, text: '', error: `插件页面拉起失败：${errText(err)}` })
  }
  if (!wc) return Promise.resolve({ ok: false, text: '', error: `${rec.manifest.name} 的页面已被回收，请重试` })
  lastUsed.set(pluginId, Date.now())
  ensureSweeper()

  const callId = callIdOf()
  return new Promise<PluginToolResult>((resolve) => {
    let settled = false
    const target = wc as WebContents
    const cleanup = (): void => {
      target.off('render-process-gone', onGone)
      target.off('destroyed', onGone)
    }
    const finish = (result: PluginToolResult): void => {
      if (settled) return
      settled = true
      const entry = pending.get(callId)
      if (entry) clearTimeout(entry.timer)
      pending.delete(callId)
      cleanup()
      lastUsed.set(pluginId, Date.now())
      resolve(result)
    }

    // 页面崩了不该让模型干等满超时：立刻收尾，并标记成可重建
    const onGone = (): void => {
      finish({ ok: false, text: '', error: `「${rec.manifest.name}」的页面在执行过程中崩溃了`, retryable: true })
    }
    target.once('render-process-gone', onGone)
    target.once('destroyed', onGone)

    const timer = setTimeout(() => {
      finish({ ok: false, text: '', error: `「${rec.manifest.name}」在 ${Math.round(timeoutMs / 1000)} 秒内没有返回结果（工具超时）` })
    }, timeoutMs)
    pending.set(callId, {
      callId,
      pluginId,
      timer,
      resolve: (reply) => {
        if (reply.ok) {
          finish({ ok: true, text: stringifyResult(reply.result) })
        } else {
          finish({ ok: false, text: '', error: reply.error || '插件没有说明失败原因' })
        }
      }
    })

    void (async () => {
      const ready = await waitReady(target, TOOL_HOST_READY_MS)
      if (!ready) {
        finish({ ok: false, text: '', error: `「${rec.manifest.name}」的页面没有就绪（加载超时）`, retryable: true })
        return
      }
      try {
        target.send(AI_TOOL_CALL_CHANNEL, { callId, name: shortName, args })
      } catch (err) {
        finish({ ok: false, text: '', error: `无法把调用送给插件：${errText(err)}`, retryable: true })
      }
    })()
  })
}

/**
 * 执行一次插件工具。
 *
 * 崩溃重试：只有 `retryable`（页面崩溃/被回收/没起来）才重建视图重来一次。
 * 工具本身报错不重试——那是插件的业务判断（参数不对、文件不存在），
 * 重试只会让用户多等一遍同样的失败。
 */
export async function callPluginTool(
  pluginId: string,
  shortName: string,
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<PluginToolResult> {
  const first = await invokeOnce(pluginId, shortName, args, timeoutMs)
  if (first.ok || !first.retryable) return first
  return invokeOnce(pluginId, shortName, args, timeoutMs)
}

/** 插件回执入口：plugin/api/ai.ts 收到通道调用后转到这里 */
export function handlePluginToolReply(sender: WebContents, reply: AiToolReply): { ok: boolean; message?: string } {
  const entry = pending.get(reply.callId)
  if (!entry) return { ok: false, message: '这次调用已经超时或结束' }
  // 身份核对：只接受「正等着它的那个插件」的回执。
  // 少了这一步，任何插件都能凭猜到的 callId 冒充别的插件回结果。
  const caller = getCaller(sender)
  if (!caller || caller.manifest.id !== entry.pluginId) {
    console.warn(`[ai] 拒绝了 ${caller?.manifest.id ?? '未知插件'} 对 ${entry.pluginId} 调用的回执`)
    return { ok: false, message: '回执来源与调用方不一致' }
  }
  entry.resolve({
    callId: reply.callId,
    ok: reply.ok === true,
    ...(reply.result !== undefined ? { result: reply.result } : {}),
    ...(typeof reply.error === 'string' ? { error: reply.error } : {})
  })
  return { ok: true }
}

/** 把插件返回的任意值压成一段文本：模型读文本最稳，JSON 也算文本 */
function stringifyResult(value: unknown): string {
  if (value === undefined || value === null) return '（插件没有返回内容）'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 应用退出时清掉等待者：留下定时器只会让进程迟迟不退出 */
export function shutdownToolHost(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer)
  pending.clear()
  if (sweeper) {
    clearInterval(sweeper)
    sweeper = null
  }
}
