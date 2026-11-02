/**
 * 滚动摘要：把装不进上下文的那段历史压成一段事实陈述。
 *
 * 为什么不是"每次超预算就重新总结全部历史"：那样每轮都在为一个几乎不变的前缀
 * 重复付费。这里的做法是**只压这次真正被丢掉的部分**，并把上一轮摘要一起喂进去
 * 合并——旧摘要是这一轮摘要的输入，像滚雪球一样往前推。
 *
 * 摘要失败不影响对话本身：调用方拿到空串就当没这回事，下轮再试。
 */
import { SUMMARY_MAX_CHARS, SUMMARY_TRIGGER_MESSAGES } from '../../shared/ai'
import type { AiProviderConfig } from '../../shared/ai'
import { completeChat } from './client'
import { buildChatRequest } from './provider'
import { estimateTokens, fitTurns, type ChatTurn } from './tokens'

const SUMMARY_SYSTEM_PROMPT =
  '你在为一个桌面启动器的 AI 助手整理对话记忆。把给定对话压缩成一段事实摘要，供后续对话继续使用。\n' +
  '只写事实：用户的目标、已经确认的结论、还没回答的疑问、出现过的关键细节（文件路径、数字、名字、代码要点）。\n' +
  '不要写「用户提出了一个问题」这类空话，不要评论对话质量，不要分点编号，直接写成一段连贯的陈述。\n' +
  `不超过 ${SUMMARY_MAX_CHARS} 个汉字。`

/** 摘要的输入本身也要受预算约束：被丢掉的历史可能比整个窗口还大 */
const SUMMARY_MAX_OUTPUT = 900

export interface SummarizeInput {
  provider: AiProviderConfig
  model: string
  apiKey: string | null
  /** 上一轮摘要，会和这次的对话一起重写 */
  previous?: string
  /** 这次真正被丢弃的对话 */
  turns: ChatTurn[]
  contextWindow: number
}

/**
 * 算出这次该压哪一段，不该压就返回 null。
 *
 * 三种「不该压」：
 * - 这次根本没丢到阈值（丢一两条不值一次请求）；
 * - 上次摘要的终点已经覆盖到保留区边界（没新东西可压）；
 * - 摘要终点指向的消息已经不在了（历史被裁剪过），此时旧摘要不可信，宁可从零重来。
 */
export function summarizeRange(
  turns: ChatTurn[],
  keptStart: number,
  summaryUpTo?: string
): ChatTurn[] | null {
  if (keptStart < SUMMARY_TRIGGER_MESSAGES) return null

  let from = 0
  if (summaryUpTo) {
    const index = turns.findIndex((t) => t.messageId === summaryUpTo)
    // 找不到说明那条消息已被裁掉：摘要覆盖范围无法定位，跳过本次
    if (index < 0) return null
    from = index + 1
  }
  if (from >= keptStart) return null

  const slice = turns.slice(from, keptStart)
  return slice.length >= SUMMARY_TRIGGER_MESSAGES ? slice : null
}

function renderTurns(turns: ChatTurn[]): string {  return turns
    .map((t) => {
      const who = t.role === 'user' ? '用户' : '助手'
      const images = t.images.length ? `（附了 ${t.images.length} 张图片）` : ''
      return `${who}：${t.text}${images}`
    })
    .join('\n\n')
}

/**
 * 生成一段新的摘要。拿不到有效结果时返回空串（调用方视作"本次不更新摘要"）。
 */
export async function summarizeHistory(input: SummarizeInput): Promise<string> {
  if (!input.turns.length) return ''

  const previous = input.previous?.trim() ?? ''
  const fixedTokens = estimateTokens(SUMMARY_SYSTEM_PROMPT) + estimateTokens(previous) + 16

  // 被丢掉的历史也可能超窗口（用户连贴三份大日志），先按预算裁一次再喂给摘要模型
  const fitted = fitTurns(input.turns, {
    contextWindow: input.contextWindow,
    maxOutputTokens: SUMMARY_MAX_OUTPUT,
    fixedTokens
  })

  const body = renderTurns(fitted.kept)
  if (!body.trim()) return ''

  const userContent = previous
    ? `【已有摘要】\n${previous}\n\n【新的对话】\n${body}`
    : `【对话】\n${body}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const req = buildChatRequest(
      input.provider,
      input.model,
      input.apiKey,
      [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ],
      { stream: false, maxTokens: SUMMARY_MAX_OUTPUT }
    )
    const text = (await completeChat(req, controller.signal)).trim()
    if (!text) return ''
    return text.length > SUMMARY_MAX_CHARS * 1.5 ? text.slice(0, Math.floor(SUMMARY_MAX_CHARS * 1.5)) : text
  } catch (err) {
    // 摘要只是优化，失败就静默——绝不能因为summary出错让对话卡住
    console.warn('[ai] 生成摘要失败', err instanceof Error ? err.message : err)
    return ''
  } finally {
    clearTimeout(timer)
  }
}
