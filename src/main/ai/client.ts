/**
 * 与 OpenAI 兼容端点对话的网络层。
 *
 * 只做两件事：把请求发出去、把 SSE 增量回调上来；业务状态（消息、会话、落盘）
 * 都在 chat.ts，这样换传输方式（比如以后走 WebSocket）不用动会话逻辑。
 */
import type { BuiltRequest } from './provider'
import { createSseDecoder } from './sse'
import { parseChatChunk, type ToolCallDelta } from './chunk'

export interface StreamHandlers {
  onText(delta: string): void
  onReasoning(delta: string): void
  onUsage(input: number, output: number): void
  /** 工具调用增量：碎片由调用方按 index 归并（见 chat.ts 的 ToolCallCollector） */
  onToolCall?(delta: ToolCallDelta): void
}

/** 把各家五花八门的错误体压成一句人话：状态码给方向，正文给细节 */
export function describeHttpError(status: number, body: string): string {
  const detail = body
    .replace(/\s+/g, ' ')
    .slice(0, 200)
    .trim()
  const head =
    status === 401 || status === 403
      ? '密钥无效或没有权限'
      : status === 404
        ? '接口地址不对（确认 baseURL 是否写到 /v1）'
        : status === 429
          ? '触发限流或额度用尽'
          : status >= 500
            ? '服务端错误'
            : '请求失败'
  return `${head}（HTTP ${status}）${detail ? `：${detail}` : ''}`
}

export class AiHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'AiHttpError'
  }
}

/**
 * 流式对话。返回时流已结束（正常收到 [DONE]、或对端关闭）；
 * 用户中断通过 signal 抛 AbortError，由上层转成「已停止」。
 */
export async function streamChat(
  req: BuiltRequest,
  signal: AbortSignal,
  handlers: StreamHandlers
): Promise<void> {
  const res = await fetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
    signal
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new AiHttpError(describeHttpError(res.status, text), res.status)
  }
  if (!res.body) throw new Error('响应没有内容流（该端点可能不支持 stream）')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const sse = createSseDecoder()

  const handle = (data: string): boolean => {
    const delta = parseChatChunk(data)
    if (!delta) return false
    if (delta.error) throw new AiHttpError(delta.error, 200)
    if (delta.reasoning) handlers.onReasoning(delta.reasoning)
    if (delta.text) handlers.onText(delta.text)
    if (delta.toolCalls) for (const call of delta.toolCalls) handlers.onToolCall?.(call)
    if (delta.usage) handlers.onUsage(delta.usage.input, delta.usage.output)
    return delta.stop === true
  }

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    for (const frame of sse.push(decoder.decode(value, { stream: true }))) {
      if (handle(frame.data)) return
    }
  }
  // 少数实现在 [DONE] 前后不留空行，收尾时补一次
  for (const frame of sse.flush()) {
    if (handle(frame.data)) return
  }
}

/**
 * 一次性（非流式）补全。只用于后台任务：生成滚动摘要、以及将来可能的标题优化。
 * 这些场景用户不在等字，流式反而要多写一套拼接逻辑。
 */
export async function completeChat(req: BuiltRequest, signal: AbortSignal): Promise<string> {
  const body = { ...(req.body as Record<string, unknown>), stream: false }
  const res = await fetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(body),
    signal
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new AiHttpError(describeHttpError(res.status, text), res.status)
  }
  const json = (await res.json().catch(() => null)) as unknown
  const choices = json && typeof json === 'object' ? (json as Record<string, unknown>).choices : undefined
  if (!Array.isArray(choices) || !choices.length) return ''
  const first = choices[0] as Record<string, unknown>
  const message = first?.message as Record<string, unknown> | undefined
  const content = message?.content
  return typeof content === 'string' ? content : ''
}

/** 探活：GET /models 能同时验证地址与密钥，比发一次真实对话便宜 */
export async function fetchModels(
  url: string,
  apiKey: string | null,
  timeoutMs = 10000
): Promise<{ ok: boolean; models?: string[]; message?: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers: Record<string, string> = {}
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    const res = await fetch(url, { headers, signal: controller.signal })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, message: describeHttpError(res.status, text) }
    }
    const json = (await res.json().catch(() => null)) as unknown
    const models: string[] = []
    const data = json && typeof json === 'object' ? (json as Record<string, unknown>).data : undefined
    if (Array.isArray(data)) {
      for (const item of data) {
        const id =
          item && typeof item === 'object' ? (item as Record<string, unknown>).id : undefined
        if (typeof id === 'string' && id) models.push(id)
      }
    }
    return { ok: true, models: models.slice(0, 50) }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return { ok: false, message: '连接超时（10s）' }
    return { ok: false, message: `连不上：${err instanceof Error ? err.message : String(err)}` }
  } finally {
    clearTimeout(timer)
  }
}
