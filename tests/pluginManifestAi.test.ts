import { describe, expect, it } from 'vitest'
import {
  normalizeAiSection,
  normalizeApiVersion,
  normalizeWindowHint,
  safeRelative
} from '../src/main/plugin/manifestAi'

function collector(): { warn: (m: string) => void; warnings: string[] } {
  const warnings: string[] = []
  return { warn: (m: string) => warnings.push(m), warnings }
}

describe('apiVersion', () => {
  it('缺省视为 1', () => {
    expect(normalizeApiVersion(undefined, () => {})).toBe(1)
  })

  it('认 1 和 2', () => {
    expect(normalizeApiVersion(1, () => {})).toBe(1)
    expect(normalizeApiVersion(2, () => {})).toBe(2)
  })

  it('高于支持版本按 2 加载，不拒载', () => {
    const { warn, warnings } = collector()
    expect(normalizeApiVersion(9, warn)).toBe(2)
    expect(warnings).toHaveLength(1)
  })

  it('非数字按 1 并告警', () => {
    const { warn, warnings } = collector()
    expect(normalizeApiVersion('2', warn)).toBe(1)
    expect(warnings[0]).toContain('apiVersion')
  })
})

describe('window 建议尺寸', () => {
  it('正常值原样保留', () => {
    expect(normalizeWindowHint({ width: 1040, height: 740 }, () => {})).toEqual({ width: 1040, height: 740 })
  })

  it('夹取到边界内', () => {
    expect(normalizeWindowHint({ width: 100, height: 99999 }, () => {})).toEqual({ width: 420, height: 1800 })
  })

  it('缺一个维度就整体忽略（半套尺寸比默认值更奇怪）', () => {
    const { warn, warnings } = collector()
    expect(normalizeWindowHint({ width: 900 }, warn)).toBeUndefined()
    expect(warnings).toHaveLength(1)
  })

  it('不是对象时忽略', () => {
    expect(normalizeWindowHint('1040x740', () => {})).toBeUndefined()
  })
})

describe('ai 段路径', () => {
  const exists = (rel: string): boolean => rel === 'ai/tools.json' || rel === 'ai/SKILL.md'

  it('存在且在目录内的路径保留', () => {
    const ai = normalizeAiSection({ tools: 'ai/tools.json', skill: './ai/SKILL.md' }, exists, () => {})
    expect(ai).toEqual({ tools: 'ai/tools.json', skill: 'ai/SKILL.md' })
  })

  it('一个坏掉只丢一个，其余保留', () => {
    const { warn, warnings } = collector()
    const ai = normalizeAiSection({ tools: 'ai/tools.json', skill: 'ai/nope.md' }, exists, warn)
    expect(ai).toEqual({ tools: 'ai/tools.json' })
    expect(warnings[0]).toContain('不存在')
  })

  it('拒绝越界路径与绝对路径', () => {
    const { warn, warnings } = collector()
    const always = (): boolean => true
    expect(normalizeAiSection({ tools: '../../etc/passwd' }, always, warn)).toBeUndefined()
    expect(normalizeAiSection({ tools: '/etc/passwd' }, always, warn)).toBeUndefined()
    expect(normalizeAiSection({ tools: 'D:/secret.json' }, always, warn)).toBeUndefined()
    expect(normalizeAiSection({ tools: 'https://evil.com/tools.json' }, always, warn)).toBeUndefined()
    expect(warnings).toHaveLength(4)
  })

  it('external 型插件直接忽略（没有页面能回传工具结果）', () => {
    const { warn, warnings } = collector()
    const ai = normalizeAiSection({ tools: 'ai/tools.json' }, () => true, warn, 'external')
    expect(ai).toBeUndefined()
    expect(warnings[0]).toContain('external')
  })

  it('全都不合法时返回 undefined 而不是空对象', () => {
    expect(normalizeAiSection({ tools: '' }, () => true, () => {})).toBeUndefined()
  })
})

describe('safeRelative', () => {
  it('归一化反斜杠与 ./', () => {
    expect(safeRelative('.\\ai\\tools.json')).toBe('ai/tools.json')
    expect(safeRelative('./ai//tools.json')).toBe('ai/tools.json')
  })

  it('挡掉越界写法', () => {
    expect(safeRelative('../x')).toBeNull()
    expect(safeRelative('ai/../../x')).toBeNull()
    expect(safeRelative('')).toBeNull()
    expect(safeRelative('/abs')).toBeNull()
    expect(safeRelative('C:/x')).toBeNull()
  })
})
