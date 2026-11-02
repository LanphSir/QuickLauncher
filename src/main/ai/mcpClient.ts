/**
 * 最小 MCP stdio 客户端（v0.6.4）。
 *
 * 为什么不用官方 `@modelcontextprotocol/sdk`：
 *
 * - 它把进程管理、传输、协议版本协商都包了，但**恰恰是我们最需要控制的部分**
 *   （崩溃计数、stderr 归因、Windows 上杀子进程树、超时预算）反而被藏起来，
 *   想插一手得绕着它的抽象打洞。
 * - 这个项目对「依赖」的一贯口径是：协议本身足够简单就自己写（SSE 解析、表达式
 *   求值都是这么处理的）。MCP 的 stdio 传输就是「按行 JSON-RPC 2.0」，
 *   工具场景只需要 initialize / tools/list / tools/call 三个方法。
 *
 * 代价是只支持 tools 一族：resources、prompts、sampling、roots 一律不碰。
 * 对本项目的定位（让 AI 能操作插件与外部工具）够用，且这层薄得可以随时替换。
 *
 * 传输细节（容易踩）：
 * - **按行分帧**，一行一条 JSON。不是 LSP 的 `Content-Length` 头。
 * - 服务器会主动发 notification（日志、进度），没有 `id`，直接丢。
 * - stdout 可能一次吐出多行，也可能半行；必须自己缓冲再切。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { MCP_LOG_TAIL_BYTES } from '../../shared/ai'
import type { McpServerSpec } from './mcpSpec'

/** 单个 MCP 工具的原始声明（server 侧字段名就是驼峰，这里原样保留） */
export interface McpToolInfo {
  name: string
  title?: string
  description: string
  inputSchema: unknown
  annotations?: unknown
}

export interface McpCallResult {
  ok: boolean
  text: string
  error?: string
}

interface JsonRpcResponse {
  jsonrpc?: string
  id?: number | string | null
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

interface PendingRequest {
  method: string
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

/** 我们声明的协议版本。服务器可以回一个更老的，握手时接受它的选择。 */
const PROTOCOL_VERSION = '2024-11-05'

export interface McpClientOptions {
  /** 客户端名/版本，进 initialize 的 clientInfo，服务器日志里能看到 */
  clientName: string
  clientVersion: string
  /** server 的工作目录（绝对路径，由调用方拼好并校验过） */
  cwd: string
  /** 建连预算：spawn + initialize + tools/list 总计 */
  connectTimeoutMs: number
}

export class McpStdioClient {
  private child: ChildProcess | null = null
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private stdoutBuffer = ''
  private stderrTail = ''
  private exited = false
  private exitInfo = ''
  private serverInfo: { name?: string; version?: string } = {}
  private negotiatedVersion = ''

  constructor(
    private readonly spec: McpServerSpec,
    private readonly options: McpClientOptions
  ) {}

  get isRunning(): boolean {
    return this.child !== null && !this.exited && this.child.exitCode === null
  }

  /** 服务器自报的名字/版本，展示在设置页与审计里 */
  get info(): { name: string; version: string; protocol: string } {
    return {
      name: this.serverInfo.name ?? this.spec.name,
      version: this.serverInfo.version ?? '',
      protocol: this.negotiatedVersion
    }
  }

  /** stdout/stderr 尾部：出错时拼进错误信息，比「连接失败」有用得多 */
  get logs(): string {
    return this.stderrTail.trim()
  }

  get exitReason(): string {
    return this.exitInfo
  }

  /**
   * 拉起进程并完成握手。
   *
   * `shell: false` 是这一层的安全根基：args 里的 `;`、`&&`、`|` 只是普通字符。
   * 环境变量合并而不是替换——`npx`、`node`、`uvx` 都靠 PATH 找到，
   * 清空 env 会让绝大多数社区 server 直接起不来。
   */
  async connect(): Promise<void> {
    if (this.child) throw new Error('这个 MCP client 已经用过了')

    const child = spawn(this.spec.command, this.spec.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // 不经 shell：见上面的注释，这是整个 MCP 支持里唯一真正的安全边界
      shell: false
    })
    this.child = child

