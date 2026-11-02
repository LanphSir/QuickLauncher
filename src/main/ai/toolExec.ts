/**
 * 执行一次工具调用：解析 → 校验 → 确认 → 执行 → 审计。
 *
 * 顺序不能换。参数没校验就弹确认框，用户看到的是「允许它去执行一段乱七八糟的东西」；
 * 先确认再校验，则会出现「用户点了允许，然后被告知参数不合法」——两头都让人不敢用。
 *
 * 另一条原则：**任何失败都必须变成 tool 结果回给模型**，而不是抛出去结束这一轮。
 * 模型拿到「超时了」「插件报错了」还能换个办法；直接断掉对话，用户只看到一句报错。
 */
import type { AiStreamEvent, AiToolCallPart, AiToolResultPart, AiToolRisk } from '../../shared/ai'
import { MAX_TOOL_ARGS_CHARS, MAX_TOOL_RESULT_CHARS } from '../../shared/ai'
import { writeAudit } from './audit'
import { findBuiltinTool } from './builtinTools'
import { askConfirm, needsConfirm } from './confirm'
import { callPluginTool } from './toolHost'
import { callMcpTool } from './mcpManager'
import type { ResolvedTool, ToolCatalog } from './toolCatalog'
import type { RawToolCall } from './toolCalls'

export interface ExecuteContext {
  catalog: ToolCatalog
  sessionId: string
  messageId: string
  notify(event: AiStreamEvent): void
  /** 用户点停止：正在等的确认/执行要尽快收尾 */
  signal: AbortSignal
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…（结果过长，已截断，原文 ${text.length} 字）`
}

/** 把任意错误压成一句给模型看的原因 */
function reasonOf(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * 把模型的调用翻成界面与落档要用的 part。
 * 找不到工具（模型编了个名字）时也要给一个 part —— 否则界面上这次调用会凭空消失。
 */
export function describeCall(catalog: ToolCatalog, raw: RawToolCall): AiToolCallPart {
  const tool = catalog.byApiName.get(raw.apiName)
  return {
    type: 'tool_call',
    callId: raw.id,
    apiName: raw.apiName,
    fullName: tool?.fullName ?? raw.apiName,
    title: tool?.title ?? raw.apiName,
    args: raw.argsText.slice(0, MAX_TOOL_ARGS_CHARS),
    risk: tool?.risk ?? 'write',
    ...(tool?.pluginId ? { pluginId: tool.pluginId } : {}),
    ...(tool?.pluginName ? { pluginName: tool.pluginName } : {})
  }
}

/** 解析参数：模型偶尔会给空串、给带注释的 JSON、给双重编码的字符串 */
function parseArgs(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const raw = text.trim()
  if (!raw) return { ok: true, value: {} }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    // 少数模型会把参数再包一层字符串：`"{\"a\":1}"`
    try {
      value = JSON.parse(JSON.parse(raw))
    } catch {
      return { ok: false, error: `参数不是合法的 JSON：${raw.slice(0, 120)}` }
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: '参数必须是一个 JSON 对象' }
  }
  return { ok: true, value: value as Record<string, unknown> }
}

/** 给内置工具加超时：它们都是同步/await 的本地操作，卡住基本意味着出事了 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 执行超时（${timeoutMs}ms）`)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

