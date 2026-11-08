import { describe, expect, it } from 'vitest'
import type { AiChatMessage, AiMessagePart } from '../src/shared/ai'
import { answerStart } from '../plugins/ai/src/answer'

/** 造一条助手消息；parts 用工厂函数拼，省得每处都写全字段 */
function msg(...parts: AiMessagePart[]): AiChatMessage {
  return { id: 'm1', role: 'assistant', parts, createdAt: 0 }
}

const text = (t: string): AiMessagePart => ({ type: 'text', text: t })
const think = (t: string): AiMessagePart => ({ type: 'reasoning', text: t })
const call = (id: string): AiMessagePart => ({
  type: 'tool_call',
  callId: id,
  apiName: 'probe',
  fullName: 'plugin:com.launcher.probe:probe',
  title: '探针',
  args: '{}',
  risk: 'read'
})
const result = (id: string): AiMessagePart => ({
  type: 'tool_result',
  callId: id,
  ok: true,
  text: 'ok'
})

describe('过程与回答的分界', () => {
  it('没有工具调用时，正文从头就算答案，推理留在过程里', () => {
    const m = msg(think('想一下'), text('先说一句'), text('结论在这'))
    // 只有推理该被折叠；多段正文都是答案，不能把前几段藏进"过程"
    expect(answerStart(m)).toBe(1)
  })

  it('工具之后的第一段正文就是答案的起点', () => {
    const m = msg(text('我来查一下'), call('a'), result('a'), text('查到了'), text('结论'))
    // 过渡句「查到了」也算答案的一部分，别折叠进过程
    expect(answerStart(m)).toBe(3)
  })

  it('多次工具调用时以最后一次为界', () => {
    const m = msg(
      text('先看看'),
      call('a'),
      result('a'),
      text('过渡一'),
      call('b'),
      result('b'),
      text('最终结论')
    )
    expect(answerStart(m)).toBe(6)
  })

  it('工具之后还没出正文：退回最后一段正文，别让答案区空着', () => {
    const m = msg(text('我先查一下'), call('a'), result('a'))
    expect(answerStart(m)).toBe(0)
  })

  it('只有工具、一句话没说：返回末尾，正文为空', () => {
    const m = msg(call('a'), result('a'))
    expect(answerStart(m)).toBe(2)
  })

  it('空白正文不算答案', () => {
    const m = msg(text('  \n '), call('a'), result('a'), text('   '), text('真的结论'))
    expect(answerStart(m)).toBe(4)
  })
})
