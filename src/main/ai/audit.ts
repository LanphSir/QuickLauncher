/**
 * 工具调用审计（v0.6.3）：`userData/ai/audit.jsonl`，一行一次调用。
 *
 * 为什么要落盘而不是只写 console：工具能读剪贴板、能改用户的文档、能拉起程序。
 * 出问题时用户问的不会是「日志里写了什么」，而是「它到底动过我什么」——
 * 这个文件就是那个答案。console 会随窗口关掉消失，落盘不会。
 *
 * 三条自我约束：
 * - **只追加**，不重写：审计被改写就失去了价值；
 * - 参数**截断**保存：剪贴板内容、文档正文都可能很敏感，留一段够定位即可；
 * - 大小上限**轮转**：单个文件 2MB，超出改成 audit.1.jsonl 重新开始，
 *   不引入清理策略（审计文件被自动删掉比占 2MB 更糟）。
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { MAX_TOOL_ARGS_CHARS } from '../../shared/ai'

export interface AuditEntry {
  sessionId: string
  messageId: string
  /** 全局工具名 */
  tool: string
  source: 'builtin' | 'plugin' | 'mcp'
  pluginId?: string
  risk: string
  /** 参数原文（已截断） */
  args: string
  ok: boolean
  /** 用户是否被问过、以及怎么答的：allowed / denied / timeout / not-required */
  confirm?: 'allowed' | 'denied' | 'timeout' | 'not-required'
  durationMs: number
  error?: string
}

const MAX_BYTES = 2 * 1024 * 1024

function auditDir(): string {
  return join(app.getPath('userData'), 'ai')
}

export function auditPath(): string {
  return join(auditDir(), 'audit.jsonl')
}

function rotateIfNeeded(file: string): void {
  try {
    if (!existsSync(file)) return
    if (statSync(file).size < MAX_BYTES) return
    renameSync(file, join(auditDir(), 'audit.1.jsonl'))
  } catch (err) {
    // 轮转失败不该影响调用本身：继续往原文件追加就是了
    console.warn('[ai] 审计日志轮转失败', err)
  }
}

export function writeAudit(entry: AuditEntry): void {
  const dir = auditDir()
  try {
    mkdirSync(dir, { recursive: true })
    const file = auditPath()
    rotateIfNeeded(file)
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
      args: entry.args.length > MAX_TOOL_ARGS_CHARS ? `${entry.args.slice(0, MAX_TOOL_ARGS_CHARS)}…` : entry.args
    })
    appendFileSync(file, `${line}\n`, 'utf-8')
  } catch (err) {
    // 审计写不进去不能阻断用户正在做的事，但必须留下痕迹
    console.error('[ai] 审计写入失败', err)
  }
}
