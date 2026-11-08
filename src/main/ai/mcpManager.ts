/**
 * MCP 服务的解析、审批与生命周期（v0.6.4）。
 *
 * 与插件工具的分工：插件工具的执行端是插件页（已经在跑，只是要被叫醒），
 * MCP 工具的执行端是一个**我们亲手 spawn 的进程**。这带来三件插件工具没有的事：
 *
 * 1. **审批**。插件工具最多算「插件能做的事」，MCP server 是「能在你机器上执行的命令」。
 *    所以默认一个都不启动：用户必须在设置页看过完整 argv、点过允许，且指纹对得上。
 * 2. **惰性**。批准了也不立刻常驻：等真的要用工具时才 spawn（`ensureForChat`），
 *    否则装了十个 server 就等于开机起十个进程。
 * 3. **崩了不能一直拉起**。连续 `MCP_MAX_CRASHES` 次失败就本会话停用，
 *    否则一个配置错误的 server 会在每轮对话里重启一次，把 CPU 吃满。
 * 4. **空了要收**。聊完就一直挂着的话，`npx` 起的 node 会整天空占内存，
 *    所以空转 `MCP_IDLE_TIMEOUT_MS` 后收掉进程，下次对话再拉起。
 *
 * 状态全部从磁盘现算（声明的 mtime 指纹 + config 里的授权），只有「活着的进程」
 * 与「上次列出的工具」是内存态——重启后自然重新拉取，不存在缓存过期的问题。
 */
import { app } from 'electron'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getConfig, updateConfig } from '../config'
import {
  MCP_CONNECT_TIMEOUT_MS,
  MCP_FIRST_CONNECT_TIMEOUT_MS,
  MCP_IDLE_SWEEP_MS,
  MCP_MAX_CRASHES,
  mcpIdleExpired,
  type AiMcpServerView,
  type AiToolRisk
} from '../../shared/ai'
import { listPlugins, type PluginRecord } from '../plugin/manager'
import { isPluginGranted, setToolGrant } from './tools'
import { McpStdioClient, type McpToolInfo } from './mcpClient'
import {
  approvalKey,
  commandLine,
  mcpToolFullName,
  parseMcpSpec,
  riskOfMcpTool,
  serverFingerprint,
  type McpServerSpec,
  type McpSpecParseResult
} from './mcpSpec'
import { compileToolSchema, type ToolValidator } from './toolsSpec'

/** 一个已声明（且可能已启动）的 server 的运行时 */
interface Runtime {
  pluginId: string
  pluginName: string
  pluginDir: string
  spec: McpServerSpec
  fingerprint: string
  client: McpStdioClient | null
  tools: McpToolInfo[]
  validators: Map<string, ToolValidator>
  /** 正在建连的 Promise：并发请求共用一次建连，不重复 spawn */
  connecting: Promise<void> | null
  /** 连续失败次数；成功执行一次工具才清零 */
  crashes: number
  disabled: boolean
  /** 这次会话里成功连上过：用来决定下次建连给常规预算还是首次预算 */
  everConnected: boolean
  /** 最后一次用它的时刻（连上或调用完），空闲回收按它判 */
  lastUsedAt: number
  /** 正在飞的工具调用数：有调用在跑时不能收进程 */
  activeCalls: number
  lastError?: string
}

/** 磁盘声明的缓存（mtime+size 变了才重读） */
interface DeclCache {
  key: string
  parsed: McpSpecParseResult
}

const declCache = new Map<string, DeclCache>()
/** key = `pluginId::server` */
const runtimes = new Map<string, Runtime>()

// ---------------------------------------------------------------- 声明读取

function fileKey(file: string): string {
  try {
    const st = statSync(file)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return ''
  }
}

