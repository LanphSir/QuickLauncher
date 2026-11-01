import { app } from 'electron'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { getConfig } from '../config'
import { PLUGIN_FEATURES } from '../../shared/pluginApi'
import { readDevServers } from './devServers'
import { pluginAppUrl } from './urls'

export type PluginType = 'web' | 'external'
export type PluginSource = 'builtin' | 'installed'

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
  /** 申请的 API 权限：storage / clipboard / notify / shell / docs / search / webview / net */
  permissions?: string[]
  /**
   * 可选功能声明：`inline` = 参与面板内联结果（每敲一次键推一次查询）。
   * 与 permissions 分开：权限是「能调什么」，功能是「以什么形态参与启动器」。
   */
  features?: string[]
  /**
   * net 权限可访问的域白名单（浏览器扩展式声明）：
   * `api.github.com`、`*.example.com`（含裸域）、`localhost:8080`。
   * 缺省或空 = 一个都不许。
   */
  hosts?: string[]
}

export interface PluginRecord {
  manifest: PluginManifest
  /** 插件所在目录（web 型的 entry 相对此目录，可能是 baseDir/dist） */
  dir: string
  /** 插件顶层目录（installed 型卸载时删除它） */
  baseDir: string
  source: PluginSource
  disabled: boolean
  iconDataUrl: string | null
  /** external 型：磁盘上的原始 command/args（用户覆盖前），用于"恢复默认" */
  baseCommand?: string
  baseArgs?: string[]
  /** 开发期入口：vite dev server 地址（仅 .dev-plugins.json 存在且未打包时生效） */
  devUrl?: string
}

const registry = new Map<string, PluginRecord>()

/** 用户安装的插件根目录（两个环境都在 userData 下） */
export function getInstalledRoot(): string {
  return join(app.getPath('userData'), 'plugins', 'installed')
}

interface PluginRoot {
  root: string
  source: PluginSource
}

export function getPluginRoots(): PluginRoot[] {
  return [
    {
      root: app.isPackaged
        ? join(process.resourcesPath, 'plugins', 'builtin')
        : join(app.getAppPath(), 'plugins'),
      source: 'builtin'
    },
    { root: getInstalledRoot(), source: 'installed' }
  ]
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
  // hosts 非法只丢该项（不整插件拒载）：白名单缺项等于少给权限，不会越权
  if (m.hosts !== undefined) {
    const list = Array.isArray(m.hosts) ? m.hosts : []
    m.hosts = normalizeHosts(list, dir)
  }
  // features 同理：不认识的功能名直接丢，插件照常加载（只是不参与该形态）
  if (m.features !== undefined) {
    m.features = normalizeFeatures(Array.isArray(m.features) ? m.features : [], m.type, dir)
  }
  return m as unknown as PluginManifest
}

/** 只认 PLUGIN_FEATURES 里声明过的功能名；external 型不参与任何功能 */
function normalizeFeatures(raw: unknown[], type: unknown, dir: string): string[] {
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const value = item.trim().toLowerCase()
    if (!(PLUGIN_FEATURES as readonly string[]).includes(value)) {
      console.warn(`[plugin] ${dir}: 忽略未知的 features 项 ${JSON.stringify(item)}`)
      continue
    }
    if (type !== 'web') {
      console.warn(`[plugin] ${dir}: external 型插件不支持 features，已忽略 ${value}`)
      continue
    }
    if (!out.includes(value)) out.push(value)
  }
  return out
}

/** 形如 api.github.com / *.example.com / localhost:8080；其余一律丢弃并告警 */
const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i

function normalizeHosts(raw: unknown[], dir: string): string[] {
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const value = item.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    if (!value || !HOST_RE.test(value)) {
      console.warn(`[plugin] ${dir}: 忽略非法的 hosts 项 ${JSON.stringify(item)}`)
      continue
    }
    if (!out.includes(value)) out.push(value)
  }
  return out
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

function loadFromDir(dir: string, source: PluginSource, baseDir: string): PluginRecord | null {
  try {
    const manifest = validate(JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf-8')), dir)
    if (!manifest) return null
    if (registry.has(manifest.id)) {
      console.warn(`[plugin] id 重复，跳过: ${manifest.id} (${dir})`)
      return null
    }
    const record: PluginRecord = {
      manifest,
      dir,
      baseDir,
      source,
      disabled: getConfig().disabledPluginIds.includes(manifest.id),
      iconDataUrl: iconToDataUrl(dir)
    }
    if (manifest.type === 'external') {
      record.baseCommand = manifest.command
      record.baseArgs = [...(manifest.args ?? [])]
      // 应用用户在面板里保存的启动命令覆盖
      const override = getConfig().pluginOverrides?.[manifest.id]
      if (override?.command) manifest.command = override.command
      if (override?.args) manifest.args = override.args
    }
    return record
  } catch (err) {
    console.error(`[plugin] 加载失败 ${dir}`, err)
    return null
  }
}

/** 扫描所有插件根目录并重建注册表。子目录本身含 plugin.json，或其 dist/ 内含均可。 */
export function scanPlugins(): PluginRecord[] {
  registry.clear()
  // 开发期入口：仅在本地存在 .dev-plugins.json 时非空，打包版恒为空
  const devServers = readDevServers()
  for (const { root, source } of getPluginRoots()) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const base = join(root, entry.name)
      const dir = existsSync(join(base, 'plugin.json'))
        ? base
        : existsSync(join(base, 'dist', 'plugin.json'))
          ? join(base, 'dist')
          : null
      if (!dir) continue
      const rec = loadFromDir(dir, source, base)
      if (!rec) continue
      const devUrl = devServers[rec.manifest.id]
      if (devUrl) rec.devUrl = devUrl
      registry.set(rec.manifest.id, rec)
    }
  }
  const devCount = listPlugins().filter((r) => r.devUrl).length
  console.log(`[plugin] 已加载 ${registry.size} 个插件${devCount ? `（其中 ${devCount} 个走 dev server）` : ''}`)
  return listPlugins()
}

