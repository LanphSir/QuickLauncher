/**
 * `ai/mcp.json` 的解析、校验与命令指纹（v0.6.4）。
 *
 * 这个文件处理的是**最危险的一类声明**：插件让启动器替它执行一条命令。
 * 因此三件事必须做得比 tools.json 更严：
 *
 * 1. **不经过 shell**。`command` 与 `args` 分开存，执行端用 `spawn(cmd, args, {shell:false})`，
 *    于是 `args: ["a; rm -rf /"]` 只是一个普通参数，不是命令拼接。这里只要拒绝
 *    形状不对的输入，不必去做「危险字符」正则——那种正则永远漏。
 *
 * 2. **确认绑定到指纹**。用户批准的是「这条命令」，不是「这个服务器名」。
 *    指纹取 `command + args + env + cwd` 的 sha256：改了任何一个字符都要重新问。
 *
 * 3. **错误坏一个丢一个**，与 tools.json 同一条原则——一个 server 写错不该
 *    连累同插件其它 server，更不该连累插件本身。
 *
 * 纯函数、不 import electron：单测可以直接跑。
 */
import { createHash } from 'node:crypto'
import {
  DEFAULT_MCP_CALL_TIMEOUT_MS,
  MAX_MCP_ARG_CHARS,
  MAX_MCP_ARGS,
  MAX_MCP_ENV,
  MAX_MCP_SERVERS_PER_PLUGIN,
  MAX_MCP_TIMEOUT_MS,
  MIN_MCP_TIMEOUT_MS,
  type AiToolRisk
} from '../../shared/ai'

/** 一个 server 的启动描述（已校验） */
export interface McpServerSpec {
  /** 插件内唯一，用于工具命名空间与授权键 */
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  /** 相对插件目录的 cwd；缺省用插件目录 */
  cwd?: string
  /** 单次 tools/call 的超时 */
  timeoutMs: number
}

export interface McpSpecParseResult {
  servers: McpServerSpec[]
  errors: string[]
}

/**
 * server 名：小写字母开头，只含 `a-z0-9_-`。
 *
 * 它会被拼进工具全局名（`mcp:<插件 id>:<server>:<tool>`），也必须能安全落进
 * config 的授权 key（`pluginId::server`）。限制字符集比事后转义可靠。
 */
const SERVER_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function short(text: unknown, max = 120): string {
  return String(text ?? '').replace(/\s+/g, ' ').slice(0, max)
}

/**
 * 校验 `cwd`：只能是插件目录内的相对路径。
 *
 * 允许 `..` 等于让插件把服务器的工作目录设到用户主目录，配合它能执行的命令，
 * 等于把「插件自带文件」变成「任意位置」。与 manifest 里 tools/skill 路径同一套口径。
 */
function safeRelativeCwd(raw: unknown): { ok: true; value?: string } | { ok: false; reason: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true }
  if (typeof raw !== 'string') return { ok: false, reason: 'cwd 必须是字符串' }
  const value = raw.trim().replace(/\\/g, '/')
  if (!value) return { ok: true }
  if (/^[A-Za-z]:/.test(value) || value.startsWith('/')) {
    return { ok: false, reason: `cwd 必须是插件目录内的相对路径，不能是绝对路径：${short(value)}` }
  }
  if (value.split('/').includes('..')) {
    return { ok: false, reason: `cwd 不能跳出插件目录：${short(value)}` }
  }
  return { ok: true, value }
}

function parseEnv(raw: unknown, name: string, errors: string[]): Record<string, string> {
  if (raw === undefined || raw === null) return {}
  if (!isRecord(raw)) {
    errors.push(`${name}：env 必须是对象`)
    return {}
  }
  const entries = Object.entries(raw)
  if (entries.length > MAX_MCP_ENV) {
    errors.push(`${name}：env 最多 ${MAX_MCP_ENV} 项，多出的已忽略`)
  }
  const out: Record<string, string> = {}
  let dropped = 0
  for (const [key, value] of entries.slice(0, MAX_MCP_ENV)) {
    if (!ENV_KEY_RE.test(key)) {
      dropped++
      continue
    }
    if (typeof value === 'string') out[key] = value
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value)
    else dropped++
  }
  if (dropped) errors.push(`${name}：env 有 ${dropped} 项键名或值不合法，已忽略`)
  return out
}

function parseArgs(raw: unknown, name: string, errors: string[]): string[] | null {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    errors.push(`${name}：args 必须是字符串数组`)
    return null
  }
  if (raw.length > MAX_MCP_ARGS) {
    errors.push(`${name}：args 最多 ${MAX_MCP_ARGS} 项`)
    return null
  }
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') {
      errors.push(`${name}：args 里每一项都必须是字符串`)
      return null
    }
    if (item.length > MAX_MCP_ARG_CHARS) {
      errors.push(`${name}：单个参数超过 ${MAX_MCP_ARG_CHARS} 字符`)
      return null
    }
    out.push(item)
  }
  return out
}