function loadDeclarations(rec: PluginRecord): McpSpecParseResult {
  const meta = rec.manifest.ai
  if (!meta?.mcp) return { servers: [], errors: [] }
  const file = join(rec.dir, meta.mcp)
  const key = fileKey(file)
  const cached = declCache.get(rec.manifest.id)
  if (cached && cached.key === key) return cached.parsed

  let parsed: McpSpecParseResult
  if (!key) {
    parsed = { servers: [], errors: [`读不到 ${meta.mcp}`] }
  } else {
    try {
      parsed = parseMcpSpec(JSON.parse(readFileSync(file, 'utf-8')))
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      parsed = { servers: [], errors: [`${meta.mcp} 读不出来：${reason.slice(0, 120)}`] }
    }
  }
  if (parsed.errors.length) {
    console.warn(`[mcp] ${rec.manifest.id} 的 mcp.json 有 ${parsed.errors.length} 处问题`)
  }
  declCache.set(rec.manifest.id, { key, parsed })
  return parsed
}

interface Declared {
  rec: PluginRecord
  spec: McpServerSpec
  fingerprint: string
}

/**
 * 当前「该被考虑」的 server：插件声明了 mcp、有 ai 权限、未被停用。
 * 授权与审批状态不在这里过滤——设置页需要看到未批准的条目。
 */
function declaredServers(): { list: Declared[]; errors: { pluginId: string; pluginName: string; errors: string[] }[] } {
  const list: Declared[] = []
  const errors: { pluginId: string; pluginName: string; errors: string[] }[] = []
  for (const rec of listPlugins()) {
    if (!rec.manifest.ai?.mcp || rec.disabled) continue
    if (!(rec.manifest.permissions ?? []).includes('ai')) {
      errors.push({
        pluginId: rec.manifest.id,
        pluginName: rec.manifest.name,
        errors: ['插件没有声明 permissions: ["ai"]，MCP server 不会启动']
      })
      continue
    }
    const parsed = loadDeclarations(rec)
    if (parsed.errors.length) {
      errors.push({ pluginId: rec.manifest.id, pluginName: rec.manifest.name, errors: parsed.errors })
    }
    for (const spec of parsed.servers) {
      list.push({ rec, spec, fingerprint: serverFingerprint(spec) })
    }
  }
  return { list, errors }
}

// ---------------------------------------------------------------- 审批

type ApprovalRecord = { fp: string; allow: boolean }

function approvals(): Record<string, ApprovalRecord> {
  return (getConfig().aiMcpApprovals ?? {}) as Record<string, ApprovalRecord>
}

function approvalOf(pluginId: string, server: string): ApprovalRecord | undefined {
  return approvals()[approvalKey(pluginId, server)]
}

function stateOf(pluginId: string, server: string, fingerprint: string): AiMcpServerView['state'] {
  const rt = runtimes.get(approvalKey(pluginId, server))
  if (rt?.disabled) return 'disabled'
  const record = approvalOf(pluginId, server)
  if (!record) return 'pending'
  // 指纹不一致 = 命令被改过。旧批准不能顺延到新命令上，这是整个确认机制的核心
  if (record.fp !== fingerprint) return 'stale'
  return record.allow ? 'approved' : 'rejected'
}

/** 该 server 是否现在就能用（已批准、插件被授权、且没被停用） */
function isUsable(pluginId: string, server: string, fingerprint: string): boolean {
  // 插件级授权也是一道闸：用户在「AI 工具」里关掉某个插件，是「别让它参与 AI」的意思，
  // 只关工具而 MCP 还在跑会让人以为关错了地方。
  return stateOf(pluginId, server, fingerprint) === 'approved' && isPluginGranted(pluginId)
}

/**
 * 设置页的清单。
 *
 * 这里**不过滤未批准的条目**：用户得先看见「有个插件想执行这条命令」，
 * 才谈得上决定要不要允许。
 */
