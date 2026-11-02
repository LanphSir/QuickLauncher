/**
 * 上下文预算：估算 token、按预算裁剪、超长单条截断。
 *
 * 为什么自己估而不引 tiktoken：那套是 OpenAI 的分词器，对 DeepSeek / 通义 / 本地模型
 * 都不准，却要带几 MB 的 wasm。这里只需要「不把服务端撑爆」，宁可估高一点——
 * 估高只是少带几条历史，估低就是整条请求 400，用户看到的是一句他无法处理的报错。
 *
 * 估算口径：CJK 按 1 字 1 token（真实约 0.6–0.7，偏高），其余按 4 字符 1 token。
 */

/** 一条消息的固定开销（role、分隔符等），按 OpenAI 的经验值取 4 */
const MESSAGE_OVERHEAD = 4

/**
 * 一张图按多少 token 计。给到 800 是保守取值：
 * 1024×1024 在 gpt-4o 上约 765 token，低分辨率模式才 85。
 * 宁可多留，也不要在带图时把上下文算穿。
 */
const IMAGE_TOKENS = 800

/** 预览用的极端保守下限：再省也不能低于这个，否则模型连问题都读不全 */
export const MIN_LAST_MESSAGE_TOKENS = 512

function isCjk(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x303f) || // 中文标点
    (code >= 0x3040 && code <= 0x30ff) || // 日文假名
    (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // 基本汉字
    (code >= 0xac00 && code <= 0xd7af) || // 韩文
    (code >= 0xf900 && code <= 0xfaff) || // 兼容汉字
    (code >= 0xff00 && code <= 0xffef) || // 全角
    (code >= 0x20000 && code <= 0x3ffff) // 扩展 B 及以后
  )
}

/** 估算一段文本的 token。空串为 0 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  // for...of 按码点迭代，代理对算一个字符（否则 emoji 会被算成两个）
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (isCjk(code)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

/** 一轮对话在预算里的投影：正文 + 图片引用 + 工具调用 */
export interface ChatTurn {
  /** 来源消息 id：摘要要记「覆盖到哪一条」，没有它就无从定位 */
  messageId: string
  role: 'user' | 'assistant'
  /** 正文（附件抽取的文字已拼进来） */
  text: string
  /** 图片附件（按顺序），用于估算与后续组装 content 数组 */
  images: { fileId: string; mime: string }[]
  /**
   * assistant 发起的工具调用。带它的这一轮在请求体里会展开成
   * 「assistant(tool_calls) + 若干 tool 消息」，所以结果也挂在这里，
   * 成对进出——单独丢一半会让请求体不合法。
   */
  toolCalls?: ChatTurnToolCall[]
  /** 与 toolCalls 一一对应的执行结果（顺序即请求体里的顺序） */
  toolResults?: ChatTurnToolResult[]
}

export interface ChatTurnToolCall {
  /** 模型给的调用 id：结果靠它配对，不能重排 */
  id: string
  /** 下发给模型（也已由模型回传）的函数名 */
  apiName: string
  /** 参数原文 JSON */
  args: string
}

export interface ChatTurnToolResult {
  callId: string
  text: string
}

export interface FitResult {
  kept: ChatTurn[]
  /** 被丢弃的条数，调用方据此决定要不要触发摘要 */
  dropped: number
  /** 保留区在入参数组里的起始下标（摘要要压的是它之前的部分） */
  start: number
  /** 裁剪后的总 token（含固定开销） */
  tokens: number
  /** 最后一条是否被截断（界面提示"内容过长，已截断"） */
  truncated: boolean
}

export interface FitOptions {
  /** 上下文窗口总 token */
  contextWindow: number
  /** 给输出预留的 token */
  maxOutputTokens: number
  /** 已被 system / summary 占掉的 token */
  fixedTokens?: number
}

/** 单条消息占多少 token */
function turnTokens(turn: ChatTurn): number {
  let extra = 0
  // 工具调用与结果同样占上下文：不算进来的话，多轮工具链会在服务端超窗
  for (const call of turn.toolCalls ?? []) extra += estimateTokens(call.args) + 12
  for (const result of turn.toolResults ?? []) extra += estimateTokens(result.text) + MESSAGE_OVERHEAD
  return estimateTokens(turn.text) + turn.images.length * IMAGE_TOKENS + extra + MESSAGE_OVERHEAD
}

/** 从开头取到预算用完为止 */
function takePrefix(text: string, budgetTokens: number): string {
  let out = ''
  let used = 0
  for (const ch of text) {
    const cost = isCjk(ch.codePointAt(0) ?? 0) ? 1 : 0.25
    if (used + cost > budgetTokens) break
    used += cost
    out += ch
  }
  return out
}

/** 从末尾取到预算用完为止 */
function takeSuffix(text: string, budgetTokens: number): string {
  const chars = Array.from(text)
  let out = ''
  let used = 0
  for (let i = chars.length - 1; i >= 0; i--) {
    const cost = isCjk(chars[i].codePointAt(0) ?? 0) ? 1 : 0.25
    if (used + cost > budgetTokens) break
    used += cost
    out = chars[i] + out
  }
  return out
}

