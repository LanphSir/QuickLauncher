/**
 * 插件关键词匹配：规则统一放在 src/shared/search.ts（主进程检索搜索条目用同一份，
 * 避免面板与主进程判断不一致）。这里只保留「整个插件命中」的组合逻辑。
 */
import { keywordMatch } from '../../../shared/search'

export { keywordMatch }

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
