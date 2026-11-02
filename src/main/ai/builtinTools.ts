/**
 * 主进程自带的一组工具（v0.6.3）。
 *
 * 为什么要有内置工具：如果 AI 只能调插件工具，那「把剪贴板里的地址用翻译插件翻一下」
 * 这句话里就有一半的动作用户得自己先做完。启动器自己知道的东西（有哪些应用、
 * 剪贴板里是什么、文档库有什么）应该由它直接交给模型，而不是指望某个插件去实现。
 *
 * 三条约定的边界：
 * 1. **内置工具不需要授权开关**：它们读的是启动器自身的状态，不涉及第三方插件的数据；
 *    但写操作（写剪贴板、启动程序）仍受风险分级约束，该确认的照样确认。
 * 2. **不碰文件系统路径**：文档库只按 id 收发内容，与插件 API 保持同一套约束。
 * 3. **结果给人看也给模型看**：返回纯文本，不返回内部结构——模型读文本最稳，
 *    出问题时用户抄一段给开发者也有意义。
 *
 * 工具声明复用 toolsSpec 的解析器：这样参数校验、描述长度上限、风险缺省值
 * 与插件工具是**同一套代码**，不会出现「内置的松、插件的紧」这种两套标准。
 */
import { clipboard } from 'electron'
import { listPlugins } from '../plugin/manager'
import { pluginDocs } from '../services/docs'
import type { AiToolRisk } from '../../shared/ai'
import { parseToolsSpec, type ToolValidator } from './toolsSpec'

export interface ToolOutcome {
  ok: boolean
  /** 给模型看的文本（失败时是失败原因） */
  text: string
}

export type BuiltinHandler = (args: Record<string, unknown>) => Promise<ToolOutcome> | ToolOutcome

export interface BuiltinTool {
  name: string
  title: string
  description: string
  risk: AiToolRisk
  parameters: Record<string, unknown>
  timeoutMs: number
  validate: ToolValidator
  run: BuiltinHandler
}

/**
 * 启动器侧的能力桥。用注入而不是直接 import 主进程入口：
 * `index.ts` 要 import 本模块来装配工具，反过来再 import 就成环了。
 */
export interface LauncherBridge {
  search(query: string): {
    kind: 'plugin' | 'shortcut' | 'entry'
    id: string
    name: string
    description?: string
  }[]
  open(target: string, query?: string): { ok: boolean; message?: string }
}

let launcher: LauncherBridge | null = null

export function setLauncherBridge(bridge: LauncherBridge): void {
  launcher = bridge
}

/**
 * 技能正文读取器。同样用注入：`tools.ts` 要 import 本模块的内置清单，
 * 直接反向 import 会成环（运行时表现为拿到一个半初始化的模块）。
 */
type SkillLoader = (pluginId: string) => { ok: boolean; name?: string; description?: string; body?: string; message?: string }

let skillLoader: SkillLoader | null = null

