/**
 * 内联结果归一化。
 *
 * 插件回的是不可信数据（可能超长、字段类型乱来、一次塞几百条），而这段内容会
 * 直接渲染进面板搜索结果区，所以校验放在共享层：主进程回传前先裁一次，渲染层
 * 拿到的一定是安全形状。
 *
 * 与搜索条目（shared/search.ts）的区别：那边是「插件内容索引」，可以注册上百条
 * 让用户慢慢翻；这边是「输入即得」，只留极少数、必须一眼可用的结果。
 */

import type { InlineAction, InlineItem } from './pluginApi'

/** 单个插件最多贡献几条（再多就把别的东西挤没了） */
export const MAX_INLINE_PER_PLUGIN = 2
/** 面板内联区总共最多几条 */
export const MAX_INLINE_TOTAL = 4

const MAX_ID = 120
const MAX_TITLE = 120
const MAX_SUBTITLE = 160
const MAX_BADGE = 2
const MAX_COPY_BYTES = 64 * 1024

/** 主进程补全归属信息后推给面板的条目 */
export interface InlineHit extends InlineItem {
  pluginId: string
  pluginName: string
  icon: string | null
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const s = value.trim().replace(/\s+/g, ' ')
  if (!s) return undefined
  return s.length > max ? s.slice(0, max) : s
}

/** 节点与渲染层共用的字节数计算（避免在共享层引用 Buffer） */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function normalizeAction(input: unknown): InlineAction | undefined {
  if (!input || typeof input !== 'object') return undefined
  const raw = input as Record<string, unknown>
  if (raw.type === 'copy') {
    if (typeof raw.text !== 'string' || !raw.text) return undefined
    if (byteLength(raw.text) > MAX_COPY_BYTES) return undefined
    return { type: 'copy', text: raw.text }
  }
  if (raw.type === 'open') {
    const intent = raw.intent
    if (intent && typeof intent === 'object' && !Array.isArray(intent)) {
      // 契约要求能过 IPC / JSON，序列化不过关就丢掉 intent 但保留动作本身
      try {
        if (JSON.stringify(intent).length <= 2000) {
          return { type: 'open', intent: intent as Record<string, unknown> }
        }
      } catch {
        /* 循环引用等：退化成无 intent 的 open */
      }
    }
    return { type: 'open' }
  }
  return undefined
}

/** 校验并裁剪单个插件回传的条目（内部使用 Buffer，仅主进程调用） */
export function normalizeInlineItems(input: unknown): InlineItem[] {
  if (!Array.isArray(input)) return []
  const out: InlineItem[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (out.length >= MAX_INLINE_PER_PLUGIN) break
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const title = text(r.title, MAX_TITLE)
    if (!title) continue
    const id = text(r.id, MAX_ID) ?? title
    if (seen.has(id)) continue
    seen.add(id)

    const item: InlineItem = { id, title }
    const subtitle = text(r.subtitle, MAX_SUBTITLE)
    if (subtitle) item.subtitle = subtitle
    const badge = text(r.badge, MAX_BADGE)
    if (badge) item.badge = badge
    const action = normalizeAction(r.action)
    if (action) item.action = action
    out.push(item)
  }
  return out
}
