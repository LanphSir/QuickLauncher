/**
 * 会话数据的纯函数部分：造消息、取标题、转请求体、裁剪条数。
 *
 * 抽出来是为了能单测——这些规则一错就是"历史丢了一半"或"上下文串到别的会话"，
 * 靠手点是发现不了的。
 */
import { randomUUID } from 'node:crypto'
import type { AiChatMessage, AiMessagePart } from '../../shared/ai'
import type { ApiMessage } from './provider'

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

/**
 * 转成请求体里的 messages。
 * 只取正文：reasoning 是模型的内部草稿，回灌会污染上下文且更贵；
 * 空回答（失败或纯推理没出文）也跳过，否则部分服务端会 400。
 */
export function toApiMessages(messages: AiChatMessage[], system?: string): ApiMessage[] {
  const out: ApiMessage[] = []
  const sys = system?.trim()
  if (sys) out.push({ role: 'system', content: sys })
  for (const message of messages) {
    if (message.role === 'system') continue
    const content = textOf(message).trim()
    if (!content) continue
    out.push({ role: message.role, content })
  }
  return out
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