async function runTool(
  tool: ResolvedTool,
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<{ ok: boolean; text: string; error?: string }> {
  if (tool.source === 'builtin') {
    const builtin = findBuiltinTool(tool.fullName)
    if (!builtin) return { ok: false, text: '', error: '内置工具未注册' }
    try {
      const result = await withTimeout(Promise.resolve(builtin.run(args)), timeoutMs, tool.title)
      return { ok: result.ok, text: result.text, ...(result.ok ? {} : { error: result.text }) }
    } catch (err) {
      return { ok: false, text: '', error: reasonOf(err) }
    }
  }
  if (tool.source === 'mcp') {
    if (!tool.pluginId || !tool.server) return { ok: false, text: '', error: 'MCP 工具缺少归属信息' }
    // MCP 侧超时由 client 自己的 request 计时器管，这里不再包一层：
    // 两层超时只会让人分不清是谁放弃的
    return callMcpTool(tool.pluginId, tool.server, tool.shortName, args, timeoutMs)
  }
  const plugin = tool.pluginId
  if (!plugin) return { ok: false, text: '', error: '工具缺少插件归属' }
  const result = await callPluginTool(plugin, tool.shortName, args, timeoutMs)
  return { ok: result.ok, text: result.text, ...(result.error ? { error: result.error } : {}) }
}

/**
 * 执行一次调用。无论成功失败，都会先发 tool-result 事件再返回，
 * 保证界面与落档的数据来自同一份结果。
 */
export async function executeToolCall(ctx: ExecuteContext, raw: RawToolCall): Promise<AiToolResultPart> {
  const startedAt = Date.now()
  const tool = ctx.catalog.byApiName.get(raw.apiName)

  const fail = (error: string, extra: { confirm?: 'denied' | 'timeout'; auditRisk?: AiToolRisk } = {}): AiToolResultPart => {
    const result: AiToolResultPart = {
      type: 'tool_result',
      callId: raw.id,
      ok: false,
      text: '',
      error: clip(error, MAX_TOOL_RESULT_CHARS),
      durationMs: Date.now() - startedAt
    }
    writeAudit({
      sessionId: ctx.sessionId,
      messageId: ctx.messageId,
      tool: tool?.fullName ?? raw.apiName,
      source: tool?.source ?? 'builtin',
      ...(tool?.pluginId ? { pluginId: tool.pluginId } : {}),
      risk: extra.auditRisk ?? tool?.risk ?? 'write',
      args: raw.argsText,
      ok: false,
      ...(extra.confirm ? { confirm: extra.confirm } : {}),
      durationMs: result.durationMs ?? Date.now() - startedAt,
      error: result.error
    })
    ctx.notify({ type: 'tool-result', sessionId: ctx.sessionId, messageId: ctx.messageId, result })
    return result
  }

  if (!tool) {
    // 模型编了个不存在的函数名：告诉它有哪些名字可用，比「未知工具」有用得多
    return fail(`没有名为 ${raw.apiName} 的工具。可用工具：${ctx.catalog.tools.map((t) => t.apiName).join('、')}`)
  }

  const parsed = parseArgs(raw.argsText)
  if (!parsed.ok) return fail(parsed.error)

  // 校验器给的是「给模型看的原因」，原样回传，它照着改参数往往就能过
  const invalid = tool.validate(parsed.value)
  if (invalid) return fail(`参数不符合要求：${invalid}`)

  let confirmKind: 'allowed' | 'denied' | 'timeout' | 'not-required' = 'not-required'
  if (needsConfirm(tool.risk, ctx.sessionId, tool.fullName)) {
    if (ctx.signal.aborted) return fail('本次生成已停止，工具调用被取消')
    const decision = await askConfirm(
      { sessionId: ctx.sessionId, messageId: ctx.messageId, notify: ctx.notify },
      {
        fullName: tool.fullName,
        title: tool.title,
        ...(tool.pluginName ? { pluginName: tool.pluginName } : {}),
        risk: tool.risk,
        args: raw.argsText.slice(0, MAX_TOOL_ARGS_CHARS)
      }
    )
    confirmKind = decision.kind === 'allowed' ? 'allowed' : decision.kind
    if (!decision.allowed) {
      return fail(decision.reason ?? '用户拒绝了这次调用', {
        confirm: decision.kind === 'timeout' ? 'timeout' : 'denied'
      })
    }
  }

  if (ctx.signal.aborted) return fail('本次生成已停止，工具调用被取消', { confirm: confirmKind === 'allowed' || confirmKind === 'not-required' ? undefined : confirmKind })

  let outcome: { ok: boolean; text: string; error?: string }
  try {
    outcome = await runTool(tool, parsed.value, tool.timeoutMs)
  } catch (err) {
    outcome = { ok: false, text: '', error: reasonOf(err) }
  }

  const durationMs = Date.now() - startedAt
  const result: AiToolResultPart = {
    type: 'tool_result',
    callId: raw.id,
    ok: outcome.ok,
    text: outcome.ok ? clip(outcome.text, MAX_TOOL_RESULT_CHARS) : '',
    ...(outcome.ok ? {} : { error: clip(outcome.error ?? '工具执行失败', MAX_TOOL_RESULT_CHARS) }),
    durationMs
  }

  writeAudit({
    sessionId: ctx.sessionId,
    messageId: ctx.messageId,
    tool: tool.fullName,
    source: tool.source,
    ...(tool.pluginId ? { pluginId: tool.pluginId } : {}),
    risk: tool.risk,
    args: raw.argsText,
    ok: result.ok,
    confirm: confirmKind,
    durationMs,
    ...(result.error ? { error: result.error } : {})
  })
  ctx.notify({ type: 'tool-result', sessionId: ctx.sessionId, messageId: ctx.messageId, result })
  return result
}
