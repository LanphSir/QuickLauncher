import { describe, expect, it } from 'vitest'
import { MAX_INLINE_PER_PLUGIN, normalizeInlineItems } from '../src/shared/inline'

describe('normalizeInlineItems', () => {
  it('非数组输入返回空结果（插件乱传不会打崩面板）', () => {
    expect(normalizeInlineItems(undefined)).toEqual([])
    expect(normalizeInlineItems({ title: 'x' })).toEqual([])
    expect(normalizeInlineItems('2+3')).toEqual([])
  })

  it('单插件最多两条：内联区不能挤掉别的来源', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ id: `i${i}`, title: `结果 ${i}` }))
    expect(normalizeInlineItems(items)).toHaveLength(MAX_INLINE_PER_PLUGIN)
  })

  it('没有标题的条目被丢弃，空白标题也不占位', () => {
    expect(normalizeInlineItems([{ id: 'a' }, { id: 'b', title: '   ' }, { id: 'c', title: '有效' }])).toEqual([
      { id: 'c', title: '有效' }
    ])
  })

  it('标题压缩空白并按上限截断', () => {
    const [item] = normalizeInlineItems([{ id: 'a', title: `  2 +\n\n3  ` }])
    expect(item.title).toBe('2 + 3')

    const long = 'x'.repeat(300)
    const [truncated] = normalizeInlineItems([{ id: 'a', title: long }])
    expect(truncated.title).toHaveLength(120)
  })

  it('缺省 id 用标题兜底，重复 id 只留第一条', () => {
    const items = normalizeInlineItems([
      { title: '相同' },
      { title: '相同' },
      { id: 'k', title: '另一个' }
    ])
    expect(items.map((i) => i.id)).toEqual(['相同', 'k'])
  })

  it('徽标只取前两个字符（布局按 2 字符宽度设计）', () => {
    const [item] = normalizeInlineItems([{ id: 'a', title: 't', badge: '等于=' }])
    expect(item.badge).toBe('等于')
  })

  it('copy 动作超过 64KB 就丢掉动作，条目本身保留', () => {
    const huge = 'a'.repeat(64 * 1024 + 1)
    const [item] = normalizeInlineItems([{ id: 'a', title: 't', action: { type: 'copy', text: huge } }])
    expect(item.action).toBeUndefined()

    const [ok] = normalizeInlineItems([{ id: 'a', title: 't', action: { type: 'copy', text: 'hello' } }])
    expect(ok.action).toEqual({ type: 'copy', text: 'hello' })
  })

  it('open 动作：intent 必须是可序列化对象，否则退化为无 intent 的 open', () => {
    const [withIntent] = normalizeInlineItems([
      { id: 'a', title: 't', action: { type: 'open', intent: { chapter: 2 } } }
    ])
    expect(withIntent.action).toEqual({ type: 'open', intent: { chapter: 2 } })

    const [arrayIntent] = normalizeInlineItems([{ id: 'b', title: 't', action: { type: 'open', intent: [1, 2] } }])
    expect(arrayIntent.action).toEqual({ type: 'open' })

    const [hugeIntent] = normalizeInlineItems([
      { id: 'c', title: 't', action: { type: 'open', intent: { text: 'x'.repeat(4000) } } }
    ])
    expect(hugeIntent.action).toEqual({ type: 'open' })
  })

  it('未知动作类型忽略，不影响条目展示', () => {
    const [item] = normalizeInlineItems([{ id: 'a', title: 't', action: { type: 'run', cmd: 'rm -rf /' } }])
    expect(item.action).toBeUndefined()
    expect(item.title).toBe('t')
  })
})
