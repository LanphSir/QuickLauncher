import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 插件目录监听的"监听谁"部分：只读目录、不碰 electron，单测直接跑这里。
 * 真正的 watch / 防抖 / 重挂在 watcher.ts。
 */

export interface WatchTarget {
  dir: string
  /**
   * 只关心这些文件名。缺省 = 任何变化都算。
   * 根目录用缺省：新建/删除插件目录就是靠它。
   */
  match?: RegExp
}

/** 插件目录里除了 manifest，还要关心 dist 什么时候冒出来（构建完成的那一刻） */
const PLUGIN_DIR = /^(plugin\.json|dist)$/i
const MANIFEST_ONLY = /^plugin\.json$/i

/**
 * 算出需要监听的目录。
 * 插件目录即使还没有 plugin.json 也要监听——先建目录、构建完才有 manifest 是常见顺序，
 * 只盯 manifest 会漏掉"目录已就位、正在构建"的中间态。
 */
export function planPluginWatches(rootDirs: readonly string[]): WatchTarget[] {
  const targets: WatchTarget[] = []
  for (const root of rootDirs) {
    if (!existsSync(root)) continue
    targets.push({ dir: root })
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const base = join(root, entry.name)
      targets.push({ dir: base, match: PLUGIN_DIR })
      const dist = join(base, 'dist')
      if (existsSync(dist)) targets.push({ dir: dist, match: MANIFEST_ONLY })
    }
  }
  return targets
}
