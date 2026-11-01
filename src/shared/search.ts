/**
 * 搜索贡献协议：插件把「可被主面板搜到的条目」注册给启动器。
 *
 * 为什么要这层：面板搜索原本只认插件 manifest 的关键词，粒度是「整个插件」。
 * 插件内部的真实内容（某本手册、某个章节、某条笔记）搜不到，用户只能先记住
 * 插件名再进去找。条目化之后，插件一次注册、面板统一检索，回车直达目标。
 *
 * 约束：
 * - 单插件条目上限 MAX_ENTRIES，文本字段统一截断，避免插件把索引撑爆；
 * - intent 是纯数据（IPC / JSON 持久化都要过），超长直接丢弃；
 * - 匹配逻辑放共享层，主进程与渲染层用同一份规则，避免两边判断不一致。
 */

export interface SearchEntry {
  /** 插件内唯一 id（同一插件下去重） */
  id: string
  /** 主标题：搜索结果第一行 */
  title: string
  /** 副标题：来源/章节数等补充信息 */
  subtitle?: string
  /** 参与匹配的关键词（名称、别名、章节标题、拼音等） */
  keywords?: string[]
  /** 分组名，默认用插件名 */
  group?: string
  /** 排序权重，越小越靠前（默认 100） */
  weight?: number
  /** 打开插件时透传的意图数据（appapi.onQuery 收到的 intent） */
  intent?: Record<string, unknown>
}

/** 主进程补全归属信息后返回给面板的命中项 */
export interface SearchHit extends SearchEntry {
  pluginId: string
  pluginName: string
  icon: string | null
}

const MAX_ENTRIES = 300
const MAX_KEYWORDS = 40
const MAX_TEXT = 120
const MAX_INTENT = 800

/**
 * 关键词匹配：
 * - 普通字符串：query 包含 keyword（不区分大小写）
 * - 通配符：含 * / ? 的 keyword 与整个 query 匹配（* 任意串、? 单字符）
 * - 正则：`re:` 前缀，其余部分作为正则对整个 query 做 test
 * 正则由插件作者提供，非法表达式静默跳过；查询词很短，回溯风险有限。
 */
export function keywordMatch(query: string, keyword: string): boolean {
  const q = query.trim()
  if (!q || !keyword) return false
  if (keyword.startsWith('re:')) {
    try {
      return new RegExp(keyword.slice(3), 'i').test(q)
    } catch {
      return false
    }
  }
  if (/[*?]/.test(keyword)) {
    const escaped = keyword
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[\\s\\S]*')
      .replace(/\?/g, '[\\s\\S]')
    try {
      return new RegExp(`^${escaped}$`, 'i').test(q)
    } catch {
      return false
    }
  }
  return q.toLowerCase().includes(keyword.toLowerCase())
}

/**
 * 条目命中：标题子串，或任一关键词按 keywordMatch 规则命中。
 * 副标题（来源、章节数）只用于展示，不参与匹配——否则「Linux 命令手册」的每个
 * 章节都会因为副标题带 linux 而命中，搜一次刷出几十条噪音。
 */
export function entryMatch(query: string, entry: SearchEntry): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return false
  if (entry.title.toLowerCase().includes(q)) return true
  return (entry.keywords ?? []).some((k) => keywordMatch(q, k))
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const s = value.trim().replace(/\s+/g, ' ')
  if (!s) return undefined
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s
}

/** 校验并裁剪插件提交的条目（插件是外部输入，不能直接信任） */
export function normalizeEntries(input: unknown): SearchEntry[] {
  if (!Array.isArray(input)) return []
  const out: SearchEntry[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (out.length >= MAX_ENTRIES) break
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const title = text(r.title)
    if (!title) continue
    const id = text(r.id) ?? title
    if (seen.has(id)) continue
    seen.add(id)

    const keywords = Array.isArray(r.keywords)
      ? r.keywords
          .map((k) => text(k))
          .filter((k): k is string => Boolean(k))
          .slice(0, MAX_KEYWORDS)
      : []

    const entry: SearchEntry = { id, title }
    const subtitle = text(r.subtitle)
    if (subtitle) entry.subtitle = subtitle
    const group = text(r.group)
    if (group) entry.group = group
    if (keywords.length) entry.keywords = keywords
    if (Number.isFinite(r.weight)) entry.weight = Number(r.weight)

    if (r.intent && typeof r.intent === 'object' && !Array.isArray(r.intent)) {
      const intent = r.intent as Record<string, unknown>
      let serialized = ''
      try {
        serialized = JSON.stringify(intent)
      } catch {
        serialized = ''
      }
      if (serialized && serialized.length <= MAX_INTENT) entry.intent = intent
    }
    out.push(entry)
  }
  return out
}
