import { app } from 'electron'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export type PluginType = 'web' | 'external'

export interface PluginManifest {
  /** 全局唯一 id，建议反向域名：com.launcher.xxx */
  id: string
  name: string
  version?: string
  description?: string
  type: PluginType
  /** web 型：入口 html，相对插件目录 */
  entry?: string
  /** external 型：可执行文件路径/命令，或 http(s) 链接 */
  command?: string
  args?: string[]
  keywords?: string[]
  /** 申请的 API 权限：storage / clipboard / notify / shell */
  permissions?: string[]
}

export interface PluginRecord {
  manifest: PluginManifest
  /** 插件所在目录（web 型的 entry 相对此目录） */
  dir: string
  iconDataUrl: string | null
}

const registry = new Map<string, PluginRecord>()

export function getPluginRoots(): string[] {
  return app.isPackaged
    ? [join(process.resourcesPath, 'plugins', 'builtin')]
    : [join(app.getAppPath(), 'plugins')]
}

function validate(raw: unknown, dir: string): PluginManifest | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  const bad = (reason: string) => {
    console.warn(`[plugin] 跳过 ${dir}: ${reason}`)
    return null
  }
  if (typeof m.id !== 'string' || !/^[\w.-]+$/.test(m.id)) return bad('id 缺失或非法')
  if (m.type !== 'web' && m.type !== 'external') return bad('type 必须是 web 或 external')
  if (typeof m.name !== 'string' || !m.name) return bad('name 缺失')
  if (m.type === 'web') {
    if (typeof m.entry !== 'string') return bad('web 型插件缺少 entry')
    if (!existsSync(join(dir, m.entry))) return bad(`入口文件不存在: ${m.entry}`)
  }
  if (m.type === 'external' && (typeof m.command !== 'string' || !m.command)) {
    return bad('external 型插件缺少 command')
  }
  return m as unknown as PluginManifest
}

function iconToDataUrl(dir: string): string | null {
  const mimeByExt: Record<string, string> = {
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
  }
  for (const name of ['icon.svg', 'icon.png', 'icon.ico']) {
    const file = join(dir, name)
    if (!existsSync(file)) continue
    const mime = mimeByExt[name.slice(name.lastIndexOf('.'))]
    try {
      return `data:${mime};base64,${readFileSync(file).toString('base64')}`
    } catch {
      return null
    }
  }
  return null
}

function loadFromDir(dir: string): PluginRecord | null {
  try {
    const manifest = validate(JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf-8')), dir)
    if (!manifest) return null
    if (registry.has(manifest.id)) {
      console.warn(`[plugin] id 重复，跳过: ${manifest.id} (${dir})`)
      return null
    }
    return { manifest, dir, iconDataUrl: iconToDataUrl(dir) }
  } catch (err) {
    console.error(`[plugin] 加载失败 ${dir}`, err)
    return null
  }
}

/** 扫描所有插件根目录并重建注册表。每个子目录本身含 plugin.json，或其 dist/ 子目录含 plugin.json 均可。 */
export function scanPlugins(): PluginRecord[] {
  registry.clear()
  for (const root of getPluginRoots()) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const base = join(root, entry.name)
      const dir = existsSync(join(base, 'plugin.json'))
        ? base
        : existsSync(join(base, 'dist', 'plugin.json'))
          ? join(base, 'dist')
          : null
      if (!dir) continue
      const rec = loadFromDir(dir)
      if (rec) registry.set(rec.manifest.id, rec)
    }
  }
  console.log(`[plugin] 已加载 ${registry.size} 个插件`)
  return listPlugins()
}

export function listPlugins(): PluginRecord[] {
  return [...registry.values()]
}

export function getPlugin(id: string): PluginRecord | undefined {
  return registry.get(id)
}

export function pluginEntryUrl(rec: PluginRecord): string {
  return pathToFileURL(join(rec.dir, rec.manifest.entry!)).href
}
