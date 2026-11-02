/**
 * `ai/tools.json` 的解析与参数校验（v0.6.2）。
 *
 * 为什么用 ajv 而不是手写检查：`parameters` 是插件作者写的 JSON Schema，
 * 形状完全开放（嵌套对象、数组、枚举、oneOf 都可能出现）。手写检查只能覆盖
 * 一小撮，剩下的要么放过（模型给错的参数直接进插件代码）要么拒掉（合法工具用不了）。
 * ajv 是这一个格式的标准实现，编译一次、每次调用只跑一遍校验。
 *
 * 这里的错误一律「坏一个丢一个」：一份 tools.json 里有一个工具写错，
 * 不能连累同插件其它工具，更不能连累插件本身加载。
 */
import Ajv from 'ajv'
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  MAX_TOOLS_PER_PLUGIN,
  MAX_TOOL_DESCRIPTION,
  MAX_TOOL_TIMEOUT_MS,
  MIN_TOOL_TIMEOUT_MS,
  type AiToolRisk,
  type AiToolSpec
} from '../../shared/ai'

/**
 * 工具参数校验器：合法返回 null，不合法返回一句给模型看的原因。
 *
 * 直接返回字符串而不是布尔，是因为 v0.6.3 执行失败时要把原因回给模型
 * （它会照着改参数再试）；再让调用方自己掏 `errors` 容易忘，也容易把
 * ajv 那种带 schema 路径的长串原样丢进上下文。
 */
export type ToolValidator = (data: unknown) => string | null

export interface ToolsParseResult {
  tools: AiToolSpec[]
  /** 按工具短名索引的参数校验器（与 tools 一一对应） */
  validators: Map<string, ToolValidator>
  /** 被丢掉的内容与原因，展示在设置页与日志里 */
  errors: string[]
}

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,47}$/
const RISKS: AiToolRisk[] = ['read', 'write', 'dangerous']

/**
 * ajv 实例：`strict: false` 是为了容忍模型/作者常用的、严格模式不认的关键字
 * （`default`、`example`、`nullable` 之类）。宁可放过一个无害关键字，
 * 也不要让一份能用的 schema 因为写法宽松而整份编译失败。
 */
function createAjv(): Ajv {
  return new Ajv({ allErrors: true, strict: false, validateFormats: false })
}

/** 编译失败信息可能很长（带 schema 路径），截断到一句能读的话 */
function shortError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/\s+/g, ' ').slice(0, 200)
}

function normalizeRisk(raw: unknown, name: string, errors: string[]): AiToolRisk {
  if (raw === undefined || raw === null) {
    // 缺省按 write：漏写 risk 时弹一次确认，比默认放行安全。
    // 反过来（默认 read）等于让「忘写一行」变成静默放行，代价不可逆。
    return 'write'
  }
  if (typeof raw === 'string' && (RISKS as string[]).includes(raw)) return raw as AiToolRisk
  errors.push(`${name}: 未知的 risk ${JSON.stringify(raw)}，已按 write（需确认）处理`)
  return 'write'
}

function normalizeParameters(
  raw: unknown,
  name: string,
  compile: (schema: object) => ToolValidator,
  errors: string[]
): { schema: Record<string, unknown>; validator: ToolValidator } | null {
  if (raw === undefined || raw === null) {
    const empty = { type: 'object', properties: {} }
    return { schema: empty, validator: compile(empty) }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${name}: parameters 必须是 JSON Schema 对象`)
    return null
  }
  const schema = { ...(raw as Record<string, unknown>) }
  // 只给了 properties 没写 type 时补上：多数端点要求 parameters.type === 'object'，
  // 缺了会被服务端直接拒绝整条请求，而这属于写法瑕疵、不该整份工具作废
  if (schema.type === undefined) schema.type = 'object'
  try {
    return { schema, validator: compile(schema) }
  } catch (err) {
    errors.push(`${name}: parameters 不是合法的 JSON Schema（${shortError(err)}）`)
    return null
  }
}

/**
 * 解析一份 tools.json 的原始 JSON。
 *
 * 不读文件、不碰 fs：文件读写在 tools.ts，这里纯靠入参，单测能直接喂各种坏数据。
 */
export function parseToolsSpec(raw: unknown): ToolsParseResult {
  const result: ToolsParseResult = { tools: [], validators: new Map(), errors: [] }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    result.errors.push('tools.json 顶层必须是对象')
    return result
  }
  const root = raw as Record<string, unknown>
  if (root.version !== undefined && root.version !== 1) {
    result.errors.push(`不认识的 tools.json 版本 ${JSON.stringify(root.version)}（本版只支持 1）`)
    return result
  }
  if (!Array.isArray(root.tools)) {
    result.errors.push('tools 必须是数组')
    return result
  }

  const ajv = createAjv()
  const compile = (schema: object): ToolValidator => {
    const fn = ajv.compile(schema)
    return (data: unknown): string | null => {
      if (fn(data) === true) return null
      const first = fn.errors?.[0]
      if (!first) return '参数不符合 schema'
      const where = first.instancePath || '参数'
      return `${where} ${first.message ?? '不符合 schema'}`.slice(0, 300)
    }
  }

  const seen = new Set<string>()
  for (const [index, item] of root.tools.entries()) {
    if (result.tools.length >= MAX_TOOLS_PER_PLUGIN) {
      result.errors.push(`工具数超过上限 ${MAX_TOOLS_PER_PLUGIN}，其余已忽略`)
      break
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      result.errors.push(`第 ${index + 1} 项不是对象`)
      continue
    }
    const tool = item as Record<string, unknown>
    const name = typeof tool.name === 'string' ? tool.name.trim() : ''
    if (!TOOL_NAME_RE.test(name)) {
      result.errors.push(
        `第 ${index + 1} 项的 name 不合法（要小写字母开头、只含小写字母/数字/下划线、≤48 字符）：${JSON.stringify(tool.name)}`
      )
      continue
    }
    if (seen.has(name)) {
      result.errors.push(`${name}: 工具名重复，后一个已忽略`)
      continue
    }
    const description = typeof tool.description === 'string' ? tool.description.trim() : ''
    if (!description) {
      // 没有 description，模型无从判断何时该调它，等于没声明
      result.errors.push(`${name}: 缺少 description（模型靠它决定要不要调用）`)
      continue
    }
    const params = normalizeParameters(tool.parameters, name, compile, result.errors)
    if (!params) continue

    const timeoutRaw = typeof tool.timeoutMs === 'number' && Number.isFinite(tool.timeoutMs)
      ? tool.timeoutMs
      : DEFAULT_TOOL_TIMEOUT_MS
    const timeoutMs = Math.min(Math.max(Math.round(timeoutRaw), MIN_TOOL_TIMEOUT_MS), MAX_TOOL_TIMEOUT_MS)

    seen.add(name)
    result.tools.push({
      name,
      title: typeof tool.title === 'string' && tool.title.trim() ? tool.title.trim() : name,
      description: description.slice(0, MAX_TOOL_DESCRIPTION),
      risk: normalizeRisk(tool.risk, name, result.errors),
      timeoutMs,
      parameters: params.schema
    })
    result.validators.set(name, params.validator)
  }

  return result
}

/** 全局工具名：`plugin:<插件 id>:<工具短名>`。模型看到的就是它，反查也按它 */
export function toolFullName(pluginId: string, name: string): string {
  return `plugin:${pluginId}:${name}`
}