export function listMcpServers(): AiMcpServerView[] {
  const { list, errors } = declaredServers()
  const out: AiMcpServerView[] = []
  const errorsByPlugin = new Map<string, string[]>()
  for (const err of errors) errorsByPlugin.set(err.pluginId, [...(errorsByPlugin.get(err.pluginId) ?? []), ...err.errors])

  for (const { rec, spec, fingerprint } of list) {
    const key = approvalKey(rec.manifest.id, spec.name)
    const rt = runtimes.get(key)
    const declErrors = errorsByPlugin.get(rec.manifest.id)
    const state = stateOf(rec.manifest.id, spec.name, fingerprint)
    const rowErrors: string[] = []
    // 命令批了但插件被撤销授权：工具不会下发，这行说明比「明明允许了却用不了」强
    if (state === 'approved' && !isPluginGranted(rec.manifest.id)) {
      rowErrors.push('插件的 AI 授权已关闭，工具不会下发给模型')
    }
    out.push({
      pluginId: rec.manifest.id,
      pluginName: rec.manifest.name,
      server: spec.name,
      commandLine: commandLine(spec),
      command: spec.command,
      args: spec.args,
      envKeys: Object.keys(spec.env),
      cwd: spec.cwd ?? '',
      timeoutMs: spec.timeoutMs,
      state,
      toolCount: rt?.tools.length ?? 0,
      running: rt?.client?.isRunning === true,
      ...(rt?.lastError ? { error: rt.lastError } : {}),
      errors: rowErrors
    })
    // 声明级错误只挂在第一个 server 行上，避免同一段话重复 N 遍
    if (out.length && declErrors) {
      out[out.length - 1].errors = [...out[out.length - 1].errors, ...declErrors]
      errorsByPlugin.delete(rec.manifest.id)
    }
  }

  // 插件声明了 mcp 但一个 server 都没解析出来：也要让用户看见「声明坏了」
  for (const [pluginId, list] of errorsByPlugin) {
    const name = errors.find((e) => e.pluginId === pluginId)?.pluginName ?? pluginId
    out.push({
      pluginId,
      pluginName: name,
      server: '(无可用 server)',
      commandLine: '',
      command: '',
      args: [],
      envKeys: [],
      cwd: '',
      timeoutMs: 0,
      state: 'pending',
      toolCount: 0,
      running: false,
      errors: list
    })
  }

  return out
}

/**
 * 用户对一条命令做出决定。
 *
 * 允许时立刻建连：这是用户唯一一次「主动要求它跑起来」的机会，
 * 在这里等几秒拿到工具清单，比在对话里第一次调用时才等要好。
 */
