/**
 * 插件工具目录与授权（v0.6.2）。
 *
 * 分工：`toolsSpec.ts` 负责「一份 JSON 合不合法」，这里负责「从磁盘读到内存、
 * 缓存、按授权过滤」。工具真正执行在 v0.6.3，本版只把目录做对——
 * 没有可靠的目录与授权，执行层写出来也是漏的。
 *
 * 授权是**插件级**的：用户按插件开关，而不是按单个工具。原因是同一个插件的
 * 工具共享同一套权限与数据（它们的区别只是入口），按工具开关只会让人误以为
 * 「关掉这个就安全了」。
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getConfig, updateConfig } from '../config'
import type { AiToolEntry, AiToolPluginView, PluginAiMeta } from '../../shared/ai'
import { getPlugin, listPlugins, type PluginRecord } from '../plugin/manager'
import { parseSkillMd, type ParsedSkill } from './skillFile'
import { parseToolsSpec, toolFullName, type ToolsParseResult } from './toolsSpec'

interface CacheEntry {
  /** 文件指纹（mtime+size）：变了就重解析，避免每次读 IPC 都碰磁盘 */
  toolsKey: string
  tools: ToolsParseResult
  skillKey: string
  skill: ParsedSkill | null
  skillError?: string
}

const cache = new Map<string, CacheEntry>()

function emptyEntry(): CacheEntry {
  return {
    toolsKey: '',
    tools: { tools: [], validators: new Map(), errors: [] },
    skillKey: '',
    skill: null
  }
}

function fingerprint(file: string): string {
  try {
    const st = statSync(file)
    return `${file}:${st.mtimeMs}:${st.size}`
  } catch {
    return ''
  }
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf-8')
  } catch (err) {
    console.warn(`[ai] 读不到 ${file}`, err)
    return null
  }
}

function loadToolsOf(rec: PluginRecord, meta: PluginAiMeta, entry: CacheEntry): ToolsParseResult {
  if (!meta.tools) return { tools: [], validators: new Map(), errors: [] }
  const file = join(rec.dir, meta.tools)
  const key = fingerprint(file)
  if (key && key === entry.toolsKey) return entry.tools

  entry.toolsKey = key
  const text = readText(file)
  if (text === null) {
    entry.tools = { tools: [], validators: new Map(), errors: [`读不到 ${meta.tools}`] }
    return entry.tools
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    entry.tools = {
      tools: [],
      validators: new Map(),
      errors: [`${meta.tools} 不是合法 JSON：${reason.slice(0, 120)}`]
    }
    return entry.tools
  }
  entry.tools = parseToolsSpec(raw)
  if (entry.tools.errors.length) {
    console.warn(`[ai] ${rec.manifest.id} 的 tools.json 有 ${entry.tools.errors.length} 处问题`)
  }
  return entry.tools
}

function loadSkillOf(rec: PluginRecord, meta: PluginAiMeta, entry: CacheEntry): ParsedSkill | null {
  if (!meta.skill) return null
  const file = join(rec.dir, meta.skill)
  const key = fingerprint(file)
  if (key && key === entry.skillKey) return entry.skill

  entry.skillKey = key
  entry.skill = null
  entry.skillError = undefined
  const text = readText(file)
  if (text === null) {
    entry.skillError = `读不到 ${meta.skill}`
    return null
  }
  const parsed = parseSkillMd(text)
  if (!parsed) {
    entry.skillError = `${meta.skill} 是空的或没有可读的说明`
    return null
  }
  entry.skill = parsed
  return parsed
}

function stateOf(rec: PluginRecord): CacheEntry {
  const meta = rec.manifest.ai
  let entry = cache.get(rec.manifest.id)
  if (!entry) {
    entry = emptyEntry()
    cache.set(rec.manifest.id, entry)
  }
  if (!meta) return entry
  loadToolsOf(rec, meta, entry)
  loadSkillOf(rec, meta, entry)
  return entry
}

/** 只有显式声明了 `permissions: ["ai"]` 的插件才允许被调用（与 internalOnly 同一条原则） */
export function hasAiPermission(rec: PluginRecord): boolean {
  return (rec.manifest.permissions ?? []).includes('ai')
}