/**
 * 从中间截断，保留头尾。
 *
 * 只留开头会让模型看不到结论，只留结尾会看不到用户的要求，
 * 所以两头都留、中间给一句明确的省略标记——模型知道这里被截过，
 * 会倾向于说"信息不全"，而不是拿半截内容硬答。
 */
export function truncateMiddle(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (maxTokens <= 0) return { text: '', truncated: Boolean(text) }
  if (estimateTokens(text) <= maxTokens) return { text, truncated: false }

  const headRatio = 0.6
  // 省略标记自己也要占地方：不预留的话，裁剪结果会稳定超出预算一小截
  const reserve = estimateTokens('\n\n…（中间省略 00000 字）…\n\n') + MESSAGE_OVERHEAD
  // 下限只保证「还能放下几个字」，不能再高：预算本来就很小的时候，
  // 强行留 64 会让裁剪结果比预算还大，反而把整条请求顶爆
  const budget = Math.max(8, Math.floor(maxTokens - reserve))
  const head = takePrefix(text, budget * headRatio)
  const tail = takeSuffix(text, budget * (1 - headRatio))
  const omitted = Math.max(0, [...text].length - [...head].length - [...tail].length)
  return {
    text: `${head}\n\n…（中间省略 ${omitted} 字）…\n\n${tail}`,
    truncated: true
  }
}

/**
 * 按预算从新到旧保留历史。
 *
 * 三条硬规则：
 * 1. 最后一条一定保留（用户刚说的话不能丢），超了就截断它；
 * 2. 裁剪后不能以 assistant 开头（部分服务端会 400）；
 * 3. 一条都放不下时，也要给最后一条留出 MIN_LAST_MESSAGE_TOKENS。
 */
export function fitTurns(turns: ChatTurn[], options: FitOptions): FitResult {
  const contextWindow = Math.max(1024, Math.floor(options.contextWindow || 0))
  const maxOutput = Math.max(0, Math.floor(options.maxOutputTokens || 0))
  const fixed = Math.max(0, Math.floor(options.fixedTokens || 0))
  const available = Math.max(MIN_LAST_MESSAGE_TOKENS, contextWindow - maxOutput - fixed)

  if (!turns.length) return { kept: [], dropped: 0, start: 0, tokens: fixed, truncated: false }

  // 从末尾往前装，直到装不下
  let used = 0
  let start = turns.length
  for (let i = turns.length - 1; i >= 0; i--) {
    const cost = turnTokens(turns[i])
    const isLast = i === turns.length - 1
    if (used + cost <= available) {
      used += cost
      start = i
      continue
    }
    if (isLast) {
      // 最后一条单独就超预算：截断它，仍是 start = i
      start = i
      used += cost
    }
    break
  }

  const kept = turns.slice(start).map((t) => ({
    ...t,
    // 工具字段要深拷一层：下面可能为了塞进预算而截断结果文本，
    // 浅拷会改到入参（摘要还要用原始 turns）
    ...(t.toolCalls ? { toolCalls: t.toolCalls.map((c) => ({ ...c })) } : {}),
    ...(t.toolResults ? { toolResults: t.toolResults.map((r) => ({ ...r })) } : {})
  }))
  let truncated = false

  // 最后一条超预算 → 截断正文（图片数不变，所以先扣掉图片占的）
  const last = kept[kept.length - 1]
  if (last) {
    const imageCost = last.images.length * IMAGE_TOKENS
    const room = Math.max(MIN_LAST_MESSAGE_TOKENS, available - imageCost - MESSAGE_OVERHEAD)
    if (estimateTokens(last.text) > room) {
      const cut = truncateMiddle(last.text, room)
      last.text = cut.text
      truncated = cut.truncated
    }
    // 工具结果同样可能顶爆（一次调用返回几万字），按条均分剩余预算截断
    const results = last.toolResults
    if (results?.length) {
      const left = Math.max(0, available - estimateTokens(last.text) - imageCost)
      const perResult = Math.max(120, Math.floor(left / results.length) - MESSAGE_OVERHEAD)
      for (const result of results) {
        if (estimateTokens(result.text) <= perResult) continue
        result.text = truncateMiddle(result.text, perResult).text
        truncated = true
      }
    }
  }

  // 不能以 assistant 开头：丢掉队首的 assistant（它缺少对应的提问）
  let head = start
  while (kept.length > 1 && kept[0].role === 'assistant') {
    kept.shift()
    head += 1
  }

  const tokens = fixed + kept.reduce((sum, t) => sum + turnTokens(t), 0)
  return {
    kept,
    dropped: turns.length - kept.length,
    start: head,
    tokens,
    truncated
  }
}

/**
 * 给界面用的用量百分比。
 * 只反映"这次请求大概占了多少窗口"，不追求精确——它存在的意义是
 * 在用户贴完一个 2MB 日志时，能立刻看出这次请求已经很危险。
 */
export function budgetPercent(used: number, contextWindow: number): number {
  if (!contextWindow || contextWindow <= 0) return 0
  return Math.min(999, Math.round((used / contextWindow) * 100))
}
