import { describe, expect, it } from 'vitest'
import { httpUrl, int, jsonValue, object, oneOf, optional, str, stringRecord } from '../src/main/plugin/api/validate'

describe('str', () => {
  it('拒绝非字符串与空串', () => {
    const parse = str('key')
    expect(() => parse(1)).toThrow(/必须是字符串/)
    expect(() => parse('')).toThrow(/不能为空/)
    expect(parse('ok')).toBe('ok')
  })

  it('按上限截断前先报错（不静默丢数据）', () => {
    const parse = str('key', { max: 3 })
    expect(() => parse('abcd')).toThrow(/过长/)
  })

  it('支持 pattern 白名单', () => {
    const parse = str('id', { pattern: /^[a-z]+$/ })
    expect(parse('abc')).toBe('abc')
    expect(() => parse('ab1')).toThrow(/非法字符/)
  })
})

describe('optional', () => {
  it('undefined / null 归一为 undefined，其余交给内层校验', () => {
    const parse = optional(str('q', { min: 1 }))
    expect(parse(undefined)).toBeUndefined()
    expect(parse(null)).toBeUndefined()
    expect(parse('x')).toBe('x')
    expect(() => parse('')).toThrow()
  })
})

describe('httpUrl', () => {
  it('只放行 http(s)', () => {
    const parse = httpUrl()
    expect(parse('https://example.com')).toBe('https://example.com')
    expect(parse('HTTP://example.com')).toBe('HTTP://example.com')
    expect(() => parse('javascript:alert(1)')).toThrow(/http\(s\)/)
    expect(() => parse('file:///c:/windows')).toThrow(/http\(s\)/)
  })
})

describe('jsonValue', () => {
  it('放行可序列化值', () => {
    const parse = jsonValue('value', 1024)
    expect(parse({ a: 1 })).toEqual({ a: 1 })
    expect(parse(null)).toBeNull()
  })

  it('拒绝不可序列化与超限值', () => {
    const parse = jsonValue('value', 32)
    expect(() => parse(() => 1)).toThrow(/无法序列化/)
    expect(() => parse(BigInt(1))).toThrow(/无法序列化/)
    expect(() => parse('x'.repeat(64))).toThrow(/过大/)
  })

  it('按 UTF-8 字节数而不是字符数计上限', () => {
    const parse = jsonValue('value', 8)
    // JSON 序列化后是 "中文"，6 字节 + 2 个引号 = 8，刚好卡在上限
    expect(() => parse('中文')).not.toThrow()
    expect(() => parse('中文字')).toThrow(/过大/)
  })
})

describe('object', () => {
  it('按白名单取字段，多余键丢弃', () => {
    const parse = object({ key: str('key'), n: int('n') })
    expect(parse({ key: 'a', n: 1, extra: 'nope' })).toEqual({ key: 'a', n: 1 })
  })

  it('非对象一律拒绝', () => {
    const parse = object({ key: str('key') })
    expect(() => parse(null)).toThrow(/必须是对象/)
    expect(() => parse([])).toThrow(/必须是对象/)
    expect(() => parse('x')).toThrow(/必须是对象/)
  })
})

describe('int', () => {
  it('只接受整数，字符串数字也不行', () => {
    const parse = int('timeout', { min: 1, max: 10 })
    expect(parse(5)).toBe(5)
    expect(() => parse(5.5)).toThrow(/整数/)
    expect(() => parse('5')).toThrow(/整数/)
    expect(() => parse(11)).toThrow(/超出范围/)
    expect(() => parse(Number.NaN)).toThrow(/整数/)
  })
})

describe('oneOf', () => {
  it('默认大小写敏感，upper 选项下先转大写', () => {
    const strict = oneOf('method', ['GET', 'POST'] as const)
    expect(strict('GET')).toBe('GET')
    expect(() => strict('get')).toThrow(/必须是/)

    const loose = oneOf('method', ['GET', 'POST'] as const, { upper: true })
    expect(loose('get')).toBe('GET')
  })
})

describe('stringRecord', () => {
  it('接受字符串字典，缺省按空对象', () => {
    const parse = stringRecord('headers')
    expect(parse(undefined)).toEqual({})
    expect(parse({ accept: 'text/html' })).toEqual({ accept: 'text/html' })
  })

  it('拒绝非字符串值、非法键与超量条目', () => {
    const parse = stringRecord('headers', { maxKeys: 2, valueMax: 4 })
    expect(() => parse({ a: 1 })).toThrow(/必须是字符串/)
    expect(() => parse({ 'bad key': 'x' })).toThrow(/非法字符/)
    expect(() => parse({ a: '12345' })).toThrow(/过长/)
    expect(() => parse({ a: '1', b: '2', c: '3' })).toThrow(/条目过多/)
  })
})
