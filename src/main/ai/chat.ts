/**
 * 对话编排：一条用户消息进 → 流式增量出 → 结束时落一条完整回答。
 *
 * v0.6.3 起多了一层：模型可以在回答中间要求调用工具，主进程执行完把结果交回，
 * 再让模型接着说。一轮用户消息最多 MAX_TOOL_ROUNDS 次来回、MAX_TOOL_CALLS 次调用。
 *
 * 几个刻意的取舍：
 * 1. **回答只在结束时落盘**。中途被停止/失败/进程被杀，会话里只有用户那条问题，
 *    不会留下一条"永远正在输入"的半截消息（下次打开也没法分辨它到底是死是活）。
 * 2. **增量合并后再发 IPC**。逐 token `send` 在长回答里会打上几千次 IPC，
 *    合并到 16ms 一帧对界面没有任何区别，成本降一个量级。
 * 3. **工具调用与结果成对出现**。历史里只要有 assistant.tool_calls，就必须有
 *    对应的 tool 结果消息，否则下一次请求会被服务端直接拒掉——所以中途触到
 *    上限/被停止时，宁可补一条「未执行」的结果，也不留半对。
 */
import type { WebContents } from 'electron'
import { AI_DELTA_CHANNEL } from '../../shared/pluginApi'
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_TOOL_CALLS,
  MAX_TOOL_ROUNDS,
  type AiChatMessage,
  type AiMessagePart,
  type AiSendRequest,
  type AiSendResult,
  type AiStreamEvent,
  type AiToolCallPart,
  type AiToolResultPart
} from '../../shared/ai'
import { getAttachments, readImageDataUrl } from './attach'
import { AiHttpError, streamChat } from './client'
import { buildChatRequest, modelId, type ApiContentPart, type ApiMessage, type ApiToolCall } from './provider'
import { createMessage, newMessageId, resultTextForModel, titleFromText, turnsOf } from './sessionModel'
import { getAiConfig, resolveModel } from './settings'
import { createSession, getSession, saveSession, saveSummary } from './store'
import { cancelConfirms } from './confirm'
import { summarizeHistory, summarizeRange } from './summary'
import { estimateTokens, fitTurns, type ChatTurn } from './tokens'
import { buildToolCatalog } from './toolCatalog'
import { ToolCallCollector } from './toolCalls'
import { describeCall, executeToolCall } from './toolExec'

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

/**
 * 消息片段的追加器。
 *
 * 与 emitter 并行维护一份「落档用的 parts」：界面看到的是事件流，磁盘上存的是 parts。
 * 两者必须按同样的规则合并（连续同类片段并进同一个 part），否则用户切走会话再切回来，
 * 会看到和刚才不一样的排版。
 */
function createPartWriter(parts: AiMessagePart[]) {
  return {
    text(delta: string): void {
      const last = parts[parts.length - 1]
      if (last?.type === 'text') last.text += delta
      else parts.push({ type: 'text', text: delta })
    },
    reasoning(delta: string): void {
      const last = parts[parts.length - 1]
      if (last?.type === 'reasoning') last.text += delta
      else parts.push({ type: 'reasoning', text: delta })
    },
    call(part: AiToolCallPart): void {
      parts.push(part)
    },
    result(part: AiToolResultPart): void {
      parts.push(part)
    }
  }
}

export function isRunning(sessionId: string): boolean {
  return runs.has(sessionId)
}

export function stopRun(sessionId: string): { ok: boolean } {
  const run = runs.get(sessionId)
  if (!run) return { ok: false }
  // 正在等用户确认的调用按拒绝收尾：否则 abort 之后那个 Promise 还要挂满 60 秒
  cancelConfirms(sessionId)
  run.controller.abort()
  return { ok: true }
}

export function stopAll(): void {
  cancelConfirms()
  for (const run of runs.values()) run.controller.abort()
  runs.clear()
}

/**
 * 拼请求体：system（含摘要）+ 逐轮对话。
 *
 * 只有带图的消息才用 content 数组，纯文字仍是字符串——
 * 兼容实现里对数组形式的支持参差不齐，能不用就不用。
 * 带工具调用的 assistant 消息按 OpenAI 的 tool_calls 形态展开，紧随其后的
 * 是 role=tool 的结果消息（顺序由 turnsOf 保证）。
 */
