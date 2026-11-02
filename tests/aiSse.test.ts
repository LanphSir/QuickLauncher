import { describe, expect, it } from 'vitest'
import { createSseDecoder } from '../src/main/ai/sse'
import { parseChatChunk } from '../src/main/ai/chunk'

describe('SSE 解码', () => {
  it('按空行切帧，多行 data 用换行拼回', () => {
    const d = createSseDecoder()
    const frames = d.push('data: a\ndata: b\n\ndata: c\n\n')
    expect(frames).toEqual([
      { event: undefined, data: 'a\nb' },
      { event: undefined, data: 'c' }
    ])
  })

  it('分片落在帧中间也要能拼回来（fetch 的 chunk 边界与帧无关）', () => {
    const d = createSseDecoder()
    expect(d.push('data: {"a"')).toEqual([])
    expect(d.push(':1}\n')).toEqual([])
    expect(d.push('\n')).toEqual([{ event: undefined, data: '{"a":1}' }])
  })

  it('CRLF、注释心跳与 event 字段', () => {
    const d = createSseDecoder()
    const frames = d.push(': ping\r\nevent: delta\r\ndata: x\r\n\r\n')
    expect(frames).toEqual([{ event: 'delta', data: 'x' }])
  })

  it('流结束时补发没有空行收尾的最后一帧', () => {
    const d = createSseDecoder()
    expect(d.push('data: [DONE]')).toEqual([])
    expect(d.flush()).toEqual([{ event: undefined, data: '[DONE]' }])
  })
})

describe('OpenAI 增量解析', () => {
  it('正文与思维链分别取（两家字段名都认）', () => {
    expect(parseChatChunk(JSON.stringify({ choices: [{ delta: { content: '你' } }] }))).toEqual({ text: '你' })
    expect(
      parseChatChunk(JSON.stringify({ choices: [{ delta: { reasoning_content: '想' } }] }))
    ).toEqual({ reasoning: '想' })
    expect(parseChatChunk(JSON.stringify({ choices: [{ delta: { reasoning: '想' } }] }))).toEqual({
      reasoning: '想'
    })
  })

  it('[DONE] 与 finish_reason', () => {
    expect(parseChatChunk('[DONE]')).toEqual({ stop: true })
    expect(parseChatChunk(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }))).toEqual({
      finish: 'length'
    })
  })

  it('usage 与空增量', () => {
    expect(parseChatChunk(JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 5 } }))).toEqual(
      { usage: { input: 3, output: 5 } }
    )
    // 空 delta 不该产生任何事件，否则界面会闪一下
    expect(parseChatChunk(JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] }))).toEqual({})
    expect(parseChatChunk('')).toBeNull()
    expect(parseChatChunk('not json')).toBeNull()
  })

  it('流内错误（HTTP 200 但 body 里报错）要能识别', () => {
    expect(parseChatChunk(JSON.stringify({ error: { message: 'quota exceeded' } }))).toEqual({
      error: 'quota exceeded'
    })
  })
})
