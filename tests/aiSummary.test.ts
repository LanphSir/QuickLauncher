import { describe, expect, it } from 'vitest'
import { summarizeRange } from '../src/main/ai/summary'
import type { ChatTurn } from '../src/main/ai/tokens'

function turn(id: string, role: 'user' | 'assistant' = 'user'): ChatTurn {
  return { messageId: id, role, text: `text-${id}`, images: [] }
}

/** 造 10 轮对话：u0 a0 u1 a1 … */
function history(count: number): ChatTurn[] {
  return Array.from({ length: count }, (_, i) => turn(`m${i}`, i % 2 === 1 ? 'assistant' : 'user'))
}

describe('该压哪一段历史', () => {
  it('丢得太少时不压（丢一两条不值一次请求）', () => {
    expect(summarizeRange(history(10), 2)).toBeNull()
  })

  it('丢得够多时返回被丢掉的那一段', () => {
    const turns = history(20)
    const slice = summarizeRange(turns, 8)
    expect(slice).toHaveLength(8)
    expect(slice?.[0].messageId).toBe('m0')
    expect(slice?.[7].messageId).toBe('m7')
  })

  it('摘要点之后剩得太少时也不压', () => {
    const turns = history(20)
    // m7 之后只剩 m8~m11 四条，不到阈值
    expect(summarizeRange(turns, 12, 'm7')).toBeNull()
  })

  it('摘要点之后仍够多时会压', () => {
    const turns = history(30)
    const slice = summarizeRange(turns, 20, 'm4')
    expect(slice?.[0].messageId).toBe('m5')
    expect(slice).toHaveLength(15)
  })

  it('摘要终点已被裁掉时放弃本次（旧摘要覆盖范围不明，不能瞎接）', () => {
    const turns = history(20)
    expect(summarizeRange(turns, 15, 'gone')).toBeNull()
  })

  it('摘要点就在保留区边界时不重复压', () => {
    const turns = history(20)
    expect(summarizeRange(turns, 12, 'm11')).toBeNull()
  })
})
