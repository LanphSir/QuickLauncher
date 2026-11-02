/**
 * 对话编排：一条用户消息进 → 流式增量出 → 结束时落一条完整回答。
 *
 * 两个刻意的取舍：
 * 1. **回答只在结束时落盘**。中途被停止/失败/进程被杀，会话里只有用户那条问题，
 *    不会留下一条"永远正在输入"的半截消息（下次打开也没法分辨它到底是死是活）。
 * 2. **增量合并后再发 IPC**。逐 token `send` 在长回答里会打上几千次 IPC，
 *    合并到 16ms 一帧对界面没有任何区别，成本降一个量级。
 */
import type { WebContents } from 'electron'
import { AI_DELTA_CHANNEL } from '../../shared/pluginApi'
import type {
  AiChatMessage,
  AiMessagePart,
  AiSendRequest,
  AiSendResult,
  AiStreamEvent
} from '../../shared/ai'
import { AiHttpError, streamChat } from './client'
import { buildChatRequest, modelId } from './provider'
import { createMessage, newMessageId, titleFromText, toApiMessages } from './sessionModel'
import { getAiConfig, resolveModel } from './settings'
import { createSession, getSession, saveSession } from './store'

interface ActiveRun {
  controller: AbortController
}

/** sessionId → 正在生成的请求。一个会话同时只允许一条，避免历史交错 */
const runs = new Map<string, ActiveRun>()

const FLUSH_MS = 16

function emit(sender: WebContents | null, event: AiStreamEvent): void {
  if (!sender || sender.isDestroyed()) return
  try {
    sender.send(AI_DELTA_CHANNEL, event)
  } catch {
    // 页面正在销毁：界面已经没了，丢弃即可
  }
}

/**
 * 中断的判定不能只靠 instanceof：abort 抛出的是 DOMException，在部分运行时不继承 Error。
 * 更可靠的是看 signal.aborted —— 见下方 finalize 前的判断。
 */
function isAbortError(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError') return true
  return err instanceof Error && /abort/i.test(err.message)
}

function errorText(err: unknown): string {
  if (err instanceof AiHttpError) return err.message
  if (err instanceof Error) {
    if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(err.message)) {
      return `连不上模型端点：${err.message}`
    }
    return err.message
  }
  return String(err)
}

/** 增量合并器：16ms 内的多个 token 合成一条事件 */
function createEmitter(sender: WebContents | null, sessionId: string, messageId: string) {
  let text = ''
  let reasoning = ''
  let timer: ReturnType<typeof setTimeout> | null = null

  function flush(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (text) {
      emit(sender, { type: 'text', sessionId, messageId, delta: text })
      text = ''
    }
    if (reasoning) {
      emit(sender, { type: 'reasoning', sessionId, messageId, delta: reasoning })
      reasoning = ''
    }
  }

  function schedule(): void {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      flush()
    }, FLUSH_MS)
  }

  return {
    text(delta: string): void {
      text += delta
      schedule()
    },
    reasoning(delta: string): void {
      reasoning += delta
      schedule()
    },
    usage(input: number, output: number): void {
      emit(sender, { type: 'usage', sessionId, messageId, input, output })
    },
    flush
  }
}

export function isRunning(sessionId: string): boolean {
  return runs.has(sessionId)
}

export function stopRun(sessionId: string): { ok: boolean } {
  const run = runs.get(sessionId)
  if (!run) return { ok: false }
  run.controller.abort()
  return { ok: true }
}

export function stopAll(): void {
  for (const run of runs.values()) run.controller.abort()
  runs.clear()
}

/**
 * 发一条消息。sender 是 AI 插件页的 webContents（事件推给它），
 * 由调用方（plugin/api/ai.ts）从网关上下文里取，不信任 payload 里的任何身份。
 */
export async function sendMessage(
  sender: WebContents | null,
  req: AiSendRequest
): Promise<AiSendResult> {
  const text = String(req?.text ?? '').trim()
  if (!text) return { ok: false, sessionId: '', messageId: '', message: '消息为空' }

  const resolved = resolveModel(req.model)
  if (!resolved.ok) return { ok: false, sessionId: '', messageId: '', message: resolved.message }

  let session = req.sessionId ? getSession(req.sessionId) : null
  if (req.sessionId && !session) {
    return { ok: false, sessionId: req.sessionId, messageId: '', message: '会话不存在（可能已被删除）' }
  }
  if (!session) session = createSession()
  if (runs.has(session.id)) {
    return { ok: false, sessionId: session.id, messageId: '', message: '上一条还在生成，先停止或等它结束' }
  }

  const modelRef = modelId(resolved.provider.id, resolved.model)
  const assistantId = newMessageId()
  const userMessage = createMessage('user', [{ type: 'text', text }])
  const isFirst = session.messages.length === 0
  const title = isFirst ? titleFromText(text) : session.title

  // 问题先落盘：即使随后进程被杀，用户也不会丢掉刚打的那段
  session = saveSession({
    ...session,
    title,
    model: modelRef,
    messages: [...session.messages, userMessage]
  })

  const controller = new AbortController()
  runs.set(session.id, { controller })
  const emitter = createEmitter(sender, session.id, assistantId)
  emit(sender, { type: 'start', sessionId: session.id, messageId: assistantId, model: modelRef })

  let textOut = ''
  let reasoningOut = ''

  const finalize = (outcome: { stopped?: boolean; error?: string }): void => {
    emitter.flush()
    runs.delete(session!.id)

    const parts: AiMessagePart[] = []
    if (reasoningOut) parts.push({ type: 'reasoning', text: reasoningOut })
    if (textOut) parts.push({ type: 'text', text: textOut })

    // 既没正文也没错误：多半是模型只回了 finish_reason，界面需要一句明确的话
    const error = outcome.error ?? (parts.length ? undefined : '模型没有返回任何内容')
    const assistant: AiChatMessage = {
      id: assistantId,
      role: 'assistant',
      parts,
      createdAt: Date.now(),
      model: modelRef,
      ...(outcome.stopped ? { stopped: true } : {}),
      ...(error ? { error } : {})
    }
    saveSession({ ...session!, messages: [...session!.messages, assistant] })
    emit(sender, {
      type: 'done',
      sessionId: session!.id,
      messageId: assistantId,
      ...(outcome.stopped ? { stopped: true } : {}),
      ...(error ? { error } : {})
    })
  }

  const run = async (): Promise<void> => {
    try {
      const apiMessages = toApiMessages(session!.messages, getAiConfig().systemPrompt)
      const built = buildChatRequest(resolved.provider, resolved.model, resolved.apiKey, apiMessages)
      await streamChat(built, controller.signal, {
        onText: (delta) => {
          textOut += delta
          emitter.text(delta)
        },
        onReasoning: (delta) => {
          reasoningOut += delta
          emitter.reasoning(delta)
        },
        onUsage: (input, output) => {
          emitter.usage(input, output)
        }
      })
      // 关键：abort 之后 fetch 的 body 有时只是"正常结束"而不是抛错，
      // 只看异常会把用户主动停止记成一次完整回答（界面显示不出"已停止"）
      finalize(controller.signal.aborted ? { stopped: true } : {})
    } catch (err) {
      finalize(controller.signal.aborted || isAbortError(err) ? { stopped: true } : { error: errorText(err) })
    }
  }

  // 立刻返回「已受理」：结果全部走事件流。
  // 若在这里 await 到流结束，调用方拿不到返回值的这段时间里连"停止"都发不出去
  // （同一页面的 await 会一直挂到整段回答生成完）。
  void run()
  return { ok: true, sessionId: session.id, messageId: assistantId }
}
