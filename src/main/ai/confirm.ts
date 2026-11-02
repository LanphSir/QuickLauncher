/**
 * 风险确认（v0.6.3）：把「要不要执行这一步」交回给用户。
 *
 * 为什么确认放在 AI 插件页而不是主面板的 OverlayHost：
 * 插件页是原生 WebContentsView，盖在核心渲染层之上。核心层的浮层做得多好，
 * 都会出现在插件页**下面**——用户看到的是一段被遮住的对话和点不动的按钮。
 * 所以确认框由 AI 页自己渲染，交互规则与 OverlayHost 对齐（遮罩、Esc 取消、默认焦点在取消）。
 *
 * 三条安全默认：
 * 1. **超时按拒绝**：用户走开、面板被藏起来，都不能变成一次静默授权；
 * 2. **只放行 write**：`dangerous` 每次都要问，「本次会话不再询问」对它不适用；
 * 3. **会话级记忆**：勾了「不再询问」也只在本会话内有效，重启应用重新问。
 */
import { randomUUID } from 'node:crypto'
import { TOOL_CONFIRM_TIMEOUT_MS, type AiConfirmRequest, type AiStreamEvent, type AiToolRisk } from '../../shared/ai'

export interface ConfirmContext {
  sessionId: string
  messageId: string
  /** 把事件推给 AI 页（由 chat.ts 提供，避免这里依赖 WebContents） */
  notify(event: AiStreamEvent): void
}

export interface ConfirmDecision {
  allowed: boolean
  /** 记录用途：allowed / denied / timeout */
  kind: 'allowed' | 'denied' | 'timeout'
  reason?: string
}

interface Pending {
  requestId: string
  sessionId: string
  messageId: string
  fullName: string
  notify(event: AiStreamEvent): void
  resolve(decision: ConfirmDecision): void
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, Pending>()

/** 本会话内已被放行的工具（`sessionId\0fullName`） */
const sessionGrants = new Set<string>()

function grantKey(sessionId: string, fullName: string): string {
  return `${sessionId}\u0000${fullName}`
}

/**
 * 这个工具这次要不要问用户。
 * `dangerous` 一律返回 true——它的定义就是「每次都要人看着」。
 */
export function needsConfirm(risk: AiToolRisk, sessionId: string, fullName: string): boolean {
  if (risk === 'read') return false
  if (risk === 'dangerous') return true
  return !sessionGrants.has(grantKey(sessionId, fullName))
}

export function askConfirm(
  ctx: ConfirmContext,
  tool: { fullName: string; title: string; pluginName?: string; risk: AiToolRisk; args: string }
): Promise<ConfirmDecision> {
  const requestId = randomUUID()
  const request: AiConfirmRequest = {
    requestId,
    fullName: tool.fullName,
    title: tool.title,
    ...(tool.pluginName ? { pluginName: tool.pluginName } : {}),
    risk: tool.risk,
    args: tool.args,
    timeoutMs: TOOL_CONFIRM_TIMEOUT_MS,
    // 「本次会话不再询问」只对 write 开放：dangerous 每次都得人来点
    rememberable: tool.risk === 'write'
  }

  return new Promise<ConfirmDecision>((resolve) => {
    const timer = setTimeout(() => {
      finish(requestId, { allowed: false, kind: 'timeout', reason: '等待确认超时，已按拒绝处理' })
    }, TOOL_CONFIRM_TIMEOUT_MS)
    pending.set(requestId, {
      requestId,
      sessionId: ctx.sessionId,
      messageId: ctx.messageId,
      fullName: tool.fullName,
      notify: ctx.notify,
      resolve,
      timer
    })
    ctx.notify({ type: 'tool-confirm', sessionId: ctx.sessionId, messageId: ctx.messageId, request })
  })
}

function finish(requestId: string, decision: ConfirmDecision): void {
  const entry = pending.get(requestId)
  if (!entry) return
  pending.delete(requestId)
  clearTimeout(entry.timer)
  // 先让界面收起确认框，再回结果：顺序反过来的话，用户会看到框还在、但请求已经走了
  entry.notify({ type: 'tool-confirm-close', sessionId: entry.sessionId, messageId: entry.messageId, requestId })
  entry.resolve(decision)
}

/** AI 页的答复。返回 false 说明这条请求已经超时/被取消（按钮点晚了，不是错误） */
export function answerConfirm(requestId: string, allow: boolean, remember = false): boolean {
  const entry = pending.get(requestId)
  if (!entry) return false
  if (allow && remember) sessionGrants.add(grantKey(entry.sessionId, entry.fullName))
  finish(
    requestId,
    allow ? { allowed: true, kind: 'allowed' } : { allowed: false, kind: 'denied', reason: '用户拒绝了这次调用' }
  )
  return true
}

/** 停止生成 / 会话被删 / 页面销毁时，把所有等待中的确认一律按拒绝收尾 */
export function cancelConfirms(sessionId?: string): void {
  for (const [id, entry] of [...pending]) {
    if (sessionId && entry.sessionId !== sessionId) continue
    finish(id, { allowed: false, kind: 'denied', reason: '本次生成已停止，工具调用被取消' })
  }
}

/** 只给测试用：清掉会话级放行记录 */
export function resetSessionGrants(): void {
  sessionGrants.clear()
}