/**
 * 解析一份 mcp.json。
 *
 * 接受两种写法：`{ servers: [...] }`（推荐）与裸数组 `[...]`（手写方便）。
 * 别的一种都不认——形状宽松只会让错误更晚暴露。
 */
export function parseMcpSpec(raw: unknown): McpSpecParseResult {
  const errors: string[] = []
  let list: unknown[] = []

  if (Array.isArray(raw)) {
    list = raw
  } else if (isRecord(raw) && Array.isArray(raw.servers)) {
    list = raw.servers
  } else {
    return { servers: [], errors: ['mcp.json 需要 { "servers": [...] } 或一个数组'] }
  }

  if (list.length > MAX_MCP_SERVERS_PER_PLUGIN) {
    errors.push(`最多声明 ${MAX_MCP_SERVERS_PER_PLUGIN} 个 MCP server，多出的已忽略`)
  }

  const servers: McpServerSpec[] = []
  const seen = new Set<string>()

  for (const item of list.slice(0, MAX_MCP_SERVERS_PER_PLUGIN)) {
    if (!isRecord(item)) {
      errors.push('有一项不是对象，已忽略')
      continue
    }
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    if (!SERVER_NAME_RE.test(name)) {
      errors.push(`server 名不合法（小写字母开头，只含 a-z0-9_-，≤32）：${short(name) || '(空)'}`)
      continue
    }
    if (seen.has(name)) {
      errors.push(`server 名重复：${name}`)
      continue
    }

    const command = typeof item.command === 'string' ? item.command.trim() : ''
    if (!command) {
      errors.push(`${name}：缺少 command`)
      continue
    }
    if (command.length > 512) {
      errors.push(`${name}：command 太长`)
      continue
    }

    const args = parseArgs(item.args, name, errors)
    if (args === null) continue

    const cwd = safeRelativeCwd(item.cwd)
    if (cwd.ok === false) {
      errors.push(`${name}：${cwd.reason}`)
      continue
    }

    const rawTimeout = typeof item.timeoutMs === 'number' && Number.isFinite(item.timeoutMs)
      ? item.timeoutMs
      : DEFAULT_MCP_CALL_TIMEOUT_MS
    const timeoutMs = Math.min(Math.max(Math.round(rawTimeout), MIN_MCP_TIMEOUT_MS), MAX_MCP_TIMEOUT_MS)

    seen.add(name)
    servers.push({
      name,
      command,
      args,
      env: parseEnv(item.env, name, errors),
      ...(cwd.value ? { cwd: cwd.value } : {}),
      timeoutMs
    })
  }

  return { servers, errors }
}

/**
 * 命令指纹：用户批准的是这串字符，不是这个名字。
 *
 * 包含 env 但不包含 timeoutMs——超时是本地策略，改它不该让用户重新确认一次执行授权。
 * 键排序后再序列化，避免同一份配置因键顺序不同算出不同指纹。
 */
export function serverFingerprint(spec: McpServerSpec): string {
  const env = Object.keys(spec.env)
    .sort()
    .map((key) => [key, spec.env[key]])
  const payload = JSON.stringify({
    command: spec.command,
    args: spec.args,
    env,
    cwd: spec.cwd ?? ''
  })
  return createHash('sha256').update(payload).digest('hex').slice(0, 32)
}

/** 授权键：插件 id + server 名，落 config 用 */
export function approvalKey(pluginId: string, server: string): string {
  return `${pluginId}::${server}`
}

/** 工具的全局名：插件 id 也进名字，两个插件可以各自声明同名 server 而不打架 */
export function mcpToolFullName(pluginId: string, server: string, tool: string): string {
  return `mcp:${pluginId}:${server}:${tool}`
}

/** MCP 工具的危险等级：优先看服务端给的注解，没有注解按 write（需确认） */
export function riskOfMcpTool(annotations: unknown): AiToolRisk {
  if (!isRecord(annotations)) return 'write'
  // 破坏性优先：同时标了 readOnly 与 destructive 的服务器是自相矛盾的，
  // 这种时候按更危险的那个算。
  if (annotations.destructiveHint === true) return 'dangerous'
  if (annotations.readOnlyHint === true) return 'read'
  return 'write'
}

/** 界面上展示的完整命令行（一行），用于确认弹窗与设置页 */
export function commandLine(spec: McpServerSpec): string {
  const quote = (part: string): string => (/[\s"]/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part)
  return [spec.command, ...spec.args].map(quote).join(' ')
}