function assembleMessages(turns: ChatTurn[], system: string, summary?: string): ApiMessage[] {
  const out: ApiMessage[] = []
  const sysParts: string[] = []
  if (system.trim()) sysParts.push(system.trim())
  if (summary) sysParts.push(`【更早对话的摘要】\n${summary}`)
  if (sysParts.length) out.push({ role: 'system', content: sysParts.join('\n\n') })

  for (const turn of turns) {
    if (turn.role === 'assistant' && turn.toolCalls?.length) {
      const toolCalls: ApiToolCall[] = turn.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.apiName, arguments: call.args || '{}' }
      }))
      out.push({
        role: 'assistant',
        // 只调工具、没写正文时 content 必须是 null：空串在部分端点上会被当成
        // 「一条空的 assistant 消息」，与 tool_calls 一起出现时直接 400
        content: turn.text.trim() ? turn.text : null,
        tool_calls: toolCalls
      })
      const byCall = new Map((turn.toolResults ?? []).map((r) => [r.callId, r.text]))
      for (const call of turn.toolCalls) {
        out.push({
          role: 'tool',
          tool_call_id: call.id,
          content: byCall.get(call.id) ?? '（这次调用没有返回结果）'
        })
      }
      continue
    }

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

  /** 落档用的片段（推理/正文/工具调用/结果，按发生顺序） */
  const parts: AiMessagePart[] = []
  const writer = createPartWriter(parts)
  let droppedCount = 0
  let wasTruncated = false
  let limitNote = ''

  const finalize = (outcome: { stopped?: boolean; error?: string }): void => {
    // 触到工具上限时补的那句话也要走一遍事件流：只写进 parts 的话，
    // 当前这一屏永远看不到它（界面是靠事件拼的，不是靠重读会话）
    if (limitNote) {
      writer.text(limitNote)
      emitter.text(limitNote)
    }
    emitter.flush()
    runs.delete(sessionId)
    cancelConfirms(sessionId)

    // 既没正文也没工具也没错误：多半是模型只回了 finish_reason，界面需要一句明确的话
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
      const history = turnsOf(historyMessages)
      turnsForSummary = history

      // 工具目录每次发消息重建：授权刚被撤销时，这一条消息就不该再看到那个工具
      const catalog = buildToolCatalog()
      /** 本轮内产生、还没落盘的工具轮次，只参与后续请求 */
      const extraTurns: ChatTurn[] = []
      let rounds = 0
      let callCount = 0
      let stopped = false
      let limitHit = false

      const fixedTokens = estimateTokens(system) + (summary ? estimateTokens(summary) + 16 : 0)

      for (;;) {
        const fitted = fitTurns([...history, ...extraTurns], {
          contextWindow: resolved.contextWindow,
          maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
          fixedTokens
        })
        droppedCount = fitted.dropped
        wasTruncated = fitted.truncated
        keptStart = fitted.start

        const apiMessages = assembleMessages(fitted.kept, system, summary)
        const built = buildChatRequest(resolved.provider, resolved.model, resolved.apiKey, apiMessages, {
          maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
          ...(catalog.apiTools.length ? { tools: catalog.apiTools } : {})
        })

        const collector = new ToolCallCollector()
        let roundText = ''
        await streamChat(built, controller.signal, {
          onText: (delta) => {
            roundText += delta
            writer.text(delta)
            emitter.text(delta)
          },
          onReasoning: (delta) => {
            writer.reasoning(delta)
            emitter.reasoning(delta)
          },
          onUsage: (input, output) => {
            emitter.usage(input, output)
          },
          onToolCall: (delta) => collector.push(delta)
        })

        // abort 之后 fetch 的 body 有时只是"正常结束"而不是抛错，
        // 只看异常会把用户主动停止记成一次完整回答（界面显示不出"已停止"）
        if (controller.signal.aborted) {
          stopped = true
          break
        }

        const calls = collector.take()
        if (!calls.length) break

        emitter.flush()

        // 本轮的工具调用与结果一并记进 extraTurns，下一轮请求才拼得出来
        const turn: ChatTurn = {
          messageId: assistantId,
          role: 'assistant',
          text: roundText,
          images: [],
          toolCalls: [],
          toolResults: []
        }
        extraTurns.push(turn)

        for (const call of calls) {
          const described = describeCall(catalog, call)
          writer.call(described)
          emit(sender, { type: 'tool-call', sessionId, messageId: assistantId, call: described })

          const overRound = rounds >= MAX_TOOL_ROUNDS
          const overCount = callCount >= MAX_TOOL_CALLS
          if (overRound || overCount || controller.signal.aborted) {
            const why = controller.signal.aborted
              ? '本次生成已停止，工具调用被取消'
              : overRound
                ? `本轮工具调用已达上限（${MAX_TOOL_ROUNDS} 轮），未执行`
                : `本轮工具调用已达上限（${MAX_TOOL_CALLS} 次），未执行`
            limitHit = !controller.signal.aborted
            const skipped: AiToolResultPart = {
              type: 'tool_result',
              callId: described.callId,
              ok: false,
              text: '',
              error: why,
              durationMs: 0
            }
            writer.result(skipped)
            emit(sender, { type: 'tool-result', sessionId, messageId: assistantId, result: skipped })
            turn.toolResults?.push({ callId: skipped.callId, text: resultTextForModel(skipped) })
            continue
          }

          callCount++
          const result = await executeToolCall(
            {
              catalog,
              sessionId,
              messageId: assistantId,
              notify: (event) => emit(sender, event),
              signal: controller.signal
            },
            call
          )
          writer.result(result)
          turn.toolResults?.push({ callId: result.callId, text: resultTextForModel(result) })
        }

        rounds++
        // 把调用也写进 turn（必须在执行前定稿，因为下面按 index 对齐结果）
        turn.toolCalls = calls.map((call) => ({
          id: call.id,
          apiName: call.apiName,
          args: call.argsText
        }))

        if (controller.signal.aborted) {
          stopped = true
          break
        }
        if (limitHit) {
          limitNote = `（已达到本轮工具调用上限：${MAX_TOOL_ROUNDS} 轮 / ${MAX_TOOL_CALLS} 次，先停在这里）`
          break
        }
      }

      finalize(stopped || controller.signal.aborted ? { stopped: true } : {})
    } catch (err) {
      finalize(controller.signal.aborted || isAbortError(err) ? { stopped: true } : { error: errorText(err) })
    }

    // 摘要放在回答之后：它不该占用用户的等待时间，也不该因为失败影响这次回答。
    // keptStart 是按「历史 + 本轮工具轮次」算出来的，摘要只针对历史，
    // 所以先夹到历史长度以内——否则工具轮次把下界推过头，会把本该保留的段也压进去
    void maybeSummarize(sender, sessionId, turnsForSummary, Math.min(keptStart, turnsForSummary.length), resolved.contextWindow)
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
