import { describe, expect, it } from 'vitest'
import {
  budgetPercent,
  estimateTokens,
  fitTurns,
  truncateMiddle,
  type ChatTurn
} from '../src/main/ai/tokens'

function turn(text: string, role: 'user' | 'assistant' = 'user', images = 0): ChatTurn {
  return {
    messageId: `${role}-${text.slice(0, 8)}`,
    role,
    text,
    images: Array.from({ length: images }, (_, i) => ({ fileId: `f${i}.png`, mime: 'image/png' }))
  }
}

describe('token 估算', () => {
  it('空串为 0', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('中文按字计，英文按 4 字符 1 个', () => {
    expect(estimateTokens('你好世界')).toBe(4)
    expect(estimateTokens('abcdefgh')).toBe(2)
  })

  it('混合文本按两类分别累加', () => {
    // 4 个汉字 + 8 个字母/4 = 6
    expect(estimateTokens('你好世界abcdefgh')).toBe(6)
  })

  it('emoji 算一个字符而不是两个代理', () => {
    expect(estimateTokens('😀😀')).toBe(1)
  })

  it('估算偏高而不是偏低（宁早截断，不撞 400）', () => {
    const text = '这是一段中文'.repeat(100)
    // 真实分词约 0.6–0.7 token/字，这里按 1 token/字 估，必然不小于字数
    expect(estimateTokens(text)).toBeGreaterThanOrEqual(text.length)
  })
})

describe('中间截断', () => {
  it('没超预算就原样返回', () => {
    const out = truncateMiddle('短文本', 100)
    expect(out).toEqual({ text: '短文本', truncated: false })
  })

  it('超预算时保留头尾并标注省略了多少字', () => {
    const text = `开头${'中'.repeat(500)}结尾`
    const out = truncateMiddle(text, 50)
    expect(out.truncated).toBe(true)
    expect(out.text.startsWith('开头')).toBe(true)
    expect(out.text.endsWith('结尾')).toBe(true)
    expect(out.text).toContain('中间省略')
    expect(estimateTokens(out.text)).toBeLessThanOrEqual(60)
  })
})

describe('预算裁剪', () => {
  const budget = { contextWindow: 1000, maxOutputTokens: 200, fixedTokens: 50 }

  it('装得下就一条不丢', () => {
    const turns = [turn('第一句'), turn('第二句', 'assistant')]
    const out = fitTurns(turns, budget)
    expect(out.kept).toHaveLength(2)
    expect(out.dropped).toBe(0)
    expect(out.start).toBe(0)
  })

  it('超预算时从最旧的开始丢，start 指向保留区起点', () => {
    const turns = Array.from({ length: 40 }, (_, i) => turn(`第${i}条${'内容'.repeat(20)}`))
    const out = fitTurns(turns, budget)
    expect(out.dropped).toBeGreaterThan(0)
    expect(out.kept.length + out.dropped).toBe(40)
    expect(out.start).toBe(out.dropped)
    // 留下的一定是末尾那几轮
    expect(out.kept[out.kept.length - 1].messageId).toBe(turns[39].messageId)
    expect(out.tokens).toBeLessThanOrEqual(1000)
  })

  it('最后一条再长也要留，且被截断', () => {
    const turns = [turn('旧的'.repeat(10)), turn(`问题${'长'.repeat(5000)}`)]
    const out = fitTurns(turns, budget)
    const last = out.kept[out.kept.length - 1]
    expect(last.messageId).toBe(turns[1].messageId)
    expect(out.truncated).toBe(true)
    expect(estimateTokens(last.text)).toBeLessThanOrEqual(1000)
  })

  it('裁剪后不以 assistant 开头', () => {
    const turns = [
      turn('问题一'),
      turn('回答一', 'assistant'),
      turn('问题二'),
      turn('回答二', 'assistant'),
      turn('问题三')
    ]
    // 只装得下最后两条 → 起点落在「回答二」上，要往前挪一条
    const out = fitTurns(turns, { contextWindow: 60, maxOutputTokens: 0, fixedTokens: 0 })
    if (out.kept.length) expect(out.kept[0].role).toBe('user')
  })

  it('图片按每张固定开销计入，带图时更早开始丢', () => {
    const textOnly = Array.from({ length: 10 }, (_, i) => turn(`第${i}条${'字'.repeat(100)}`))
    const withImages = textOnly.map((t) => ({ ...t, images: [{ fileId: 'a.png', mime: 'image/png' }] }))
    const a = fitTurns(textOnly, budget)
    const b = fitTurns(withImages, budget)
    expect(b.kept.length).toBeLessThan(a.kept.length)
  })

  it('空历史返回空结果', () => {
    const out = fitTurns([], budget)
    expect(out.kept).toHaveLength(0)
    expect(out.tokens).toBe(50)
  })
})

describe('用量百分比', () => {
  it('按窗口折算，超窗口时如实给出大于 100 的百分比', () => {
    expect(budgetPercent(500, 1000)).toBe(50)
    expect(budgetPercent(5000, 1000)).toBe(500)
    expect(budgetPercent(1, 0)).toBe(0)
  })
})
