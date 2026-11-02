/**
 * 会话持久化：一个会话一个文件 + 一份 index.json 供列表。
 *
 * 为什么不像旧版 store.json 那样一个大文件：会话是"越用越大、一次只改一条"的数据，
 * 每次全量重写既慢又随时可能写坏别人正在聊的那条。分文件 + tmp/rename 原子写，
 * 代价是列表要多读一份索引——索引丢了还能扫描目录重建，数据本身不丢。
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  MAX_SESSION_MESSAGES,
  type AiChatMessage,
  type AiSessionDetail,
  type AiSessionMeta
} from '../../shared/ai'
import { sortSessions, trimMessages } from './sessionModel'
import { getAiConfig } from './settings'

interface SessionFile {
  version: 1
  meta: AiSessionMeta
  messages: AiChatMessage[]
}

interface IndexFile {
  version: 1
  sessions: AiSessionMeta[]
}

function sessionsDir(): string {
  return join(app.getPath('userData'), 'ai', 'sessions')
}

function sessionFile(id: string): string {
  return join(sessionsDir(), `${id}.json`)
}

function indexPath(): string {
  return join(sessionsDir(), 'index.json')
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(sessionsDir(), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, text, 'utf-8')
  renameSync(tmp, file)
}

function isMeta(value: unknown): value is AiSessionMeta {
  if (!value || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  return typeof m.id === 'string' && typeof m.title === 'string' && typeof m.updatedAt === 'number'
}

/** 索引损坏/缺失时按目录重建：宁可多读几次文件，也不要"会话还在但列表空了" */
function rebuildIndex(): AiSessionMeta[] {
  const dir = sessionsDir()
  if (!existsSync(dir)) return []
  const metas: AiSessionMeta[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name === 'index.json') continue
    const detail = readSessionFile(name.slice(0, -'.json'.length))
    if (detail) metas.push(detail)
  }
  return sortSessions(metas)
}

function readIndex(): AiSessionMeta[] {
  try {
    if (!existsSync(indexPath())) return rebuildIndex()
    const raw = JSON.parse(readFileSync(indexPath(), 'utf-8')) as Partial<IndexFile>
    const list = Array.isArray(raw.sessions) ? raw.sessions.filter(isMeta) : []
    return sortSessions(list)
  } catch (err) {
    console.warn('[ai] 会话索引损坏，按目录重建', err)
    return rebuildIndex()
  }
}

function writeIndex(metas: AiSessionMeta[]): void {
  writeAtomic(indexPath(), JSON.stringify({ version: 1, sessions: sortSessions(metas) } satisfies IndexFile))
}

function readSessionFile(id: string): AiSessionDetail | null {
  const file = sessionFile(id)
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<SessionFile>
    const messages = Array.isArray(raw.messages) ? raw.messages.filter(isMessage) : []
    const meta = isMeta(raw.meta)
      ? raw.meta
      : { id, title: '新会话', createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }
    return { ...meta, id, messageCount: messages.length, messages }
  } catch (err) {
    console.error(`[ai] 会话读取失败 ${id}`, err)
    return null
  }
}

function isMessage(value: unknown): value is AiChatMessage {
  if (!value || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  return typeof m.id === 'string' && typeof m.role === 'string' && Array.isArray(m.parts)
}

function upsertIndex(meta: AiSessionMeta): void {
  const list = readIndex().filter((m) => m.id !== meta.id)
  list.push(meta)
  writeIndex(list)
}

export function listSessions(): AiSessionMeta[] {
  return readIndex()
}

export function getSession(id: string): AiSessionDetail | null {
  return readSessionFile(String(id ?? ''))
}

export function createSession(model?: string): AiSessionDetail {
  const now = Date.now()
  const meta: AiSessionMeta = {
    id: randomUUID(),
    title: '新会话',
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    model
  }
  writeAtomic(sessionFile(meta.id), JSON.stringify({ version: 1, meta, messages: [] } satisfies SessionFile))
  upsertIndex(meta)
  pruneSessions()
  return { ...meta, messages: [] }
}

/** 保存整条会话：顺便裁剪超长历史、刷新 meta 的时间与条数 */
export function saveSession(detail: AiSessionDetail): AiSessionDetail {
  const messages = trimMessages(detail.messages, MAX_SESSION_MESSAGES)
  const meta: AiSessionMeta = {
    id: detail.id,
    title: detail.title.slice(0, 60) || '新会话',
    createdAt: detail.createdAt,
    updatedAt: Date.now(),
    messageCount: messages.length,
    model: detail.model
  }
  writeAtomic(sessionFile(meta.id), JSON.stringify({ version: 1, meta, messages } satisfies SessionFile))
  upsertIndex(meta)
  return { ...meta, messages }
}

export function renameSession(id: string, title: string): boolean {
  const detail = readSessionFile(id)
  if (!detail) return false
  const next = title.trim()
  if (!next) return false
  saveSession({ ...detail, title: next })
  return true
}

export function deleteSession(id: string): boolean {
  const file = sessionFile(String(id ?? ''))
  if (!existsSync(file)) return false
  try {
    rmSync(file, { force: true })
  } catch (err) {
    console.error('[ai] 删除会话失败', err)
    return false
  }
  writeIndex(readIndex().filter((m) => m.id !== id))
  return true
}

/** 超过 maxSessions 时删最旧的（连同文件），避免无限增长 */
export function pruneSessions(): void {
  const max = getAiConfig().maxSessions
  const list = readIndex()
  if (list.length <= max) return
  const drop = list.slice(max)
  for (const meta of drop) {
    try {
      rmSync(sessionFile(meta.id), { force: true })
    } catch {
      // 删不掉不影响读取，下轮再试
    }
  }
  writeIndex(list.slice(0, max))
}
