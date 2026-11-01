/**
 * 插件视图的 LRU 淘汰策略。
 *
 * 单独抽成纯函数的原因：这段逻辑一旦出错，表现是"插件莫名其妙白屏重载"或
 * "内存越用越多"，两种都很难在 UI 上复现。放在这里可以逐条断言，
 * pluginHost 只负责按结果去关进程。
 */

export interface LruCandidate {
  /** 从最久未用到最近使用的顺序 */
  id: string
  /** 受保护（当前可见 / 分离窗口 / 内联插件）：无论如何不淘汰 */
  protect: boolean
}

/**
 * 返回应当淘汰的 id（按淘汰先后排列）。
 * 只淘汰到剩余数量 ≤ limit 为止；保护条目全占满时宁可超限也不动它们。
 */
export function pickEvictions(order: readonly LruCandidate[], limit: number): string[] {
  if (!Number.isFinite(limit)) return []
  let live = order.length
  const victims: string[] = []
  for (const candidate of order) {
    if (live <= limit) break
    if (candidate.protect) continue
    victims.push(candidate.id)
    live--
  }
  return victims
}
