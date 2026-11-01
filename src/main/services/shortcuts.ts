import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { getConfig, updateConfig } from '../config'
import { forgetShortcutIcon } from './shortcutIcons'
import {
  buildShortcut,
  dedupeCandidates,
  parseShortcutList,
  parseUrlFile,
  type ShortcutCandidate,
  type ShortcutDraft,
  type ShortcutEntry
} from './shortcutModel'

/**
 * 自定义外部应用的持久层（`userData/shortcuts.json`）。
 *
 * 为什么单独一个文件而不是塞进 config.json：这块是"用户自建内容"，
 * 会被导出/备份/手动编辑，和运行时偏好（热键、窗口位置）混在一起容易互相牵连；
 * 带 schemaVersion 也方便以后迁移。插件表扫描时把它注入注册表，之后所有链路
 * （启动、搜索、固定、快捷键）都不需要知道"这条是自定义的"。
 */

const SCHEMA_VERSION = 1

/** 内存里只加载一次；写操作后立即落盘并保持缓存一致 */
let entries: ShortcutEntry[] | null = null

function storeFile(): string {
  return join(app.getPath('userData'), 'shortcuts.json')
}

export function shortcutsIconDir(): string {
  return join(app.getPath('userData'), 'shortcuts', 'icons')
}

export function loadShortcuts(): ShortcutEntry[] {
  if (entries) return entries
  try {
    if (existsSync(storeFile())) {
      entries = parseShortcutList(JSON.parse(readFileSync(storeFile(), 'utf-8')))
    } else {
      entries = []
    }
  } catch (err) {
    console.error('[shortcut] 读取失败，按空处理', err)
    entries = []
  }
  return entries
}

function persist(): void {
  if (!entries) return
  try {
    const data = { schemaVersion: SCHEMA_VERSION, items: entries }
    writeFileSync(storeFile(), JSON.stringify(data, null, 2), 'utf-8')
  } catch (err) {
    console.error('[shortcut] 保存失败', err)
  }
}

export function listShortcuts(): ShortcutEntry[] {
  return loadShortcuts()
}

export function getShortcut(id: string): ShortcutEntry | undefined {
  return loadShortcuts().find((e) => e.id === id)
}

export function saveShortcut(
  draft: ShortcutDraft,
  takenIds: Set<string>
): { ok: boolean; entry?: ShortcutEntry; message?: string } {
  const list = loadShortcuts()
  const existing = draft.id ? list.find((e) => e.id === draft.id) : undefined
  const built = buildShortcut(draft, takenIds, existing)
  if (!built.ok) return { ok: false, message: built.message }
  // 用户选的图可能还在桌面/下载目录：复制进 userData 再引用，
  // 否则他哪天清桌面，应用的图标就永久变白，而且没人会想到是这个原因
  if (built.entry.icon.kind === 'file' && built.entry.icon.path) {
    const iconDir = shortcutsIconDir()
    if (!built.entry.icon.path.startsWith(iconDir)) {
      const imported = importIconFile(built.entry.id, built.entry.icon.path)
      if (imported.ok && imported.path) built.entry.icon.path = imported.path
    }
  }
  if (existing) Object.assign(existing, built.entry)
  else list.push(built.entry)
  persist()
  return { ok: true, entry: built.entry }
}

/** 删除时把指向它的配置（固定/快捷键/停用/命令覆盖）一并清掉，不留悬空引用 */
export function deleteShortcut(id: string): boolean {
  const list = loadShortcuts()
  const index = list.findIndex((e) => e.id === id)
  if (index < 0) return false
  const [removed] = list.splice(index, 1)
  persist()
  forgetShortcutIcon(id)
  if (removed.icon.path) {
    try {
      if (existsSync(removed.icon.path)) rmSync(removed.icon.path, { force: true })
    } catch {
      /* 图标删不掉不影响主流程 */
    }
  }
  const cfg = getConfig()
  if (cfg.pinnedIds.includes(id)) updateConfig({ pinnedIds: cfg.pinnedIds.filter((x) => x !== id) })
  if (cfg.disabledPluginIds.includes(id)) {
    updateConfig({ disabledPluginIds: cfg.disabledPluginIds.filter((x) => x !== id) })
  }
  if (cfg.pluginHotkeys?.[id]) {
    const next = { ...cfg.pluginHotkeys }
    delete next[id]
    updateConfig({ pluginHotkeys: next })
  }
  if (cfg.pluginOverrides?.[id]) {
    const next = { ...cfg.pluginOverrides }
    delete next[id]
    updateConfig({ pluginOverrides: next })
  }
  return true
}

const ICON_EXT = new Set(['.png', '.ico', '.jpg', '.jpeg', '.svg', '.webp', '.bmp'])
const MAX_ICON_BYTES = 512 * 1024

