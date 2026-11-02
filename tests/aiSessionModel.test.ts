import { describe, expect, it } from 'vitest'
import {
  createMessage,
  sortSessions,
  titleFromText,
  toApiMessages,
  trimMessages
} from '../src/main/ai/sessionModel'
import type { AiChatMessage } from '../src/shared/ai'

function msg(role: AiChatMessage['role'], text: string, extra: Partial<AiChatMessage> = {}): AiChatMessage {
  return { id: `${role}-${text}`, role, parts: [{ type: 'text', text }], createdAt: 1, ...extra }
}

describe('会话标题', () => {
  it('取第一行非空内容，压掉重复空白', () => {
    expect(titleFromText('\n\n  帮 我   写一个正则  \n第二行')).toBe('帮 我 写一个正则')
  })

  it('超长截断加省略号，空内容给默认名', () => {
    expect(titleFromText('a'.repeat(40))).toBe(`${'a'.repeat(24)}…`)
    expect(titleFromText('   \n  ')).toBe('新会话')
  })
})

describe('转请求体', () => {
  it('system 排第一，跳过空回答与 reasoning', () => {
    const messages: AiChatMessage[] = [
      msg('user', '问题'),
      { id: 'a1', role: 'assistant', parts: [{ type: 'reasoning', text: '内部草稿' }], createdAt: 2 },
      msg('assistant', '  '),
      msg('assistant', '回答')
    ]
    expect(toApiMessages(messages, '你是助手')).toEqual([
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '问题' },
      { role: 'assistant', content: '回答' }
    ])
  })

  it('没有 system 时不塞空消息', () => {
    expect(toApiMessages([msg('user', 'hi')])).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('已停止但有内容的回答要保留（它就是模型实际说的话）', () => {
    const stopped = msg('assistant', '说到一半', { stopped: true })
    expect(toApiMessages([msg('user', 'q'), stopped])).toHaveLength(2)
  })
})

describe('裁剪与排序', () => {
  it('超长时丢最旧的，返回新数组', () => {
    const list = [1, 2, 3, 4, 5].map((n) => msg('user', String(n)))
    const out = trimMessages(list, 3)
    expect(out.map((m) => (m.parts[0] as { text: string }).text)).toEqual(['3', '4', '5'])
    expect(list).toHaveLength(5)
  })

  it('会话按更新时间倒序，同刻按 id 稳定', () => {
    const list = [
      { id: 'b', updatedAt: 10 },
      { id: 'a', updatedAt: 10 },
      { id: 'c', updatedAt: 20 }
    ]
    expect(sortSessions(list).map((s) => s.id)).toEqual(['c', 'a', 'b'])
  })

  it('新消息带唯一 id 与时间', () => {
    const a = createMessage('user', [{ type: 'text', text: 'x' }])
    const b = createMessage('user', [{ type: 'text', text: 'x' }])
    expect(a.id).not.toBe(b.id)
    expect(a.createdAt).toBeGreaterThan(0)
  })
})