export function setSkillLoader(loader: SkillLoader): void {
  skillLoader = loader
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 截断长文本并明确标注，免得模型以为自己看到的是全文 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…（已截断，原文 ${text.length} 字）`
}

const RAW_SPECS = {
  version: 1,
  tools: [
    {
      name: 'launcher_search',
      title: '搜索启动器条目',
      description:
        '在启动器里搜索插件、自定义应用和插件注册的条目（手册章节、笔记等）。' +
        '用户提到某个应用/工具但你不确定它是否存在、或需要拿到它的 id 时先调它。返回每条的 kind 与 id，可直接传给 launcher_open。',
      risk: 'read',
      timeoutMs: 5000,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索词，例如「翻译」「计算器」' },
          limit: { type: 'integer', description: '最多返回几条，默认 8', minimum: 1, maximum: 20 }
        },
        required: ['query']
      }
    },
    {
      name: 'launcher_open',
      title: '打开启动器条目',
      description:
        '打开一个插件或应用（会切到该插件页/拉起程序）。target 传 id 或名称。' +
        '插件支持 query 时会把 query 透传过去（例如翻译插件会直接翻译 query 这段文字）。' +
        '这是有副作用的操作：打开前要确认用户确实想打开它。',
      risk: 'write',
      timeoutMs: 8000,
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '插件 id（如 com.launcher.translator）或名称（如 快速翻译）' },
          query: { type: 'string', description: '可选，打开后要处理的文本/搜索词' }
        },
        required: ['target']
      }
    },
    {
      name: 'clipboard_read',
      title: '读取剪贴板',
      description:
        '读取剪贴板里的纯文本。用户说「我复制的」「剪贴板里那个」而你手上没有内容时用它。' +
        '返回空字符串表示剪贴板里没有文本。',
      risk: 'read',
      timeoutMs: 3000,
      parameters: { type: 'object', properties: {} }
    },
    {
      name: 'clipboard_write',
      title: '写入剪贴板',
      description: '把一段文本放进剪贴板（会覆盖用户原有的剪贴板内容）。用户明确要求复制时再调。',
      risk: 'write',
      timeoutMs: 3000,
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要复制的文本' } },
        required: ['text']
      }
    },
    {
      name: 'docs_search',
      title: '搜索文档库',
      description:
        '在插件文档库里按关键词搜索（手册、笔记等插件导入的 Markdown/文本）。' +
        '返回命中的文档及其所属插件，可用 docs_read 读取全文。',
      risk: 'read',
      timeoutMs: 8000,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，不区分大小写' },
          limit: { type: 'integer', description: '最多返回几条，默认 5', minimum: 1, maximum: 10 }
        },
        required: ['query']
      }
    },
    {
      name: 'docs_read',
      title: '读取文档',
      description: '按 docs_search 返回的插件 id 与文档 id 读取全文（超长会截断）。',
      risk: 'read',
      timeoutMs: 5000,
      parameters: {
        type: 'object',
        properties: {
          plugin: { type: 'string', description: '插件 id，来自 docs_search 结果' },
          doc: { type: 'string', description: '文档 id（文件名），来自 docs_search 结果' }
        },
        required: ['plugin', 'doc']
      }
    },
    {
      name: 'skill_read',
      title: '读取插件用法说明',
      description:
        '读取某个插件写给 AI 的用法说明（SKILL.md）。当你要用某个插件的工具但不确定参数怎么填、' +
        '或用户问「这个插件怎么用」时调用。plugin 传插件 id。',
      risk: 'read',
      timeoutMs: 3000,
      parameters: {
        type: 'object',
        properties: {
          plugin: { type: 'string', description: '插件 id，例如 com.launcher.calculator' }
        },
        required: ['plugin']
      }
    }
  ]
}

/** 搜索命中的文档数上限：文档库可能很大，一次扫太多会卡住对话 */
const MAX_DOCS_SCANNED = 60
/** 单个文档参与内容匹配的上限：再大就不是"搜一下"的量级了 */
const MAX_DOC_MATCH_BYTES = 256 * 1024

function searchDocs(query: string, limit: number): ToolOutcome {
  const q = query.trim()
  if (!q) return { ok: false, text: 'query 不能为空' }
  const lower = q.toLowerCase()
  const lines: string[] = []
  let scanned = 0
  for (const rec of listPlugins()) {
    if (rec.disabled || lines.length >= limit) continue
    if (scanned >= MAX_DOCS_SCANNED) break
    for (const doc of pluginDocs.list(rec.manifest.id)) {
      if (lines.length >= limit || scanned >= MAX_DOCS_SCANNED) break
      scanned++
      const titleHit = doc.title.toLowerCase().includes(lower)
      if (!titleHit && doc.size > MAX_DOC_MATCH_BYTES) continue
      let snippet = ''
      if (!titleHit) {
        const read = pluginDocs.read(rec.manifest.id, doc.id)
        if (!read.ok || !read.text) continue
        const at = read.text.toLowerCase().indexOf(lower)
        if (at < 0) continue
        snippet = read.text
          .slice(Math.max(0, at - 40), at + q.length + 60)
          .replace(/\s+/g, ' ')
          .trim()
      }
      lines.push(
        `- 插件 ${rec.manifest.name}（${rec.manifest.id}）· 文档 ${doc.id} · ${doc.title}` +
          (snippet ? `\n  摘录：…${snippet}…` : '')
      )
    }
  }
  if (!lines.length) return { ok: true, text: `文档库里没有匹配「${q}」的内容（已扫描 ${scanned} 个文档）` }
  return { ok: true, text: `找到 ${lines.length} 个文档：\n${lines.join('\n')}` }
}

const parsed = parseToolsSpec(RAW_SPECS)

/**
 * 内置工具表：名字与 RAW_SPECS 一一对应。
 * 解析失败的项直接在表里缺席（而不是带一个坏工具进入下发清单）。
 */
const HANDLERS: Record<string, BuiltinHandler> = {
  launcher_search: (args) => {
    if (!launcher) return { ok: false, text: '启动器尚未就绪' }
    const query = str(args.query).trim()
    if (!query) return { ok: false, text: 'query 不能为空' }
    const limit = typeof args.limit === 'number' ? Math.min(20, Math.max(1, Math.round(args.limit))) : 8
    const hits = launcher.search(query).slice(0, limit)
    if (!hits.length) return { ok: true, text: `没有找到匹配「${query}」的条目` }
    return {
      ok: true,
      text: hits
        .map((h) => `- [${h.kind}] ${h.name} · id=${h.id}${h.description ? ` · ${h.description}` : ''}`)
        .join('\n')
    }
  },

  launcher_open: (args) => {
    if (!launcher) return { ok: false, text: '启动器尚未就绪' }
    const target = str(args.target).trim()
    if (!target) return { ok: false, text: 'target 不能为空' }
    const query = str(args.query).trim()
    const result = launcher.open(target, query || undefined)
    if (!result.ok) return { ok: false, text: result.message ?? '打开失败' }
    return { ok: true, text: `已打开「${target}」${query ? `，并把内容带了过去` : ''}` }
  },

  clipboard_read: () => {
    const text = clipboard.readText()
    if (!text) return { ok: true, text: '（剪贴板里没有文本）' }
    return { ok: true, text: clip(text, 4000) }
  },

  clipboard_write: (args) => {
    const text = str(args.text)
    if (!text) return { ok: false, text: 'text 不能为空' }
    clipboard.writeText(text)
    return { ok: true, text: `已写入剪贴板（${text.length} 字）` }
  },

  docs_search: (args) => {
    const query = str(args.query)
    const limit = typeof args.limit === 'number' ? Math.min(10, Math.max(1, Math.round(args.limit))) : 5
    return searchDocs(query, limit)
  },

  docs_read: (args) => {
    const plugin = str(args.plugin)
    const doc = str(args.doc)
    if (!plugin || !doc) return { ok: false, text: 'plugin 与 doc 都不能为空' }
    const read = pluginDocs.read(plugin, doc)
    if (!read.ok || !read.text) return { ok: false, text: read.message ?? '读取失败' }
    return { ok: true, text: clip(read.text, 8000) }
  },

  skill_read: (args) => {
    const plugin = str(args.plugin).trim()
    if (!plugin) return { ok: false, text: 'plugin 不能为空' }
    if (!skillLoader) return { ok: false, text: '技能读取器尚未就绪' }
    const skill = skillLoader(plugin)
    if (!skill.ok || !skill.body) return { ok: false, text: skill.message ?? '没有可读的说明' }
    return {
      ok: true,
      text: `# ${skill.name ?? plugin}\n${skill.description ? `${skill.description}\n\n` : ''}${clip(skill.body, 6000)}`
    }
  }
}

/** 解析后仍带处理器的工具才算数（少写一个处理器不该让整个模块挂掉） */
function assemble(): BuiltinTool[] {
  const out: BuiltinTool[] = []
  for (const spec of parsed.tools) {
    const run = HANDLERS[spec.name]
    const validate = parsed.validators.get(spec.name)
    if (!run || !validate) continue
    out.push({
      name: spec.name,
      title: spec.title,
      description: spec.description,
      risk: spec.risk,
      parameters: spec.parameters,
      timeoutMs: spec.timeoutMs,
      validate,
      run
    })
  }
  return out
}

export const builtinTools: BuiltinTool[] = assemble()

export function findBuiltinTool(name: string): BuiltinTool | null {
  return builtinTools.find((t) => t.name === name) ?? null
}