/**
 * 用户挑的图标复制进 userData 再引用：直接存原路径的话，用户挪个文件夹或清桌面，
 * 图标就永久变成空白，而且没人会想到"图标丢了是因为我删了自己的图片"。
 */
export function importIconFile(id: string, source: string): { ok: boolean; path?: string; message?: string } {
  const ext = extname(source).toLowerCase()
  if (!ICON_EXT.has(ext)) return { ok: false, message: '只支持 png / ico / jpg / svg / webp 图片' }
  try {
    const stat = statSync(source)
    if (stat.size > MAX_ICON_BYTES) return { ok: false, message: '图片太大了（上限 512KB）' }
  } catch {
    return { ok: false, message: '读不到这个文件' }
  }
  try {
    mkdirSync(shortcutsIconDir(), { recursive: true })
    // 同一应用换图标时清掉旧文件，免得 icons 目录越攒越多
    for (const old of readdirSync(shortcutsIconDir())) {
      if (old.startsWith(`${id}.`)) rmSync(join(shortcutsIconDir(), old), { force: true })
    }
    const target = join(shortcutsIconDir(), `${id}${ext}`)
    copyFileSync(source, target)
    return { ok: true, path: target }
  } catch (err) {
    return { ok: false, message: `保存图标失败：${(err as Error).message}` }
  }
}

// —— 从系统里找候选（开始菜单 / 桌面） ——

const MAX_CANDIDATES = 800
const SKIP_NAME = /uninstall|卸载/i

interface ScanRoot {
  label: string
  dir: string
}

function scanRoots(): ScanRoot[] {
  const roots: ScanRoot[] = [{ label: '桌面', dir: app.getPath('desktop') }]
  const publicDesktop = join(process.env.PUBLIC ?? 'C:\\Users\\Public', 'Desktop')
  if (process.platform === 'win32') roots.push({ label: '公共桌面', dir: publicDesktop })
  if (process.env.APPDATA) {
    roots.push({
      label: '开始菜单',
      dir: join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    })
  }
  if (process.env.PROGRAMDATA) {
    roots.push({
      label: '开始菜单(公共)',
      dir: join(process.env.PROGRAMDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    })
  }
  return roots.filter((r) => existsSync(r.dir))
}

function walkShortcuts(dir: string, depth: number, out: { file: string; group: string }[], group: string): void {
  if (depth > 5 || out.length >= MAX_CANDIDATES) return
  let items
  try {
    items = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const item of items) {
    if (item.name.startsWith('.') || out.length >= MAX_CANDIDATES) continue
    const full = join(dir, item.name)
    if (item.isDirectory()) {
      walkShortcuts(full, depth + 1, out, `${group} / ${item.name}`)
      continue
    }
    if (!/\.(lnk|url)$/i.test(item.name)) continue
    if (SKIP_NAME.test(item.name)) continue
    out.push({ file: full, group })
  }
}

/**
 * 扫描候选。已导入的（command 相同）在这里就剔掉——导入面板里出现一堆"已经有的"
 * 会让用户以为要去重，实际是白占屏幕。
 */
export function scanShortcutCandidates(): ShortcutCandidate[] {
  const found: { file: string; group: string }[] = []
  for (const root of scanRoots()) {
    walkShortcuts(root.dir, 0, found, root.label)
  }
  const candidates: ShortcutCandidate[] = []
  for (const item of found) {
    const isUrl = /\.url$/i.test(item.file)
    let command = item.file
    if (isUrl) {
      try {
        const url = parseUrlFile(readFileSync(item.file, 'utf-8'))
        if (!url) continue
        command = url
      } catch {
        continue
      }
    }
    // 分组里带上相对子目录，同名的"附件/系统工具"才分得开
    candidates.push({
      path: command,
      name: item.file.split(/[\\/]/).pop()!.replace(/\.(lnk|url)$/i, ''),
      group: item.group,
      kind: isUrl ? 'url' : 'lnk'
    })
  }
  const existing = loadShortcuts().map((e) => e.command)
  return dedupeCandidates(candidates, existing)
}

/** 批量导入：逐条生成记录，撞 id 时自动加序号，失败一条不影响其它 */
export function importShortcuts(
  items: { path: string; name: string }[],
  takenIds: Set<string>
): { ok: boolean; created: number; skipped: number; message?: string } {
  if (!items.length) return { ok: false, created: 0, skipped: 0, message: '没有选中任何应用' }
  let created = 0
  let skipped = 0
  for (const item of items) {
    const result = saveShortcut(
      { name: item.name, command: item.path, args: [], keywords: '', icon: { kind: 'auto' } },
      takenIds
    )
    if (result.ok && result.entry) {
      takenIds.add(result.entry.id)
      created++
    } else {
      skipped++
    }
  }
  return { ok: created > 0, created, skipped, message: created ? undefined : '全都没能导入' }
}
