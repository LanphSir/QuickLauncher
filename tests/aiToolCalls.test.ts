import { describe, expect, it } from 'vitest'
import { apiToolName, isValidApiToolName } from '../src/main/ai/toolNames'
import { ToolCallCollector } from '../src/main/ai/toolCalls'
import { parseChatChunk } from '../src/main/ai/chunk'

describe('工具名映射', () => {
  it('插件全局名翻成合法函数名，且仍看得出归属', () => {
    const name = apiToolName('plugin:com.launcher.translator:translate')
    expect(name).toBe('plugin_com_launcher_translator_translate')
    expect(isValidApiToolName(name)).toBe(true)
  })

  it('内置工具名保持可读（不带冒号、点）', () => {
    expect(apiToolName('launcher.search')).toBe('launcher_search')
    expect(apiToolName('clipboard_read')).toBe('clipboard_read')
  })

  it('超长 id 截断后仍合法且不撞名', () => {
    const a = apiToolName(`plugin:${'com.example.very-long-plugin-id.'.repeat(3)}one:tool_a`)
    const b = apiToolName(`plugin:${'com.example.very-long-plugin-id.'.repeat(3)}two:tool_a`)
    expect(a.length).toBeLessThanOrEqual(64)
    expect(b.length).toBeLessThanOrEqual(64)
    expect(isValidApiToolName(a)).toBe(true)
    expect(a).not.toBe(b)
  })

  it('数字/怪字符开头也不会产出非法名', () => {
    expect(isValidApiToolName(apiToolName('9lives'))).toBe(true)
    expect(isValidApiToolName(apiToolName('插件:测试'))).toBe(true)
  })
})

describe('流式工具调用碎片拼接', () => {
  it('并行调用按 index 归并，参数不串台', () => {
    const c = new ToolCallCollector()
    // 两路交错到达，这正是真实流的样子
    c.push({ index: 0, id: 'call_a', name: 'clipboard_read' })
    c.push({ index: 1, id: 'call_b', name: 'launcher_search' })
    c.push({ index: 0, args: '{"a"' })
    c.push({ index: 1, args: '{"query":' })
    c.push({ index: 0, args: ':1}' })
    c.push({ index: 1, args: '"翻译"}' })
    const calls = c.take()
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ id: 'call_a', apiName: 'clipboard_read', argsText: '{"a":1}' })
    expect(calls[1]).toMatchObject({ id: 'call_b', apiName: 'launcher_search', argsText: '{"query":"翻译"}' })
  })

  it('后续帧没有 id 不会被当成新调用', () => {
    const c = new ToolCallCollector()
    c.push({ index: 0, id: 'call_1', name: 'calculate' })
    c.push({ index: 0, args: '{"expression":"1+1"}' })
    expect(c.take()).toHaveLength(1)
    expect(c.take()[0].id).toBe('call_1')
  })

  it('没有函数名的占位帧被丢掉', () => {
    const c = new ToolCallCollector()
    c.push({ index: 0, args: '{}' })
    expect(c.take()).toHaveLength(0)
  })
})

describe('SSE 帧里的 tool_calls 解析', () => {
  it('读出 index/id/name/args', () => {
    const delta = parseChatChunk(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_x', type: 'function', function: { name: 'calculate', arguments: '{"expression"' } }
              ]
            }
          }
        ]
      })
    )
    expect(delta?.toolCalls?.[0]).toMatchObject({ index: 0, id: 'call_x', name: 'calculate', args: '{"expression"' })
  })

  it('finish_reason=tool_calls 会被带出来', () => {
    const delta = parseChatChunk(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }))
    expect(delta?.finish).toBe('tool_calls')
  })

  it('没有 tool_calls 的普通帧不受影响', () => {
    const delta = parseChatChunk(JSON.stringify({ choices: [{ delta: { content: '你好' } }] }))
    expect(delta?.text).toBe('你好')
    expect(delta?.toolCalls).toBeUndefined()
  })
})