    child.stdout?.setEncoding('utf-8')
    child.stdout?.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr?.setEncoding('utf-8')
    child.stderr?.on('data', (chunk: string) => this.onStderr(chunk))

    child.on('error', (err) => {
      // spawn 失败（命令不存在、没有执行权限）走这里，不会触发 close
      this.exitInfo = err.message
      this.exited = true
      this.rejectAll(new Error(`启动失败：${err.message}`))
    })
    child.on('close', (code, signal) => {
      this.exited = true
      this.exitInfo = signal ? `被信号 ${signal} 终止` : `退出码 ${code ?? '未知'}`
      this.rejectAll(new Error(this.exitInfo))
    })

    const init = await this.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: this.options.clientName, version: this.options.clientVersion }
      },
      this.options.connectTimeoutMs
    )

    const result = init as { protocolVersion?: unknown; serverInfo?: { name?: string; version?: string } } | null
    this.negotiatedVersion = typeof result?.protocolVersion === 'string' ? result.protocolVersion : PROTOCOL_VERSION
    this.serverInfo = {
      ...(typeof result?.serverInfo?.name === 'string' ? { name: result.serverInfo.name } : {}),
      ...(typeof result?.serverInfo?.version === 'string' ? { version: result.serverInfo.version } : {})
    }

    // 协议要求握手后必须补一条 initialized 通知；不发的话有的服务器会一直等
    this.notify('notifications/initialized', {})
  }

  /** 列出全部工具（跟着 nextCursor 翻页，单个 server 也可能有几十个工具） */
  async listTools(timeoutMs: number): Promise<McpToolInfo[]> {
    const out: McpToolInfo[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page++) {
      const result = (await this.request(
        'tools/list',
        cursor ? { cursor } : {},
        timeoutMs
      )) as { tools?: unknown; nextCursor?: unknown } | null

      for (const item of Array.isArray(result?.tools) ? result.tools : []) {
        const info = normalizeTool(item)
        if (info) out.push(info)
      }

      const next = typeof result?.nextCursor === 'string' ? result.nextCursor : ''
      if (!next || next === cursor) break
      cursor = next
    }
    return out
  }

  /**
   * 调一个工具。
   *
   * 结果只取文本：图片/二进制对模型没用（多模态工具调用还没有统一形态），
   * 直接标一句「已省略」，比丢一串 base64 进上下文好。
   */
  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<McpCallResult> {
    let result: { content?: unknown; isError?: unknown; structuredContent?: unknown } | null
    try {
      result = (await this.request('tools/call', { name, arguments: args }, timeoutMs)) as typeof result
    } catch (err) {
      return { ok: false, text: '', error: err instanceof Error ? err.message : String(err) }
    }

    const { text, hasNonText } = flattenContent(result?.content)
    const isError = result?.isError === true
    if (text) {
      return isError ? { ok: false, text, error: text } : { ok: true, text }
    }
    if (hasNonText) return { ok: true, text: '（这个工具只返回了图片或资源，已省略）' }

    // 没 content 但有 structuredContent：给模型一段 JSON，比空着强
    if (result?.structuredContent !== undefined) {
      try {
        return { ok: true, text: JSON.stringify(result.structuredContent).slice(0, 4000) }
      } catch {
        return { ok: true, text: '（结果无法序列化）' }
      }
    }
    return { ok: isError ? false : true, text: isError ? '' : '（工具没有返回内容）', ...(isError ? { error: '工具执行失败' } : {}) }
  }

  /** 关闭：先礼后兵。Windows 上 npx/node 会再起子进程，只 kill 父进程会留下孤儿 */
  async close(): Promise<void> {
    const child = this.child
    this.child = null
    if (!child || this.exited) return

    this.rejectAll(new Error('连接已关闭'))
    try {
      child.stdin?.end()
    } catch {
      // 进程可能已经没了，忽略
    }

    const pid = child.pid
    if (pid === undefined) return
    if (process.platform === 'win32') {
      // taskkill /T 连子进程树一起收；/F 避免它弹「要终止吗」
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!this.exited) child.kill('SIGKILL')
      }, 1500).unref?.()
    }
  }

  // ------------------------------------------------------------ 内部

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    // 一行一条消息；末尾半行留在缓冲里等下一块
    let index = this.stdoutBuffer.indexOf('\n')
    while (index >= 0) {
      const line = this.stdoutBuffer.slice(0, index).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1)
      if (line) this.onLine(line)
      index = this.stdoutBuffer.indexOf('\n')
    }
    // 防线：服务器吐了一坨没有换行的垃圾，别让缓冲无限涨
    if (this.stdoutBuffer.length > 4 * 1024 * 1024) this.stdoutBuffer = ''
  }

  private onLine(line: string): void {
    let message: JsonRpcResponse
    try {
      message = JSON.parse(line) as JsonRpcResponse
    } catch {
      // 不是 JSON：多半是服务器往 stdout 打了日志。留到 stderr 尾部便于排错
      this.appendStderr(`[stdout] ${line}`)
      return
    }
    if (message.id === undefined || message.id === null) return // notification，忽略
    const id = typeof message.id === 'number' ? message.id : Number(message.id)
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (message.error) {
      const reason = message.error.message ?? '未知错误'
      pending.reject(new Error(`${pending.method} 失败：${reason}`))
    } else {
      pending.resolve(message.result ?? null)
    }
  }

  private onStderr(chunk: string): void {
    this.appendStderr(chunk)
  }

  private appendStderr(text: string): void {
    this.stderrTail += text
    if (this.stderrTail.length > MCP_LOG_TAIL_BYTES) {
      this.stderrTail = this.stderrTail.slice(-MCP_LOG_TAIL_BYTES)
    }
  }

  private rejectAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private notify(method: string, params: Record<string, unknown>): void {
    const child = this.child
    if (!child?.stdin || this.exited) return
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    } catch {
      // 写不进去说明进程没了，close 事件会处理收尾
    }
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const child = this.child
    if (!child || this.exited || !child.stdin) {
      return Promise.reject(new Error(this.exitInfo || 'MCP 进程没有运行'))
    }
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时（${Math.round(timeoutMs / 1000)} 秒）`))
      }, timeoutMs)
      timer.unref?.()

      this.pending.set(id, { method, resolve, reject, timer })
      try {
        child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      } catch (err) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }
}

function normalizeTool(raw: unknown): McpToolInfo | null {
  if (typeof raw !== 'object' || raw === null) return null
  const item = raw as Record<string, unknown>
  const name = typeof item.name === 'string' ? item.name.trim() : ''
  if (!name) return null
  const description = typeof item.description === 'string' ? item.description : ''
  return {
    name,
    ...(typeof item.title === 'string' && item.title.trim() ? { title: item.title.trim() } : {}),
    description,
    inputSchema: item.inputSchema,
    ...(item.annotations !== undefined ? { annotations: item.annotations } : {})
  }
}

/**
 * 把 MCP 的 content 数组压成一段文本。
 *
 * 只认 `text`；`image` / `audio` / `resource` 一律算「有内容但读不了」，
 * 这样调用方至少能告诉模型「返回了图片」而不是「工具没有返回内容」。
 */
function flattenContent(content: unknown): { text: string; hasNonText: boolean } {
  if (!Array.isArray(content)) return { text: '', hasNonText: false }
  const parts: string[] = []
  let hasNonText = false
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue
    const part = item as Record<string, unknown>
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text)
      continue
    }
    hasNonText = true
    if (part.type === 'resource' && typeof part.resource === 'object' && part.resource !== null) {
      const resource = part.resource as Record<string, unknown>
      if (typeof resource.text === 'string') parts.push(resource.text)
      else if (typeof resource.uri === 'string') parts.push(`[资源 ${resource.uri}]`)
    }
  }
  return { text: parts.join('\n').trim(), hasNonText }
}
