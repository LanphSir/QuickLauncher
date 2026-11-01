/**
 * 自定义外部应用的数据模型（纯函数，不碰 fs / electron）。
 *
 * 这类应用和 manifest 插件走同一套扫描/启动/搜索链路，区别只是"配置从哪来"：
 * 插件读目录里的 plugin.json，自定义应用读 userData/shortcuts.json。
 * 所以这里做的所有事就是"把用户填的表单洗成一条可信的入口记录"。
 */

export type ShortcutIconKind = 'auto' | 'file' | 'none'

export interface ShortcutEntry {
  /** com.launcher.shortcut.<slug>，创建时生成后不再变（配置/固定/停用都按它索引） */
  id: string
  name: string
  /** exe 路径、PATH 里的命令名、.lnk，或 http(s) 链接 */
  command: string
  args: string[]
  workDir?: string
  keywords: string[]
  description?: string
  icon: { kind: ShortcutIconKind; path?: string }
  createdAt: number
}

export const SHORTCUT_PREFIX = 'com.launcher.shortcut.'

const MAX_NAME = 60
const MAX_KEYWORDS = 24

/** 取路径末段，同时认 `/` 与 `\`（Windows 路径两种都会出现在用户手填的命令里） */
export function baseName(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  const tail = idx >= 0 ? trimmed.slice(idx + 1) : trimmed
  return tail.replace(/\.[^.]+$/, '')
}

/** id 的可读片段：非字母数字一律折叠成 '-'，中文名会得到空串（由调用方回退） */
export function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
}

/**
 * 生成 id。用命令文件名优先、名字兜底：`code.exe` → `...shortcut.code`，
 * 用户一眼能看出是哪个应用；中文名 + 中文路径则落到序号。
 */
export function makeShortcutId(name: string, command: string, taken: Set<string>): string {
  const base = slugify(baseName(command)) || slugify(name) || 'app'
  let candidate = `${SHORTCUT_PREFIX}${base}`
  let n = 2
  while (taken.has(candidate)) {
    candidate = `${SHORTCUT_PREFIX}${base}-${n++}`
  }
  return candidate
}

/** 参数文本拆成数组：认双引号，`"C:/My App/a.exe" --flag` 不会被空格切碎 */
export function splitArgs(text: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (const ch of text) {
    if (ch === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && /\s/.test(ch)) {
      if (cur) out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

/** 关键词：字符串按逗号/顿号/空白切，数组原样收；去重去空、限制条数 */
export function normalizeKeywords(raw: unknown): string[] {
  const list: string[] = []
  const push = (value: string): void => {
    const v = value.trim()
    if (!v) return
    if (list.some((x) => x.toLowerCase() === v.toLowerCase())) return
    if (list.length >= MAX_KEYWORDS) return
    list.push(v)
  }
  if (typeof raw === 'string') {
    for (const part of raw.split(/[,，、;；\s]+/)) push(part)
  } else if (Array.isArray(raw)) {
    for (const item of raw) if (typeof item === 'string') push(item)
  }
  return list
}

export function normalizeIcon(raw: unknown): { kind: ShortcutIconKind; path?: string } {
  if (typeof raw === 'string' && (raw === 'auto' || raw === 'file' || raw === 'none')) {
    return { kind: raw }
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    const kind = obj.kind === 'file' || obj.kind === 'none' ? obj.kind : 'auto'
    const path = typeof obj.path === 'string' ? obj.path.trim() : ''
    if (kind === 'file' && path) return { kind: 'file', path }
    return { kind: kind === 'file' ? 'auto' : kind }
  }
  return { kind: 'auto' }
}

function normalizeArgs(raw: unknown): string[] {
  if (typeof raw === 'string') return splitArgs(raw)
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
  }
  return []
}

export interface ShortcutDraft {
  id?: string
  name?: unknown
  command?: unknown
  args?: unknown
  workDir?: unknown
  keywords?: unknown
  description?: unknown
  icon?: unknown
}

export type BuildResult = { ok: true; entry: ShortcutEntry } | { ok: false; message: string }

/**
 * 表单 → 记录。`taken` 是已占用的 id（含插件 id），`existing` 是编辑时的原记录
 * （保留 id 与 createdAt，避免编辑一次"固定/停用/快捷键"全丢）。
 */
export function buildShortcut(
  input: ShortcutDraft,
  taken: Set<string>,
  existing?: ShortcutEntry
): BuildResult {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) return { ok: false, message: '名称不能为空' }
  if (name.length > MAX_NAME) return { ok: false, message: `名称太长了（上限 ${MAX_NAME} 字）` }

  const command = typeof input.command === 'string' ? input.command.trim() : ''
  if (!command) return { ok: false, message: '启动命令不能为空' }

  const id = existing?.id ?? (input.id && taken.has(input.id) ? input.id : makeShortcutId(name, command, taken))
  const workDir = typeof input.workDir === 'string' ? input.workDir.trim() : ''

  return {
    ok: true,
    entry: {
      id,
      name,
      command,
      args: normalizeArgs(input.args),
      workDir: workDir || undefined,
      keywords: normalizeKeywords(input.keywords),
      description: typeof input.description === 'string' ? input.description.trim() || undefined : undefined,
      icon: normalizeIcon(input.icon),
      createdAt: existing?.createdAt ?? Date.now()
    }
  }
}

/** 读 shortcuts.json 时逐条洗：坏一条只丢这条，不让整个文件失效 */
export function parseShortcutList(raw: unknown): ShortcutEntry[] {
  const items = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items)
      ? (raw as { items: unknown[] }).items
      : []
  const out: ShortcutEntry[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const id = typeof obj.id === 'string' ? obj.id.trim() : ''
    const name = typeof obj.name === 'string' ? obj.name.trim() : ''
    const command = typeof obj.command === 'string' ? obj.command.trim() : ''
    if (!id || !name || !command) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      name,
      command,
      args: normalizeArgs(obj.args),
      workDir: typeof obj.workDir === 'string' && obj.workDir.trim() ? obj.workDir.trim() : undefined,
      keywords: normalizeKeywords(obj.keywords),
      description: typeof obj.description === 'string' ? obj.description.trim() || undefined : undefined,
      icon: normalizeIcon(obj.icon),
      createdAt: typeof obj.createdAt === 'number' && Number.isFinite(obj.createdAt) ? obj.createdAt : 0
    })
  }
  return out
}

