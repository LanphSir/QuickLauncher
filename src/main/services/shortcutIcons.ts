import { app, net } from 'electron'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { ShortcutEntry } from './shortcutModel'

/**
 * 自定义外部应用的图标解析。
 *
 * 四级回退：用户选的图 → 系统文件图标（`app.getFileIcon`，对 .lnk 也是目标程序的图标）
 * → 网址抓 favicon → 都不行就交给渲染层画"首字母 + 渐变"。
 *
 * 为什么带磁盘缓存：`getFileIcon` 要走一次系统 Shell 解析，十几条应用串起来会让
 * 首屏图标"一个个冒出来"。缓存让第二次启动就同步拿到图标，只在配置变了才重算。
 */

const MAX_CUSTOM_BYTES = 512 * 1024
const MAX_FAVICON_BYTES = 64 * 1024
const FAVICON_TIMEOUT = 2000
const CONCURRENCY = 4

interface CacheItem {
  /** 由 kind/path/command 拼出来的指纹，变了就重算 */
  key: string
  dataUrl: string | null
}

let cache: Record<string, CacheItem> | null = null

function cacheFile(): string {
  return join(app.getPath('userData'), 'shortcut-icons.json')
}

function ensureLoaded(): Record<string, CacheItem> {
  if (cache) return cache
  try {
    const raw = existsSync(cacheFile()) ? JSON.parse(readFileSync(cacheFile(), 'utf-8')) : {}
    cache = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, CacheItem>) : {}
  } catch {
    cache = {}
  }
  return cache
}

function persist(): void {
  try {
    writeFileSync(cacheFile(), JSON.stringify(ensureLoaded()), 'utf-8')
  } catch (err) {
    console.error('[shortcut] 图标缓存写入失败', err)
  }
}

export function iconKey(entry: ShortcutEntry): string {
  return `${entry.icon.kind}|${entry.icon.path ?? ''}|${entry.command}`
}

/** 同步取缓存（启动扫描时用）：没有就返回 null，等异步补齐 */
export function cachedIcon(entry: ShortcutEntry): string | null {
  const hit = ensureLoaded()[entry.id]
  return hit && hit.key === iconKey(entry) ? hit.dataUrl : null
}

/** 删除条目时一并清缓存：否则 icons 缓存会一直留着已删应用的 dataURL */
export function forgetShortcutIcon(id: string): void {
  const store = ensureLoaded()
  if (!store[id]) return
  delete store[id]
  persist()
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
}

function fileDataUrl(file: string, max: number): string | null {
  try {
    if (!existsSync(file)) return null
    if (statSync(file).size > max) return null
    const mime = MIME[extname(file).toLowerCase()]
    if (!mime) return null
    return `data:${mime};base64,${readFileSync(file).toString('base64')}`
  } catch {
    return null
  }
}

/** 网址类应用没有本地文件可提取图标，退而抓站点 favicon（限 2 秒 / 64KB） */
async function faviconFor(command: string): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FAVICON_TIMEOUT)
  try {
    const target = new URL(command)
    const res = await net.fetch(new URL('/favicon.ico', target.origin).toString(), {
      signal: controller.signal
    })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length || buf.length > MAX_FAVICON_BYTES) return null
    const header = res.headers.get('content-type') ?? ''
    const mime = header.startsWith('image/') ? header.split(';')[0] : 'image/x-icon'
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function resolveIcon(entry: ShortcutEntry): Promise<string | null> {
  if (entry.icon.kind === 'none') return null
  if (entry.icon.kind === 'file' && entry.icon.path) {
    const custom = fileDataUrl(entry.icon.path, MAX_CUSTOM_BYTES)
    if (custom) return custom
    // 用户选的图没了（被删/损坏）就退回自动，而不是留个空白
  }
  if (/^https?:\/\//i.test(entry.command)) return faviconFor(entry.command)
  try {
    const image = await app.getFileIcon(entry.command, { size: 'large' })
    return image.isEmpty() ? null : image.toDataURL()
  } catch {
    return null
  }
}

/**
 * 并发补齐图标（上限 4，避免一次开一堆 Shell 解析）。
 * 每完成一个就回调一次，界面能边出边填，不用等全部好。
 */
export async function warmShortcutIcons(
  entries: ShortcutEntry[],
  onEach: (id: string, dataUrl: string | null) => void
): Promise<void> {
  const store = ensureLoaded()
  const pending = entries.filter((e) => store[e.id]?.key !== iconKey(e))
  if (!pending.length) return
  let cursor = 0
  const workers = Array.from({ length: Math.min(CONCURRENCY, pending.length) }, async () => {
    while (cursor < pending.length) {
      const entry = pending[cursor++]
      const dataUrl = await resolveIcon(entry)
      store[entry.id] = { key: iconKey(entry), dataUrl }
      onEach(entry.id, dataUrl)
    }
  })
  await Promise.all(workers)
  persist()
}
