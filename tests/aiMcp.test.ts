import { describe, expect, it } from 'vitest'
import {
  approvalKey,
  commandLine,
  mcpToolFullName,
  parseMcpSpec,
  riskOfMcpTool,
  serverFingerprint
} from '../src/main/ai/mcpSpec'
import { compileToolSchema } from '../src/main/ai/toolsSpec'
import { apiToolName, isValidApiToolName } from '../src/main/ai/toolNames'
import {
  DEFAULT_MCP_CALL_TIMEOUT_MS,
  MAX_MCP_SERVERS_PER_PLUGIN,
  MAX_MCP_TIMEOUT_MS,
  MCP_IDLE_TIMEOUT_MS,
  MIN_MCP_TIMEOUT_MS,
  mcpIdleExpired,
  type McpIdleState
} from '../src/shared/ai'

/** 一条最小可用的声明 */
function minimal(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'fs', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/notes'], ...extra }
}

describe('mcp.json 解析', () => {
  it('接受 { servers: [...] } 与裸数组两种写法', () => {
    expect(parseMcpSpec({ servers: [minimal()] }).servers).toHaveLength(1)
    expect(parseMcpSpec([minimal()]).servers).toHaveLength(1)
  })

  it('形状不对时整份拒掉并说明原因', () => {
    const bad = parseMcpSpec({ server: [] })
    expect(bad.servers).toHaveLength(0)
    expect(bad.errors.join()).toContain('servers')
  })

  it('server 名不合法只丢这一条', () => {
    const result = parseMcpSpec([
      minimal({ name: 'Has Spaces' }),
      minimal({ name: 'ok' })
    ])
    expect(result.servers.map((s) => s.name)).toEqual(['ok'])
    expect(result.errors.join()).toContain('server 名不合法')
  })

  it('缺 command 只丢这一条', () => {
    const result = parseMcpSpec([minimal({ command: '   ' }), minimal({ name: 'two' })])
    expect(result.servers.map((s) => s.name)).toEqual(['two'])
    expect(result.errors.join()).toContain('缺少 command')
  })

  it('args 必须是字符串数组', () => {
    expect(parseMcpSpec([minimal({ args: 'npx -y x' })]).servers).toHaveLength(0)
    expect(parseMcpSpec([minimal({ args: ['ok', 42] })]).servers).toHaveLength(0)
  })

  it('cwd 必须是插件目录内的相对路径', () => {
    for (const cwd of ['/etc', 'C:/Windows', '../..', 'a/../../b']) {
      const result = parseMcpSpec([minimal({ cwd })])
      expect(result.servers, cwd).toHaveLength(0)
    }
    expect(parseMcpSpec([minimal({ cwd: 'tools/server' })]).servers[0].cwd).toBe('tools/server')
  })

  it('env 的非法键被过滤，合法值转成字符串', () => {
    const result = parseMcpSpec([
      minimal({ env: { API_KEY: 'x', 'bad-key': 'y', PORT: 8080 } })
    ])
    expect(result.servers[0].env).toEqual({ API_KEY: 'x', PORT: '8080' })
    expect(result.errors.join()).toContain('env')
  })

  it('超时夹到 [1s, 120s]，缺省 30s', () => {
    expect(parseMcpSpec([minimal()]).servers[0].timeoutMs).toBe(DEFAULT_MCP_CALL_TIMEOUT_MS)
    expect(parseMcpSpec([minimal({ timeoutMs: 5 })]).servers[0].timeoutMs).toBe(MIN_MCP_TIMEOUT_MS)
    expect(parseMcpSpec([minimal({ timeoutMs: 10 ** 9 })]).servers[0].timeoutMs).toBe(MAX_MCP_TIMEOUT_MS)
  })

  it('重复的 server 名只保留第一个', () => {
    const result = parseMcpSpec([minimal(), minimal({ args: ['dup'] })])
    expect(result.servers).toHaveLength(1)
    expect(result.errors.join()).toContain('重复')
  })

  it('超过数量上限时截断并提示', () => {
    const list = Array.from({ length: MAX_MCP_SERVERS_PER_PLUGIN + 3 }, (_, i) => minimal({ name: `s${i}` }))
    const result = parseMcpSpec(list)
    expect(result.servers).toHaveLength(MAX_MCP_SERVERS_PER_PLUGIN)
    expect(result.errors.join()).toContain('最多声明')
  })
})

