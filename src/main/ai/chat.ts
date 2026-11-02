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
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  type AiChatMessage,
  type AiMessagePart,
  type AiSendRequest,
  type AiSendResult,
  type AiStreamEvent
} from '../../shared/ai'
import { getAttachments, readImageDataUrl } from './attach'
import { AiHttpError, streamChat } from './client'
import { buildChatRequest, modelId, type ApiContentPart, type ApiMessage } from './provider'
import { createMessage, newMessageId, titleFromText, turnsOf } from './sessionModel'
import { getAiConfig, resolveModel } from './settings'
import { createSession, getSession, saveSession, saveSummary } from './store'
import { summarizeHistory, summarizeRange } from './summary'
import { estimateTokens, fitTurns, type ChatTurn } from './tokens'

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
 * 拼请求体：system（含摘要）+ 逐轮对话。
 *
 * 只有带图的消息才用 content 数组，纯文字仍是字符串——
 * 兼容实现里对数组形式的支持参差不齐，能不用就不用。
 */
function assembleMessages(turns: ChatTurn[], system: string, summary?: string): ApiMessage[] {
  const out: ApiMessage[] = []
  const sysParts: string[] = []
  if (system.trim()) sysParts.push(system.trim())
  if (summary) sysParts.push(`【更早对话的摘要】\n${summary}`)
  if (sysParts.length) out.push({ role: 'system', content: sysParts.join('\n\n') })

  for (const turn of turns) {
    if (!turn.images.length) {
      out.push({ role: turn.role, content: turn.text })
      continue
    }
    const parts: ApiContentPart[] = []
    if (turn.text.trim()) parts.push({ type: 'text', text: turn.text })
    for (const image of turn.images) {
      const url = readImageDataUrl(image.fileId, image.mime)
      // 原图被清理掉了就跳过这一张：宁可少一张图，也不要整条请求失败
      if (url) parts.push({ type: 'image_url', image_url: { url } })
    }
    if (!parts.length) continue
    out.push({ role: turn.role, content: parts })
  }
  return out
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
  const files = getAttachments(req?.attachIds)
  if (!text && !files.length) {
    return { ok: false, sessionId: '', messageId: '', message: '消息为空' }
  }

  const resolved = resolveModel(req.model)
  if (!resolved.ok) return { ok: false, sessionId: '', messageId: '', message: resolved.message }

  // 图片是硬门槛：模型看不了图时提前拦下，否则服务端会回一句
  // "invalid content type" —— 用户完全不知道该改什么
  const imageCount = files.filter((f) => f.kind === 'image' && !f.error).length
  if (imageCount > 0 && !resolved.supportsVision) {
    return {
      ok: false,
      sessionId: req.sessionId ?? '',
      messageId: '',
      message: `「${resolved.model}」不支持图片：换一个能看图的模型，或移除图片附件（设置 → AI 里可标注哪些模型能读图）`
    }
  }

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

  const userParts: AiMessagePart[] = []
  if (text) userParts.push({ type: 'text', text })
  for (const file of files) userParts.push(file)
  const userMessage = createMessage('user', userParts)

  const isFirst = session.messages.length === 0
  const titleSeed = text || files.map((f) => f.name).join('、')
  const title = isFirst ? titleFromText(titleSeed) : session.title

  // 问题先落盘：即使随后进程被杀，用户也不会丢掉刚打的那段
  session = saveSession({
    ...session,
    title,
    model: modelRef,
    messages: [...session.messages, userMessage]
  })
  const sessionId = session.id
  const historyMessages = session.messages

  const controller = new AbortController()
  runs.set(sessionId, { controller })
  const emitter = createEmitter(sender, sessionId, assistantId)
  emit(sender, { type: 'start', sessionId, messageId: assistantId, model: modelRef })

  let textOut = ''
  let reasoningOut = ''
  let droppedCount = 0
  let wasTruncated = false

  const finalize = (outcome: { stopped?: boolean; error?: string }): void => {
    emitter.flush()
    runs.delete(sessionId)

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
    // 重新读一次再写：生成期间用户可能改了标题或删了会话
    const latest = getSession(sessionId)
    if (latest) saveSession({ ...latest, model: modelRef, messages: [...latest.messages, assistant] })

    emit(sender, {
      type: 'done',
      sessionId,
      messageId: assistantId,
      ...(outcome.stopped ? { stopped: true } : {}),
      ...(error ? { error } : {}),
      ...(droppedCount > 0 ? { dropped: droppedCount } : {}),
      ...(wasTruncated ? { truncated: true } : {})
    })
  }

  // 供请求后触发的摘要使用：保留区从哪开始，决定了这次真正被丢掉的是哪一段
  let turnsForSummary: ChatTurn[] = []
  let keptStart = 0

  const run = async (): Promise<void> => {
    try {
      const cfg = getAiConfig()
      const system = cfg.systemPrompt
      const summary = session.summary
      const turns = turnsOf(historyMessages)
      turnsForSummary = turns

      const fixedTokens =
        estimateTokens(system) + (summary ? estimateTokens(summary) + 16 : 0)
      const fitted = fitTurns(turns, {
        contextWindow: resolved.contextWindow,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        fixedTokens
      })
      droppedCount = fitted.dropped
      wasTruncated = fitted.truncated
      keptStart = fitted.start

      const apiMessages = assembleMessages(fitted.kept, system, summary)
      const built = buildChatRequest(resolved.provider, resolved.model, resolved.apiKey, apiMessages, {
        maxTokens: DEFAULT_MAX_OUTPUT_TOKENS
      })
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

    // 摘要放在回答之后：它不该占用用户的等待时间，也不该因为失败影响这次回答
    void maybeSummarize(sender, sessionId, turnsForSummary, keptStart, resolved.contextWindow)
  }

  // 立刻返回「已受理」：结果全部走事件流。
  // 若在这里 await 到流结束，调用方拿不到返回值的这段时间里连"停止"都发不出去
  // （同一页面的 await 会一直挂到整段回答生成完）。
  void run()
  return { ok: true, sessionId, messageId: assistantId }
}

/**
 * 超预算时把被丢掉的那段历史压成摘要，供下一轮使用。
 *
 * 触发条件看的是「这次实际丢了多少条」而不是「历史有多少条」：
 * 丢一两条不值得多一次请求，丢一大段才说明摘要真能省下东西。
 */
async function maybeSummarize(
  sender: WebContents | null,
  sessionId: string,
  turns: ChatTurn[],
  keptStart: number,
  contextWindow: number
): Promise<void> {
  const latest = getSession(sessionId)
  if (!latest) return

  // 压哪一段由纯函数决定：丢得太少、上次摘要已覆盖、摘要终点失效都会返回 null
  const slice = summarizeRange(turns, keptStart, latest.summaryUpTo)
  if (!slice) return

  const resolved = resolveModel(latest.model)
  if (!resolved.ok) return

  const summary = await summarizeHistory({
    provider: resolved.provider,
    model: resolved.model,
    apiKey: resolved.apiKey,
    previous: latest.summary,
    turns: slice,
    contextWindow: resolved.contextWindow
  })
  if (!summary) return

  const upTo = slice[slice.length - 1].messageId
  if (!saveSummary(sessionId, summary, upTo)) return
  emit(sender, { type: 'summary', sessionId, text: summary })
}