export function isPluginGranted(pluginId: string): boolean {
  return (getConfig().aiToolGrants ?? []).includes(pluginId)
}

/**
 * 设置页的一行。**不加授权过滤**：未授权的插件也要显示出来，
 * 否则用户根本不知道有这个能力可开。
 */
export function listToolPlugins(): AiToolPluginView[] {
  const out: AiToolPluginView[] = []
  for (const rec of listPlugins()) {
    const meta = rec.manifest.ai
    if (!meta) continue
    const entry = stateOf(rec)
    const errors = [...entry.tools.errors]
    if (!hasAiPermission(rec)) {
      errors.unshift('插件没有声明 permissions: ["ai"]，工具不会被调用')
    }
    if (entry.skillError) errors.push(entry.skillError)
    const tools = entry.tools.tools.map((t) => ({ name: t.name, title: t.title, risk: t.risk }))
    // 既没工具也没技能说明（例如只声明了 mcp，或全解析失败）：仍列出来，
    // 让用户看见「它声明了 AI 能力但没生效」，而不是当它不存在
    out.push({
      pluginId: rec.manifest.id,
      pluginName: rec.manifest.name,
      disabled: rec.disabled,
      granted: isPluginGranted(rec.manifest.id),
      tools,
      ...(entry.skill ? { skill: { name: entry.skill.name, description: entry.skill.description } } : {}),
      errors
    })
  }
  return out
}

/**
 * 下发给模型的工具清单：**授权 + 有 ai 权限 + 插件未停用**，三样缺一不可。
 * 停用的插件仍要排除——用户停用它是为了不用它，工具偷偷还能调就自相矛盾了。
 */
export function grantedTools(): AiToolEntry[] {
  const out: AiToolEntry[] = []
  for (const rec of listPlugins()) {
    if (rec.disabled || !rec.manifest.ai || !hasAiPermission(rec)) continue
    if (!isPluginGranted(rec.manifest.id)) continue
    const entry = stateOf(rec)
    for (const spec of entry.tools.tools) {
      out.push({
        ...spec,
        fullName: toolFullName(rec.manifest.id, spec.name),
        pluginId: rec.manifest.id,
        pluginName: rec.manifest.name
      })
    }
  }
  return out
}

/** 按全局名反查工具：执行前用它确认「这个工具真的被授权过」，不信任模型给的名字 */
export function findTool(fullName: string): AiToolEntry | null {
  return grantedTools().find((t) => t.fullName === fullName) ?? null
}

export function setToolGrant(pluginId: string, granted: boolean): { ok: boolean; message?: string } {
  const rec = getPlugin(pluginId)
  if (!rec) return { ok: false, message: '插件不存在' }
  const current = getConfig().aiToolGrants ?? []
  if (current.includes(pluginId) === granted) return { ok: true }
  const next = granted ? [...current, pluginId] : current.filter((id) => id !== pluginId)
  updateConfig({ aiToolGrants: next })
  return { ok: true }
}

export interface SkillResult {
  ok: boolean
  name?: string
  description?: string
  body?: string
  message?: string
}

/**
 * 按需读取技能正文（v0.6.3 的 `load_skill` 工具会调它）。
 * 同样要求授权：SKILL.md 里可能有插件作者写的内部细节，不该在未授权时被读出来。
 */
export function loadSkillBody(pluginId: string): SkillResult {
  const rec = getPlugin(pluginId)
  if (!rec) return { ok: false, message: '插件不存在' }
  if (!rec.manifest.ai?.skill) return { ok: false, message: `${rec.manifest.name} 没有提供技能文档` }
  if (!isPluginGranted(pluginId)) {
    return { ok: false, message: `尚未授权「${rec.manifest.name}」给 AI 使用：设置 → AI → AI 工具` }
  }
  const skill = stateOf(rec).skill
  if (!skill) return { ok: false, message: '技能文档读不出来' }
  return { ok: true, name: skill.name, description: skill.description, body: skill.body }
}

/** 插件增删/更新后清缓存：重启扫描时窗口态已变，旧解析结果不该留着 */
export function clearToolCache(): void {
  cache.clear()
}