export function listPlugins(): PluginRecord[] {
  return [...registry.values()]
}

export function getPlugin(id: string): PluginRecord | undefined {
  return registry.get(id)
}

/** 构建产物入口：plugin://<id>/<entry>（自定义协议由 plugin/protocol.ts 提供） */
export function pluginBuiltUrl(rec: PluginRecord): string {
  return pluginAppUrl(rec.manifest.id, rec.manifest.entry)
}

export function pluginEntryUrl(rec: PluginRecord): string {
  // 开发期优先走 vite dev server：页面拿到 HMR，改代码不用重构建也不用重启
  if (rec.devUrl) return rec.devUrl
  return pluginBuiltUrl(rec)
}

// ---------- 安装 / 卸载 ----------

/** 在目录树中定位含 plugin.json 的目录（根、根/dist、一层子目录、一层子目录/dist） */
function findManifestDir(root: string): string | null {
  if (existsSync(join(root, 'plugin.json'))) return root
  if (existsSync(join(root, 'dist', 'plugin.json'))) return join(root, 'dist')
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const sub = join(root, entry.name)
    if (existsSync(join(sub, 'plugin.json'))) return sub
    if (existsSync(join(sub, 'dist', 'plugin.json'))) return join(sub, 'dist')
  }
  return null
}

/** 手动解包 zip（防 zip-slip：过滤路径穿越与 node_modules） */
function extractZipSafe(zipPath: string, outDir: string): void {
  const zip = new AdmZip(zipPath)
  mkdirSync(outDir, { recursive: true })
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const name = entry.entryName.replace(/\\/g, '/')
    const parts = name.split('/')
    if (parts.some((p) => p === '..' || p === '')) continue
    if (parts.includes('node_modules')) continue
    const target = join(outDir, ...parts)
    if (!target.startsWith(outDir)) continue
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, entry.getData())
  }
}

/**
 * 从目录或 zip 安装插件到 installed 根目录：
 * 定位 manifest → 拷贝 → 校验 → 失败回滚，成功后重扫全量插件。
 */
export function installPluginFromPath(src: string): { ok: boolean; message?: string } {
  const installedRoot = getInstalledRoot()
  let candidateDir: string | null = null
  let tempDir: string | null = null
  try {
    const st = statSync(src)
    if (st.isDirectory()) {
      candidateDir = findManifestDir(src)
    } else if (src.toLowerCase().endsWith('.zip')) {
      tempDir = join(installedRoot, `.tmp-${Date.now()}`)
      extractZipSafe(src, tempDir)
      candidateDir = findManifestDir(tempDir)
    } else {
      return { ok: false, message: '仅支持目录或 .zip 文件' }
    }
    if (!candidateDir) {
      return { ok: false, message: '未找到 plugin.json（支持根目录或 dist/ 内）' }
    }
    const raw = JSON.parse(readFileSync(join(candidateDir, 'plugin.json'), 'utf-8')) as {
      id?: string
      name?: string
    }
    if (!raw?.id || !/^[\w.-]+$/.test(raw.id)) {
      return { ok: false, message: 'plugin.json 缺少合法 id' }
    }
    const baseName = raw.id.split('.').pop() || 'plugin'
    let target = join(installedRoot, baseName)
    let n = 2
    while (existsSync(target)) target = join(installedRoot, `${baseName}-${n++}`)
    cpSync(candidateDir, target, {
      recursive: true,
      filter: (s) => s === candidateDir || !/(^|[\\/])node_modules([\\/]|$)/.test(s)
    })
    const rec = loadFromDir(target, 'installed', target)
    if (!rec) {
      rmSync(target, { recursive: true, force: true })
      return { ok: false, message: 'manifest 校验未通过（见主进程日志），已回滚' }
    }
    scanPlugins()
    console.log(`[plugin] 已安装: ${rec.manifest.name} -> ${target}`)
    return { ok: true, message: `已安装「${rec.manifest.name}」` }
  } catch (err) {
    return { ok: false, message: `安装失败: ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  }
}

export function uninstallPlugin(id: string): { ok: boolean; message?: string } {
  const rec = getPlugin(id)
  if (!rec) return { ok: false, message: '插件不存在' }
  if (rec.source !== 'installed') return { ok: false, message: '内置插件不可卸载，可改为停用' }
  try {
    rmSync(rec.baseDir, { recursive: true, force: true })
  } catch (err) {
    return { ok: false, message: `删除失败: ${err instanceof Error ? err.message : String(err)}` }
  }
  scanPlugins()
  console.log(`[plugin] 已卸载: ${rec.manifest.name}`)
  return { ok: true, message: `已卸载「${rec.manifest.name}」` }
}
