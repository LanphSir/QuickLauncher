/**
 * SSE（Server-Sent Events）解码。
 *
 * 为什么不用现成库：这条链路只认 `data:` 行，规范里其余字段（id/retry）对聊天
 * 流没有意义；自己写三十行还能顺手单测「分片落在半个事件中间」这种真实情况
 * （fetch 的 chunk 边界与 SSE 帧边界毫无关系）。
 *
 * 有状态是必须的：一个帧可能横跨两次 read，所以解码器要在内部攒缓冲。
 */
export interface SseFrame {
  event?: string
  data: string
}

export interface SseDecoder {
  /** 喂一段文本，返回本次能完整解析出的帧 */
  push(chunk: string): SseFrame[]
  /** 流结束：把没有以空行收尾的最后一帧也吐出来 */
  flush(): SseFrame[]
}

export function createSseDecoder(): SseDecoder {
  let buffer = ''
  let event: string | undefined
  let data: string[] = []

  function dispatch(out: SseFrame[]): void {
    if (data.length) out.push({ event, data: data.join('\n') })
    event = undefined
    data = []
  }

  function consume(line: string, out: SseFrame[]): void {
    if (line === '') {
      dispatch(out)
      return
    }
    // 以 `:` 开头是注释（很多服务用它当心跳），整行忽略
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') data.push(value)
    else if (field === 'event') event = value
  }

  return {
    push(chunk: string): SseFrame[] {
      const out: SseFrame[] = []
      buffer += chunk
      let nl = buffer.indexOf('\n')
      while (nl >= 0) {
        let line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        consume(line, out)
        nl = buffer.indexOf('\n')
      }
      return out
    },
    flush(): SseFrame[] {
      const out: SseFrame[] = []
      if (buffer) {
        const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
        buffer = ''
        consume(line, out)
      }
      dispatch(out)
      return out
    }
  }
}
