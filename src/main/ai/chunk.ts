/**
 * 解析 OpenAI 流式响应里的单个 `data:` 负载。
 *
 * 三种形态都要认：
 * 1. 正常增量（delta.content / delta.reasoning_content）
 * 2. `[DONE]` 结束标记
 * 3. 某些网关在流中途塞一条 `{"error":{...}}`（HTTP 已经是 200，错误只在流里）
 */
/** 流式 tool_calls 增量：名字只在前几帧出现，参数是一点点拼起来的 JSON 字符串 */
export interface ToolCallDelta {
  /** 同一次响应里的序号：并行调用时靠它把碎片归到同一个调用上 */
  index: number
  id?: string
  name?: string
  args?: string
}

export interface ChatDelta {
  text?: string
  reasoning?: string
  usage?: { input: number; output: number }
  /** 收到 [DONE]：正常收尾 */
  stop?: boolean
  /** finish_reason，如 stop / length / tool_calls */
  finish?: string
  /** 流内错误，调用方应立即中止并报给界面 */
  error?: string
  /** 本帧携带的工具调用增量（可能为空数组以外的一到多条） */
  toolCalls?: ToolCallDelta[]
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

/**
 * 解析 `delta.tool_calls`。
 *
 * 形态（OpenAI 兼容端点一致）：
 * 第一帧带 id 与 function.name，后续帧只带 index 与 arguments 的碎片。
 * 这里不做拼接——拼接要跨帧，属于有状态的事，交给调用方；
 * 本函数只保证「能读出来的字段都读出来，读不出来就跳过这一项」。
 */
function parseToolCalls(raw: unknown): ToolCallDelta[] {
  if (!Array.isArray(raw)) return []
  const out: ToolCallDelta[] = []
  for (const item of raw) {
    const record = asRecord(item)
    if (!record) continue
    const fn = asRecord(record.function)
    const delta: ToolCallDelta = {
      index: typeof record.index === 'number' && Number.isFinite(record.index) ? record.index : out.length
    }
    const id = str(record.id)
    if (id) delta.id = id
    const name = str(fn?.name)
    if (name) delta.name = name
    // arguments 可能是空串（部分网关先发一帧空的占位），空串没有信息量
    if (typeof fn?.arguments === 'string' && fn.arguments) delta.args = fn.arguments
    out.push(delta)
  }
  return out
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
    const calls = parseToolCalls(delta.tool_calls)
    if (calls.length) out.toolCalls = calls
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
