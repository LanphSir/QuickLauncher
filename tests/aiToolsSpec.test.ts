import { describe, expect, it } from 'vitest'
import { parseToolsSpec, toolFullName } from '../src/main/ai/toolsSpec'
import { MAX_TOOLS_PER_PLUGIN } from '../src/shared/ai'

function spec(tools: unknown[]): unknown {
  return { version: 1, tools }
}

const good = {
  name: 'translate_text',
  title: '翻译文本',
  description: '把文本翻译为目标语言',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' }, target: { type: 'string' } },
    required: ['text']
  }
}

describe('tools.json 解析', () => {
  it('正常工具带默认超时与标题兜底', () => {
    const r = parseToolsSpec(spec([{ ...good, title: undefined }]))
    expect(r.errors).toEqual([])
    expect(r.tools).toHaveLength(1)
    expect(r.tools[0]).toMatchObject({ name: 'translate_text', risk: 'read', timeoutMs: 8000 })
    expect(r.tools[0].title).toBe('translate_text')
  })

  it('顶层不是对象 / 版本不认识 / tools 不是数组都只报错不抛', () => {
    expect(parseToolsSpec(null).errors[0]).toContain('顶层')
    expect(parseToolsSpec({ version: 2, tools: [] }).errors[0]).toContain('版本')
    expect(parseToolsSpec({ version: 1, tools: {} }).errors[0]).toContain('数组')
  })

  it('版本缺省按 1 处理（作者常漏写）', () => {
    const r = parseToolsSpec({ tools: [good] })
    expect(r.tools).toHaveLength(1)
  })

  it('name 不合法、重名、缺 description 各自只丢自己', () => {
    const r = parseToolsSpec(
      spec([
        { ...good, name: 'Translate-Text' },
        good,
        { ...good, name: 'translate_text' },
        { ...good, name: 'no_desc', description: '   ' },
        { ...good, name: 'kept', title: '留下的' }
      ])
    )
    expect(r.tools.map((t) => t.name)).toEqual(['translate_text', 'kept'])
    expect(r.errors).toHaveLength(3)
    expect(r.errors.some((e) => e.includes('name 不合法'))).toBe(true)
    expect(r.errors.some((e) => e.includes('重复'))).toBe(true)
    expect(r.errors.some((e) => e.includes('description'))).toBe(true)
  })

  it('risk 缺省按 write（漏写时宁可多确认一次）', () => {
    const r = parseToolsSpec(spec([{ ...good, risk: undefined }]))
    expect(r.tools[0].risk).toBe('write')
  })

  it('未知 risk 按 write 并留一条说明', () => {
    const r = parseToolsSpec(spec([{ ...good, risk: 'harmless' }]))
    expect(r.tools[0].risk).toBe('write')
    expect(r.errors[0]).toContain('risk')
  })

  it('timeoutMs 夹取到 [1000, 60000]', () => {
    const r = parseToolsSpec(
      spec([
        { ...good, name: 'fast', timeoutMs: 10 },
        { ...good, name: 'slow', timeoutMs: 999999 },
        { ...good, name: 'nan', timeoutMs: 'soon' }
      ])
    )
    expect(r.tools.map((t) => t.timeoutMs)).toEqual([1000, 60000, 8000])
  })

  it('可以没有 parameters（补成空 object schema）', () => {
    const r = parseToolsSpec(spec([{ ...good, parameters: undefined }]))
    expect(r.errors).toEqual([])
    expect(r.tools[0].parameters).toEqual({ type: 'object', properties: {} })
  })

  it('schema 非法只丢该工具，不影响同文件其它工具', () => {
    const r = parseToolsSpec(
      spec([{ ...good, name: 'broken', parameters: { type: 'object', properties: { a: { type: 'nonsense' } } } }, good])
    )
    expect(r.tools.map((t) => t.name)).toEqual(['translate_text'])
    expect(r.errors[0]).toContain('broken')
  })

  it('超过单插件上限就截断并说明', () => {
    const many = Array.from({ length: MAX_TOOLS_PER_PLUGIN + 3 }, (_, i) => ({ ...good, name: `tool_${i}` }))
    const r = parseToolsSpec(spec(many))
    expect(r.tools).toHaveLength(MAX_TOOLS_PER_PLUGIN)
    expect(r.errors.some((e) => e.includes('上限'))).toBe(true)
  })

  it('description 过长会被截断（模型每轮都要读它）', () => {
    const r = parseToolsSpec(spec([{ ...good, description: 'x'.repeat(2000) }]))
    expect(r.tools[0].description.length).toBe(500)
  })
})

describe('参数校验器', () => {
  it('合法参数返回 null，缺必填给出路径与原因', () => {
    const r = parseToolsSpec(spec([good]))
    const validate = r.validators.get('translate_text')
    expect(validate).toBeTypeOf('function')
    expect(validate!({ text: 'hi' })).toBeNull()
    const err = validate!({ target: 'en' })
    expect(err).toContain('text')
  })

  it('字段类型不对时错误里带字段路径', () => {
    const r = parseToolsSpec(spec([good]))
    const err = r.validators.get('translate_text')!({ text: 123 })
    expect(err).toContain('/text')
  })

  it('允许额外字段（模型常顺手多塞 explanation）', () => {
    const r = parseToolsSpec(spec([good]))
    expect(r.validators.get('translate_text')!({ text: 'hi', explanation: '因为' })).toBeNull()
  })
})

describe('全局工具名', () => {
  it('带插件 id 前缀，避免同名工具打架', () => {
    expect(toolFullName('com.launcher.calculator', 'calculate')).toBe('plugin:com.launcher.calculator:calculate')
  })
})