describe('命令指纹', () => {
  const base = parseMcpSpec([minimal()]).servers[0]

  it('同一份声明算出来的指纹稳定', () => {
    expect(serverFingerprint(base)).toBe(serverFingerprint({ ...base, args: [...base.args] }))
  })

  it('改一个参数就换指纹（这是「改参数必须重新确认」的实现）', () => {
    const changed = { ...base, args: [...base.args, '--readonly'] }
    expect(serverFingerprint(changed)).not.toBe(serverFingerprint(base))
  })

  it('改 env 换指纹', () => {
    expect(serverFingerprint({ ...base, env: { A: '1' } })).not.toBe(serverFingerprint(base))
    expect(serverFingerprint({ ...base, env: { A: '1' } })).toBe(
      serverFingerprint({ ...base, env: { A: '1' } })
    )
  })

  it('改 env 键的顺序不换指纹（键排序后再序列化）', () => {
    const a = serverFingerprint({ ...base, env: { A: '1', B: '2' } })
    const b = serverFingerprint({ ...base, env: { B: '2', A: '1' } })
    expect(a).toBe(b)
  })

  it('只改超时不换指纹（本地策略，不是执行授权）', () => {
    expect(serverFingerprint({ ...base, timeoutMs: 60000 })).toBe(serverFingerprint(base))
  })
})

describe('MCP 工具的命名与风险', () => {
  it('全局名带插件与 server，两个插件可用同名 server', () => {
    expect(mcpToolFullName('com.a', 'fs', 'read_file')).toBe('mcp:com.a:fs:read_file')
    expect(mcpToolFullName('com.b', 'fs', 'read_file')).toBe('mcp:com.b:fs:read_file')
  })

  it('全局名能翻成合法且不撞的函数名', () => {
    const a = apiToolName(mcpToolFullName('com.smoke.probe-ai', 'mock', 'echo'))
    const b = apiToolName(mcpToolFullName('com.smoke.probe-ai', 'other', 'echo'))
    expect(isValidApiToolName(a)).toBe(true)
    expect(a).not.toBe(b)
  })

  it('按服务端注解推断风险，缺注解按 write', () => {
    expect(riskOfMcpTool({ readOnlyHint: true })).toBe('read')
    expect(riskOfMcpTool({ destructiveHint: true })).toBe('dangerous')
    expect(riskOfMcpTool({})).toBe('write')
    expect(riskOfMcpTool(undefined)).toBe('write')
    // 自相矛盾的注解按更危险的那个算
    expect(riskOfMcpTool({ readOnlyHint: true, destructiveHint: true })).toBe('dangerous')
  })

  it('授权键与展示用的命令行', () => {
    expect(approvalKey('com.a', 'fs')).toBe('com.a::fs')
    const spec = parseMcpSpec([minimal({ args: ['-y', 'pkg with space', 'D:/my notes'] })]).servers[0]
    expect(commandLine(spec)).toBe('npx -y "pkg with space" "D:/my notes"')
  })
})

describe('MCP 的 inputSchema 复用同一套校验', () => {
  it('合法 schema 编出可用的校验器', () => {
    const compiled = compileToolSchema({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    })
    expect(compiled).not.toBeNull()
    expect(compiled!.validator({ path: 'a.txt' })).toBeNull()
    expect(compiled!.validator({})).toContain('path')
  })

  it('没给 schema 时当作无参数工具', () => {
    const compiled = compileToolSchema(undefined)
    expect(compiled).not.toBeNull()
    expect(compiled!.validator({})).toBeNull()
  })
})

describe('MCP 空闲回收', () => {
  const now = 1_700_000_000_000
  /** 一个空转超时的健康运行时 */
  const idle = (extra: Partial<McpIdleState> = {}): McpIdleState => ({
    running: true,
    connecting: false,
    disabled: false,
    activeCalls: 0,
    lastUsedAt: now - MCP_IDLE_TIMEOUT_MS - 1,
    ...extra
  })

  it('空转超过阈值才收', () => {
    expect(mcpIdleExpired(idle(), now)).toBe(true)
    expect(mcpIdleExpired(idle({ lastUsedAt: now - MCP_IDLE_TIMEOUT_MS + 1 }), now)).toBe(false)
  })

  it('有调用在飞时绝不收（收掉就把这次调用连结果一起丢了）', () => {
    expect(mcpIdleExpired(idle({ activeCalls: 1 }), now)).toBe(false)
  })

  it('没在跑、正在建连、已停用的都不动', () => {
    expect(mcpIdleExpired(idle({ running: false }), now)).toBe(false)
    expect(mcpIdleExpired(idle({ connecting: true }), now)).toBe(false)
    expect(mcpIdleExpired(idle({ disabled: true }), now)).toBe(false)
  })

  it('lastUsedAt 还停在初值 0 时算作空转——所以连上那一刻必须写它', () => {
    // 这条钉的是约定：`makeRuntime` 里 lastUsedAt 初始为 0，只有「连上/调用完」才写。
    // 如果哪天把 connectRuntime 里的赋值删了，运行中的 server 会在下一次清扫时被收掉。
    expect(mcpIdleExpired(idle({ lastUsedAt: 0 }), now)).toBe(true)
  })
})