export async function decideMcpServer(
  pluginId: string,
  server: string,
  allow: boolean
): Promise<{ ok: boolean; message?: string }> {
  const { list } = declaredServers()
  const target = list.find((d) => d.rec.manifest.id === pluginId && d.spec.name === server)
  if (!target) return { ok: false, message: '这个 MCP server 已经不存在了（插件可能被卸载或改了声明）' }

  const key = approvalKey(pluginId, server)
  const next = { ...approvals(), [key]: { fp: target.fingerprint, allow } }
  updateConfig({ aiMcpApprovals: next })

  // 允许这条命令 = 允许这个插件参与 AI。顺手把它在「AI 工具」里的开关打开，
  // 否则用户会遇到「命令批了但工具还是不出现，还得去另一个地方再开一次」。
  if (allow && !isPluginGranted(pluginId)) setToolGrant(pluginId, true)

  const rt = runtimeFor(target)
  if (!allow) {
    // 拒绝时顺手把已在跑的进程收掉：撤销授权必须是立即生效的
    await shutdownRuntime(rt)
    return { ok: true }
  }

  rt.crashes = 0
  rt.disabled = false
  rt.lastError = undefined
  try {
    await connectRuntime(rt)
    return { ok: true }
  } catch (err) {
    // 批准成功但起不来：如实回报。批准记录保留，用户修好命令后不必再点一次
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 「重新尝试」：清掉停用标记再连一次。
 *
 * 停用只是本会话的保护（避免崩-拉-崩），不该变成"必须重启应用"的死结：
 * 用户改好依赖、连上网之后，得有个地方能立刻试。
 */
export async function retryMcpServer(
  pluginId: string,
  server: string
): Promise<{ ok: boolean; message?: string }> {
  const { list } = declaredServers()
  const target = list.find((d) => d.rec.manifest.id === pluginId && d.spec.name === server)
  if (!target) return { ok: false, message: '这个 MCP server 已经不存在了（插件可能被卸载或改了声明）' }
  if (!isUsable(pluginId, server, target.fingerprint)) {
    return { ok: false, message: '这个 server 还没被允许（或命令改过），先允许一次再试' }
  }

  const rt = runtimeFor(target)
  rt.crashes = 0
  rt.disabled = false
  rt.lastError = undefined
  await shutdownRuntime(rt)
  try {
    await connectRuntime(rt)
    return { ok: true, message: `已连接，${rt.tools.length} 个工具` }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

export function clearMcpCache(): void {
  declCache.clear()
}

// ---------------------------------------------------------------- 运行时

function runtimeFor(decl: Declared): Runtime {
  const key = approvalKey(decl.rec.manifest.id, decl.spec.name)
  const existing = runtimes.get(key)
  if (existing) {
    // 命令被改过：旧进程按旧命令跑着，必须换掉
    if (existing.fingerprint !== decl.fingerprint) {
      void shutdownRuntime(existing)
      const fresh = makeRuntime(decl)
      runtimes.set(key, fresh)
      return fresh
    }
    return existing
  }
  const rt = makeRuntime(decl)
  runtimes.set(key, rt)
  return rt
}

function makeRuntime(decl: Declared): Runtime {
  return {
    pluginId: decl.rec.manifest.id,
    pluginName: decl.rec.manifest.name,
    pluginDir: decl.rec.dir,
    spec: decl.spec,
    fingerprint: decl.fingerprint,
    client: null,
    tools: [],
    validators: new Map(),
    connecting: null,
    crashes: 0,
    disabled: false,
    everConnected: false,
    lastUsedAt: 0,
    activeCalls: 0
  }
}

async function shutdownRuntime(rt: Runtime): Promise<void> {
  const client = rt.client
  rt.client = null
  rt.tools = []
  rt.validators.clear()
  if (client) await client.close()
}

/* ---------------------------------------------------------------- 空闲回收 */

let sweepTimer: ReturnType<typeof setInterval> | null = null

/**
 * 空转的 MCP 进程定时收掉。
 *
 * 不在每次调用里现扫：真正的场景是「聊完就不管了」，那时候没有任何调用可以
 * 顺带触发检查。定时器只在第一个 server 连上后才开，`unref` 掉——不能为了
 * 一个清理任务把主进程钉在事件循环里。
 */
function sweepIdle(): void {
  const now = Date.now()
  for (const rt of runtimes.values()) {
    const state = {
      running: rt.client?.isRunning === true,
      connecting: rt.connecting !== null,
      disabled: rt.disabled,
      activeCalls: rt.activeCalls,
      lastUsedAt: rt.lastUsedAt
    }
    if (!mcpIdleExpired(state, now)) continue
    console.log(
      `[mcp] ${rt.pluginName}/${rt.spec.name} 空转 ${Math.round((now - rt.lastUsedAt) / 60_000)} 分钟，收掉进程`
    )
    void shutdownRuntime(rt)
  }
}

function ensureSweep(): void {
  if (sweepTimer) return
  sweepTimer = setInterval(sweepIdle, MCP_IDLE_SWEEP_MS)
  sweepTimer.unref?.()
}

function stopSweep(): void {
  if (!sweepTimer) return
  clearInterval(sweepTimer)
  sweepTimer = null
}

/**
 * 建立连接并列出工具。
 *
 * 建连失败一次就记一次失败：命令写错、依赖没装、端口被占，都会走到这里。
 * 达到上限就停用——继续重试只会让每次对话都卡一个超时。
 */
async function connectRuntime(rt: Runtime): Promise<void> {
  if (rt.disabled) throw new Error(`「${rt.spec.name}」已因连续失败停用（重启应用后恢复）`)
  if (rt.client?.isRunning) return
  if (rt.connecting) return rt.connecting

  // 首次可能要下载依赖（npx），给更宽的预算；连上过之后就按常规超时
  const budget = rt.everConnected ? MCP_CONNECT_TIMEOUT_MS : MCP_FIRST_CONNECT_TIMEOUT_MS

  const task = (async () => {
    const client = new McpStdioClient(rt.spec, {
      clientName: 'QuickLauncher',
      clientVersion: app.getVersion(),
      cwd: rt.spec.cwd ? join(rt.pluginDir, rt.spec.cwd) : rt.pluginDir,
      connectTimeoutMs: budget
    })
    try {
      await client.connect()
      const tools = await client.listTools(budget)

      const validators = new Map<string, ToolValidator>()
      const kept: McpToolInfo[] = []
      for (const tool of tools) {
        const compiled = compileToolSchema(tool.inputSchema ?? { type: 'object', properties: {} })
        // schema 编不出来只丢这一个工具：MCP server 的 inputSchema 五花八门，
        // 有一个写得不标准不该让整台服务器不可用
        if (!compiled) continue
        validators.set(tool.name, compiled.validator)
        kept.push(tool)
      }

      rt.client = client
      rt.tools = kept
      rt.validators = validators
      rt.everConnected = true
      rt.crashes = 0
      rt.lastUsedAt = Date.now()
      rt.lastError = undefined
      ensureSweep()
      console.log(`[mcp] ${rt.pluginName}/${rt.spec.name} 已连接，${kept.length} 个工具`)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      const tail = client.logs
      rt.client = null
      rt.tools = []
      rt.validators.clear()
      rt.crashes++
      rt.lastError = tail ? `${reason}（${tail.split('\n').slice(-2).join(' / ').slice(0, 300)}）` : reason
      // 从没连上过又超时：最可能是 npx 正在下载依赖。说清楚，别让人以为命令写错了
      if (!rt.everConnected && /timed? ?out|超时/i.test(reason)) {
        rt.lastError = `${rt.lastError} — 首次启动可能正在下载依赖，稍后可在设置页点「重新尝试」`
      }
      if (rt.crashes >= MCP_MAX_CRASHES) {
        rt.disabled = true
        rt.lastError = `${rt.lastError} — 连续失败 ${rt.crashes} 次，本会话已停用`
      }
      await client.close()
      throw new Error(rt.lastError)
    } finally {
      rt.connecting = null
    }
  })()

  rt.connecting = task
  return task
}

/**
 * 对话开始前调用：把**已批准**的 server 准备好，总量控制在 `budgetMs` 内。
 *
 * 不给预算会拖慢每一条消息（尤其某个 server 卡在握手时）。
 * 超预算的 server 本轮就是不出现——模型少一个工具照样能答，
 * 但用户等 20 秒才看到第一个字是明显的坏体验。
 */
export async function ensureForChat(budgetMs: number): Promise<void> {
  const { list } = declaredServers()
  const targets = list.filter((d) => isUsable(d.rec.manifest.id, d.spec.name, d.fingerprint))
  if (!targets.length) return

  const tasks = targets.map(async (decl) => {
    const rt = runtimeFor(decl)
    if (rt.client?.isRunning || rt.disabled) return
    try {
      await connectRuntime(rt)
    } catch {
      // 失败已记在 rt.lastError 里，这里不打断对话
    }
  })

  if (!tasks.length) return
  await Promise.race([
    Promise.allSettled(tasks),
    new Promise<void>((resolve) => setTimeout(resolve, budgetMs).unref?.())
  ])
}

/** 是否有任何已批准的 server（给 chat 用，避免每轮都算一遍全量声明） */
export function hasApprovedServers(): boolean {
  const { list } = declaredServers()
  return list.some((d) => isUsable(d.rec.manifest.id, d.spec.name, d.fingerprint))
}

/** 目录要用的形态（catalog 自己再算下发用的函数名） */
export interface McpToolEntry {
  pluginId: string
  pluginName: string
  server: string
  name: string
  fullName: string
  title: string
  description: string
  risk: AiToolRisk
  parameters: Record<string, unknown>
  timeoutMs: number
  validate: ToolValidator
}

/**
 * 当前可下发的 MCP 工具。
 *
 * 只取**已经连上**的 server：没连上就没有工具清单，现造不出来。
 * 这也是为什么 `ensureForChat` 要在建目录之前跑。
 */
export function mcpToolEntries(): McpToolEntry[] {
  const out: McpToolEntry[] = []
  for (const rt of runtimes.values()) {
    if (!rt.client?.isRunning || rt.disabled) continue
    if (!isUsable(rt.pluginId, rt.spec.name, rt.fingerprint)) continue

    for (const tool of rt.tools) {
      const validate = rt.validators.get(tool.name)
      if (!validate) continue
      const schema = (tool.inputSchema ?? {}) as Record<string, unknown>
      out.push({
        pluginId: rt.pluginId,
        pluginName: rt.pluginName,
        server: rt.spec.name,
        name: tool.name,
        fullName: mcpToolFullName(rt.pluginId, rt.spec.name, tool.name),
        title: tool.title ?? tool.name,
        description: (tool.description || `${rt.pluginName} 提供的 ${tool.name}`).slice(0, 500),
        risk: riskOfMcpTool(tool.annotations),
        parameters: schema.type === undefined ? { ...schema, type: 'object' } : schema,
        timeoutMs: rt.spec.timeoutMs,
        validate
      })
    }
  }
  return out.sort((a, b) => a.fullName.localeCompare(b.fullName))
}

/** 执行一次 MCP 工具调用。失败一律返回原因，不抛给上层编排 */
export async function callMcpTool(
  pluginId: string,
  server: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<{ ok: boolean; text: string; error?: string }> {
  const rt = runtimes.get(approvalKey(pluginId, server))
  if (!rt) return { ok: false, text: '', error: `MCP server ${server} 没有在运行` }
  if (rt.disabled) return { ok: false, text: '', error: `MCP server ${server} 已停用` }

  try {
    if (!rt.client?.isRunning) {
      // 进程在两次调用之间死掉了（被外部杀掉、OOM、自己退出）：
      // 这次重连一次再调，而不是让模型看到「服务不存在」这种误导性的错误
      rt.crashes++
      if (rt.crashes >= MCP_MAX_CRASHES) {
        rt.disabled = true
        return {
          ok: false,
          text: '',
          error: `MCP server ${server} 连续 ${rt.crashes} 次异常，本会话已停用：${rt.lastError ?? '原因未知'}`
        }
      }
      await connectRuntime(rt)
    }
    const client = rt.client
    if (!client) return { ok: false, text: '', error: `MCP server ${server} 没连上` }

    // 在飞期间挡住空闲回收：一次工具调用可能跑几十秒（浏览器抓取、构建），
    // 收掉进程等于把这次调用连结果一起丢了
    rt.activeCalls++
    try {
      const result = await client.callTool(toolName, args, timeoutMs)
      if (result.ok) rt.crashes = 0
      else if (!client.isRunning) rt.crashes++
      return result
    } finally {
      rt.activeCalls--
      rt.lastUsedAt = Date.now()
    }
  } catch (err) {
    return { ok: false, text: '', error: err instanceof Error ? err.message : String(err) }
  }
}

/** 应用退出时收掉所有子进程（否则 npx 起的 node 会变成孤儿） */
export async function shutdownMcp(): Promise<void> {
  stopSweep()
  const all = [...runtimes.values()]
  runtimes.clear()
  await Promise.allSettled(all.map((rt) => shutdownRuntime(rt)))
}
