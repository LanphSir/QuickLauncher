/**
 * 工具目录：把「内置工具」与「用户授权的插件工具」摊平成一份下发给模型的清单。
 *
 * 两个必须在这里解决的问题：
 *
 * 1. **函数名合法化**。OpenAI 的函数名只允许 `[A-Za-z0-9_-]{1,64}`，
 *    而插件工具的全局名是 `plugin:<插件 id>:<工具名>`（含冒号与点）。
 *    直接把全局名发下去会被端点 400，所以下发前换成 `plugin_<id>_<name>` 这种形态，
 *    并保留一张「函数名 → 工具」的反查表。模型回传的永远是函数名，
 *    执行前一律按这张表反查——**模型给的名字不能直接当身份**。
 *
 * 2. **只收授权且可用的**。目录每次发消息时重建，不做跨轮缓存：
 *    用户在设置里撤销授权后，下一次提问就不该再看到那个工具。
 */
import type { AiToolEntry, AiToolRisk } from '../../shared/ai'
import type { ApiToolDef } from './provider'
import { builtinTools } from './builtinTools'
import { grantedToolList } from './tools'
import { mcpToolEntries } from './mcpManager'
import type { ToolValidator } from './toolsSpec'
import { apiToolName } from './toolNames'

export interface ResolvedTool {
  /** 下发给模型的函数名（合法、唯一） */
  apiName: string
  /** 全局名/内置名，日志与授权判断用它 */
  fullName: string
  /** 插件内的工具短名（内置工具时等于 fullName） */
  shortName: string
  title: string
  description: string
  risk: AiToolRisk
  parameters: Record<string, unknown>
  timeoutMs: number
  source: 'builtin' | 'plugin' | 'mcp'
  pluginId?: string
  pluginName?: string
  /** source==='mcp' 时：这个工具属于哪个 server（执行要按 server 找进程） */
  server?: string
  validate: ToolValidator
}

export interface ToolCatalog {
  tools: ResolvedTool[]
  /** 直接塞进请求体 tools 字段的形态 */
  apiTools: ApiToolDef[]
  byApiName: Map<string, ResolvedTool>
}

function toApiTool(tool: ResolvedTool): ApiToolDef {
  return {
    type: 'function',
    function: {
      name: tool.apiName,
      description: tool.description,
      parameters: tool.parameters
    }
  }
}

/**
 * 构建本轮可用的工具目录。
 *
 * 顺序：内置在前（它们是启动器自身能力，模型用得最多），插件按 id 排序在后
 * ——顺序固定，同样的问题每次下发的 tools 数组一致，便于缓存提示命中。
 */
export function buildToolCatalog(): ToolCatalog {
  const tools: ResolvedTool[] = []
  const used = new Set<string>()

  const claim = (wanted: string): string => {
    if (!used.has(wanted)) {
      used.add(wanted)
      return wanted
    }
    // 撞名（极少数：超长 id 截断后重合）时加序号，后到的让位
    let n = 2
    while (used.has(`${wanted}_${n}`)) n++
    const name = `${wanted}_${n}`
    used.add(name)
    return name
  }

  for (const tool of builtinTools) {
    tools.push({
      apiName: claim(apiToolName(tool.name)),
      fullName: tool.name,
      shortName: tool.name,
      title: tool.title,
      description: tool.description,
      risk: tool.risk,
      parameters: tool.parameters,
      timeoutMs: tool.timeoutMs,
      source: 'builtin',
      validate: tool.validate
    })
  }

  const plugins = grantedToolList().sort((a, b) => a.entry.fullName.localeCompare(b.entry.fullName))
  for (const { entry, validate } of plugins) {
    tools.push(fromPluginEntry(entry, validate, claim(apiToolName(entry.fullName))))
  }

  // MCP 工具排最后：它们来自外部进程，数量与名字都不受我们控制，
  // 放在后面可以保证「内置/插件工具一定拿到最自然的函数名」。
  for (const entry of mcpToolEntries()) {
    tools.push({
      apiName: claim(apiToolName(entry.fullName)),
      fullName: entry.fullName,
      shortName: entry.name,
      title: entry.title,
      description: entry.description,
      risk: entry.risk,
      parameters: entry.parameters,
      timeoutMs: entry.timeoutMs,
      source: 'mcp',
      pluginId: entry.pluginId,
      pluginName: entry.pluginName,
      server: entry.server,
      validate: entry.validate
    })
  }

  const byApiName = new Map<string, ResolvedTool>()
  for (const tool of tools) byApiName.set(tool.apiName, tool)
  return { tools, apiTools: tools.map(toApiTool), byApiName }
}

function fromPluginEntry(entry: AiToolEntry, validate: ToolValidator, apiName: string): ResolvedTool {
  return {
    apiName,
    fullName: entry.fullName,
    shortName: entry.name,
    title: entry.title,
    description: entry.description,
    risk: entry.risk,
    parameters: entry.parameters,
    timeoutMs: entry.timeoutMs,
    source: 'plugin',
    pluginId: entry.pluginId,
    pluginName: entry.pluginName,
    validate
  }
}
