import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { entryMatch, normalizeEntries, type SearchEntry, type SearchHit } from '../../shared/search'
import type { PluginRecord } from '../plugin/manager'

/**
 * 搜索条目索引。
 *
 * 三个来源，优先级从高到低：
 * 1. 运行时：插件通过 `appapi.search.set()` 推送（能反映停用、用户改过的关键词）；
 * 2. 落盘：运行时条目同时写进 userData/search/<pluginId>.json，重启后仍可搜；
 * 3. 静态：插件目录下的 search-index.json（构建期生成），覆盖「插件还没被打开过」
 *    的冷启动场景——否则装完不打开就搜不到，等于白装。
 *
 * 索引在主进程内存里，面板每次输入走一次 IPC 查询；条目量级（每插件数十到数百条）
 * 下线性匹配远比引入检索引擎划算。
 */

const runtime = new Map<string, SearchEntry[]>()
const staticCache = new Map<string, { mtimeMs: number; entries: SearchEntry[] }>()

const MAX_HITS = 8
const MAX_PER_PLUGIN = 4

function indexDir(): string {
  return join(app.getPath('userData'), 'search')
}

function indexFile(pluginId: string): string {
  // 插件 id 来自 manifest 校验（反向域名 + 白名单字符），这里再挡一次路径穿越
  const safe = pluginId.replace(/[^\w.-]+/g, '_')
  return join(indexDir(), `${safe}.json`)
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

/** 启动时恢复落盘索引（插件没打开也能搜到上次的内容） */
export function loadSearchIndexes(): void {
  const dir = indexDir()
  if (!existsSync(dir)) return
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    const id = file.slice(0, -'.json'.length)
    const entries = normalizeEntries(readJson(join(dir, file)))
    if (entries.length) runtime.set(id, entries)
  }
}

/** 插件推送全量条目：覆盖式，空数组等同清空（但保留静态索引作为兜底） */
export function setSearchEntries(pluginId: string, input: unknown): number {
  const entries = normalizeEntries(input)
  if (!entries.length) {
    runtime.delete(pluginId)
    removeIndexFile(pluginId)
    return 0
  }
  runtime.set(pluginId, entries)
  try {
    mkdirSync(indexDir(), { recursive: true })
    writeFileSync(indexFile(pluginId), JSON.stringify(entries, null, 2), 'utf-8')
  } catch (err) {
    // 落盘失败不影响本次会话可用性，只是重启后要等插件重新推送
    console.warn('[search] 索引写入失败:', (err as Error).message)
  }
  return entries.length
}

export function clearSearchEntries(pluginId: string): boolean {
  runtime.delete(pluginId)
  removeIndexFile(pluginId)
  staticCache.delete(pluginId)
  return true
}

function removeIndexFile(pluginId: string): void {
  try {
    rmSync(indexFile(pluginId), { force: true })
  } catch {
    /* 忽略：文件不存在或占用 */
  }
}

/** 插件目录下的构建期静态索引（可选文件，缺失即无） */
function staticEntries(rec: PluginRecord): SearchEntry[] {
  const file = join(rec.dir, 'search-index.json')
  let mtimeMs = 0
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    staticCache.delete(rec.manifest.id)
    return []
  }
  const cached = staticCache.get(rec.manifest.id)
  if (cached && cached.mtimeMs === mtimeMs) return cached.entries
  const entries = normalizeEntries(readJson(file))
  staticCache.set(rec.manifest.id, { mtimeMs, entries })
  return entries
}

function entriesFor(rec: PluginRecord): SearchEntry[] {
  const live = runtime.get(rec.manifest.id)
  // 运行时条目代表插件当前的真实状态（含用户改动），有就完全取代静态索引
  return live ?? staticEntries(rec)
}

/** 面板搜索：返回跨插件的命中条目（只看已启用的 web 插件） */
export function querySearch(query: string, plugins: PluginRecord[], limit = MAX_HITS): SearchHit[] {
  const q = query.trim()
  if (!q) return []
  const hits: SearchHit[] = []
  // 单插件最多占几条：手册类插件一个查询能命中几十章，不设限会把别的插件挤没
  const perPlugin = new Map<string, number>()
  for (const rec of plugins) {
    if (rec.disabled || rec.manifest.type !== 'web') continue
    for (const entry of entriesFor(rec)) {
      if (!entryMatch(q, entry)) continue
      const used = perPlugin.get(rec.manifest.id) ?? 0
      if (used >= MAX_PER_PLUGIN) break
      perPlugin.set(rec.manifest.id, used + 1)
      hits.push({
        ...entry,
        pluginId: rec.manifest.id,
        pluginName: entry.group ?? rec.manifest.name,
        icon: rec.iconDataUrl
      })
    }
  }
  hits.sort((a, b) => (a.weight ?? 100) - (b.weight ?? 100) || a.title.length - b.title.length)
  return hits.slice(0, limit)
}
