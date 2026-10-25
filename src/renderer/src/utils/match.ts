/**
 * 插件关键词匹配：
 * - 普通字符串：query 包含 keyword（不区分大小写）
 * - 通配符：含 * / ? 的 keyword 与整个 query 匹配（* 任意串、? 单字符，不区分大小写）
 * - 正则：`re:` 前缀，其余部分作为正则对整个 query 做 test（如 re:^[a-zA-Z]+$ 命中纯英文输入）
 * 注意：正则由插件作者提供，表达式非法时静默跳过；查询词很短，回溯风险有限。
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

export interface MatchablePlugin {
  name: string
  id: string
  keywords: string[]
}

export function pluginMatch(query: string, plugin: MatchablePlugin): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return false
  if (plugin.name.toLowerCase().includes(q) || plugin.id.toLowerCase().includes(q)) return true
  return plugin.keywords.some((k) => keywordMatch(q, k))
}