/** `.url` 是 INI 格式，真正的地址在 `URL=` 那行 */
export function parseUrlFile(content: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    const m = /^\s*URL\s*=\s*(.+)$/i.exec(line)
    if (!m) continue
    const value = m[1].trim().replace(/^"|"$/g, '')
    if (/^https?:\/\//i.test(value)) return value
    return null
  }
  return null
}

export type CandidateKind = 'lnk' | 'url'

export interface ShortcutCandidate {
  /** 磁盘路径（.lnk）或 URL（.url） */
  path: string
  /** 展示名（文件名去扩展名） */
  name: string
  /** 来源分组：开始菜单/桌面 + 子目录 */
  group: string
  kind: CandidateKind
}

/**
 * 导入候选去重：
 * 1) 候选之间同名同目标只留一条（开始菜单里同一个程序常有多份快捷方式）；
 * 2) 已经导入过的（command 相同）直接剔除，避免重复导入出现两个"VS Code"。
 */
export function dedupeCandidates(
  candidates: ShortcutCandidate[],
  existingCommands: Iterable<string>
): ShortcutCandidate[] {
  const taken = new Set<string>()
  for (const cmd of existingCommands) {
    const key = cmd.trim().toLowerCase()
    if (key) taken.add(key)
  }
  const seen = new Set<string>()
  const out: ShortcutCandidate[] = []
  for (const c of candidates) {
    const cmdKey = c.path.trim().toLowerCase()
    if (taken.has(cmdKey)) continue
    const dupKey = `${c.name.trim().toLowerCase()}|${cmdKey}`
    if (seen.has(dupKey)) continue
    seen.add(dupKey)
    out.push(c)
  }
  return out
}

/** 按 group 聚合，组内保持扫描顺序；组按名称排序，空组不出现 */
export function groupCandidates(
  candidates: ShortcutCandidate[]
): { group: string; items: ShortcutCandidate[] }[] {
  const map = new Map<string, ShortcutCandidate[]>()
  for (const c of candidates) {
    const list = map.get(c.group)
    if (list) list.push(c)
    else map.set(c.group, [c])
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN'))
    .map(([group, items]) => ({ group, items }))
}
