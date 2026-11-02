import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  answerConfirm,
  askConfirm,
  cancelConfirms,
  needsConfirm,
  resetSessionGrants
} from '../src/main/ai/confirm'
import type { AiStreamEvent } from '../src/shared/ai'

function collector(): { events: AiStreamEvent[]; notify: (e: AiStreamEvent) => void } {
  const events: AiStreamEvent[] = []
  return { events, notify: (e) => events.push(e) }
}

const tool = { fullName: 'launcher.open', title: '打开启动器条目', risk: 'write' as const, args: '{"target":"快速翻译"}' }

beforeEach(() => {
  resetSessionGrants()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('风险分级', () => {
  it('read 不问，write 要问，dangerous 每次都要问', () => {
    expect(needsConfirm('read', 's1', 'clipboard.read')).toBe(false)
    expect(needsConfirm('write', 's1', 'launcher.open')).toBe(true)
    expect(needsConfirm('dangerous', 's1', 'evil.wipe')).toBe(true)
  })

  it('勾了「本次会话不再询问」后 write 不再问，但换会话要重新问', async () => {
    const c = collector()
    const pending = askConfirm({ sessionId: 's1', messageId: 'm1', notify: c.notify }, tool)
    const request = c.events.find((e) => e.type === 'tool-confirm')
    expect(request).toBeTruthy()
    if (request?.type !== 'tool-confirm') throw new Error('缺少确认事件')
    expect(request.request.rememberable).toBe(true)
    expect(answerConfirm(request.request.requestId, true, true)).toBe(true)
    await expect(pending).resolves.toMatchObject({ allowed: true, kind: 'allowed' })

    expect(needsConfirm('write', 's1', 'launcher.open')).toBe(false)
    expect(needsConfirm('write', 's2', 'launcher.open')).toBe(true)
  })

  it('dangerous 不给「不再询问」的选项', async () => {
    const c = collector()
    const pending = askConfirm(
      { sessionId: 's1', messageId: 'm1', notify: c.notify },
      { fullName: 'evil.wipe', title: '清空', risk: 'dangerous', args: '{}' }
    )
    const request = c.events[0]
    if (request.type !== 'tool-confirm') throw new Error('缺少确认事件')
    expect(request.request.rememberable).toBe(false)
    answerConfirm(request.request.requestId, true, true)
    await expect(pending).resolves.toMatchObject({ allowed: true })
    // 即使记得过，下一次仍然要问
    expect(needsConfirm('dangerous', 's1', 'evil.wipe')).toBe(true)
  })
})

describe('确认的收尾', () => {
  it('没人回答时按超时拒绝，并通知界面收起', async () => {
    const c = collector()
    const pending = askConfirm({ sessionId: 's1', messageId: 'm1', notify: c.notify }, tool)
    vi.advanceTimersByTime(60_000)
    await expect(pending).resolves.toMatchObject({ allowed: false, kind: 'timeout' })
    expect(c.events.some((e) => e.type === 'tool-confirm-close')).toBe(true)
  })

  it('停止生成会把等待中的确认按拒绝收尾', async () => {
    const c = collector()
    const pending = askConfirm({ sessionId: 's9', messageId: 'm1', notify: c.notify }, tool)
    cancelConfirms('s9')
    await expect(pending).resolves.toMatchObject({ allowed: false, kind: 'denied' })
  })

  it('超时后再点按钮不会二次生效', async () => {
    const c = collector()
    const pending = askConfirm({ sessionId: 's1', messageId: 'm1', notify: c.notify }, tool)
    const request = c.events[0]
    if (request.type !== 'tool-confirm') throw new Error('缺少确认事件')
    vi.advanceTimersByTime(60_000)
    await pending
    expect(answerConfirm(request.request.requestId, true)).toBe(false)
  })
})
