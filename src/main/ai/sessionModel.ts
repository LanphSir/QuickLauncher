/**
 * 会话数据的纯函数部分：造消息、取标题、转请求体、裁剪条数。
 *
 * 抽出来是为了能单测——这些规则一错就是"历史丢了一半"或"上下文串到别的会话"，
 * 靠手点是发现不了的。
 */
import { randomUUID } from 'node:crypto'
import type { AiChatMessage, AiFilePart, AiMessagePart } from '../../shared/ai'
import type { ApiMessage } from './provider'
import type { ChatTurn } from './tokens'

export function newMessageId(): string {
  return randomUUID()
}

export function createMessage(
  role: AiChatMessage['role'],
  parts: AiMessagePart[],
  extra: Partial<Pick<AiChatMessage, 'model' | 'stopped' | 'error'>> = {}
): AiChatMessage {
  return { id: newMessageId(), role, parts, createdAt: Date.now(), ...extra }
}

export function textOf(message: AiChatMessage): string {
  return message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
}

export function reasoningOf(message: AiChatMessage): string {
  return message.parts.map((p) => (p.type === 'reasoning' ? p.text : '')).join('')
}

export function isEmptyAnswer(message: AiChatMessage): boolean {
  return message.role === 'assistant' && !textOf(message).trim() && !message.error
}

/** 取出一条消息里的附件 */
export function filesOf(message: AiChatMessage): AiFilePart[] {
  return message.parts.filter((p): p is AiFilePart => p.type === 'file')
}

/** 纯图片消息没有正文，给一句占位——content 为空数组时部分服务端直接 400 */
const IMAGE_ONLY_PLACEHOLDER = '（见下图）'

/**
 * 把历史消息转成「一轮对话」。
 *
 * 附件文字拼在正文之后，用【附件：名】隔开：模型能看出哪段是用户写的、
 * 哪段是文件里的，回答时不会把日志内容当成用户的诉求。
 * 抽取失败的附件整条跳过——它的 error 已经在界面上告诉用户了，
 * 把半截内容偷偷送进去反而更糟。
 */
export function turnsOf(messages: AiChatMessage[]): ChatTurn[] {
  const out: ChatTurn[] = []
  for (const message of messages) {
    if (message.role === 'system') continue
    const files = filesOf(message).filter((f) => !f.error)
    const images = files.filter((f) => f.kind === 'image' && f.fileId)
    const blocks = files
      .filter((f) => f.kind === 'text' && f.text)
      .map((f) => `【附件：${f.name}】\n${f.text}`)

    const body = textOf(message).trim()
    let text = [body, ...blocks].filter(Boolean).join('\n\n')
    if (!text && images.length) text = IMAGE_ONLY_PLACEHOLDER
    if (!text && !images.length) continue

    out.push({
      messageId: message.id,
      role: message.role === 'assistant' ? 'assistant' : 'user',
      text,
      images: images.map((f) => ({ fileId: f.fileId as string, mime: f.mime }))
    })
  }
  return out
}

/**
 * 纯文本版：把轮次转成请求体。
 * 带图的消息由调用方替换成 content 数组，这里只处理文字部分。
 */
export function turnsToApiMessages(turns: ChatTurn[], system?: string): ApiMessage[] {
  const out: ApiMessage[] = []
  const sys = system?.trim()
  if (sys) out.push({ role: 'system', content: sys })
  for (const turn of turns) {
    if (!turn.text.trim()) continue
    out.push({ role: turn.role, content: turn.text })
  }
  return out
}

/**
 * 会话标题：取第一行前 24 个字。
 * 不用模型生成标题——那要多一次请求和一份钱，首条消息已经够辨认了。
 */
export function titleFromText(text: string, max = 24): string {
  const firstLine = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!firstLine) return '新会话'
  const clean = firstLine.replace(/\s+/g, ' ')
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

/** 只留最近 max 条（含用户与回答），返回新数组，不动入参 */
export function trimMessages(messages: AiChatMessage[], max: number): AiChatMessage[] {
  if (messages.length <= max) return messages
  return messages.slice(messages.length - max)
}

/** 会话列表按更新时间倒序；同刻按 id 兜底保证顺序稳定 */
export function sortSessions<T extends { updatedAt: number; id: string }>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id))
}
