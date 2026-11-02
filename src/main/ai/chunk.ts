/**
 * 解析 OpenAI 流式响应里的单个 `data:` 负载。
 *
 * 三种形态都要认：
 * 1. 正常增量（delta.content / delta.reasoning_content）
 * 2. `[DONE]` 结束标记
 * 3. 某些网关在流中途塞一条 `{"error":{...}}`（HTTP 已经是 200，错误只在流里）
 */
export interface ChatDelta {
  text?: string
  reasoning?: string
  usage?: { input: number; output: number }
  /** 收到 [DONE]：正常收尾 */
  stop?: boolean
  /** finish_reason，如 stop / length */
  finish?: string
  /** 流内错误，调用方应立即中止并报给界面 */
  error?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function parseChatChunk(data: string): ChatDelta | null {
  const raw = data.trim()
  if (!raw) return null
  if (raw === '[DONE]') return { stop: true }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 非 JSON 的 data 行：兼容实现偶尔塞注释，直接忽略
    return null
  }
  const json = asRecord(parsed)
  if (!json) return null

  const errObj = asRecord(json.error)
  if (errObj) {
    return { error: str(errObj.message) ?? '模型返回错误' }
  }

  const out: ChatDelta = {}
  const choices = Array.isArray(json.choices) ? json.choices : []
  const first = asRecord(choices[0])
  const delta = asRecord(first?.delta)
  if (delta) {
    const text = str(delta.content)
    if (text) out.text = text
    // 思维链字段各家叫法不一：DeepSeek 用 reasoning_content，部分网关用 reasoning
    const reasoning = str(delta.reasoning_content) ?? str(delta.reasoning)
    if (reasoning) out.reasoning = reasoning
  }
  const finish = str(first?.finish_reason)
  if (finish) out.finish = finish

  const usage = asRecord(json.usage)
  if (usage) {
    const input = num(usage.prompt_tokens)
    const output = num(usage.completion_tokens)
    if (input || output) out.usage = { input, output }
  }
  return out
}
