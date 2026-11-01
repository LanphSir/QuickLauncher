import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 全局快捷键注册表的差量同步逻辑（`src/main/hotkey.ts`）。
 *
 * 这里用一张内存表替掉 Electron 的 globalShortcut：它只是"系统同不同意这个键"的开关，
 * 而我们真正要锁的是"改键/解绑/失败回滚时注册表怎么变"。
 */
const state = vi.hoisted(() => ({
  registered: new Map<string, () => void>(),
  /** 模拟被别的程序（或系统）占用的键 */
  blocked: new Set<string>(),
  attempts: [] as string[]
}))

vi.mock('electron', () => ({
  globalShortcut: {
    register(accelerator: string, fn: () => void) {
      state.attempts.push(accelerator)
      if (state.blocked.has(accelerator)) return false
      state.registered.set(accelerator, fn)
      return true
    },
    unregister(accelerator: string) {
      state.registered.delete(accelerator)
    },
    unregisterAll() {
      state.registered.clear()
    }
  }
}))

const { initHotkey, registerHotkey, syncHotkeys, unregisterAll, TOGGLE_OWNER } = await import(
  '../src/main/hotkey'
)

const noop = (): void => {}

beforeEach(() => {
  unregisterAll()
  state.blocked.clear()
  state.attempts = []
  initHotkey(noop)
})

describe('唤起键解绑', () => {
  it('注册后出现在系统里', () => {
    expect(registerHotkey('Ctrl+Shift+K').ok).toBe(true)
    expect([...state.registered.keys()]).toEqual(['Ctrl+Shift+K'])
  })

  it('空串表示解绑：返回成功且真的注销（不能报"注册失败"再把旧键接回去）', () => {
    registerHotkey('Ctrl+Shift+K')
    const result = registerHotkey('')
    expect(result.ok).toBe(true)
    expect(state.registered.size).toBe(0)
  })

  it('本来就没绑定时解绑也是成功（幂等）', () => {
    expect(registerHotkey('').ok).toBe(true)
    expect(state.registered.size).toBe(0)
  })

  it('解绑后可以再绑回来', () => {
    registerHotkey('Ctrl+Shift+K')
    registerHotkey('')
    expect(registerHotkey('Ctrl+Shift+K').ok).toBe(true)
    expect([...state.registered.keys()]).toEqual(['Ctrl+Shift+K'])
  })

  it('syncHotkeys 里没有这一项（配置清了键）也会解绑', () => {
    registerHotkey('Ctrl+Shift+K')
    const results = syncHotkeys([{ owner: 'com.test.a', accelerator: 'Ctrl+Alt+A', action: noop }])
    expect(state.registered.has('Ctrl+Shift+K')).toBe(false)
    expect(state.registered.has('Ctrl+Alt+A')).toBe(true)
    // 没有唤起键的同步结果里不该冒出一条"唤起键失败"
    expect(results.find((r) => r.owner === TOGGLE_OWNER)).toBeUndefined()
  })
})

describe('差量同步', () => {
  it('键没变就不重复调系统接口', () => {
    syncHotkeys([{ owner: 'com.test.a', accelerator: 'Ctrl+Alt+A', action: noop }])
    state.attempts = []
    syncHotkeys([{ owner: 'com.test.a', accelerator: 'Ctrl+Alt+A', action: noop }])
    expect(state.attempts).toEqual([])
  })

  it('只换回调不算换键，但按下要跑新回调', () => {
    const fired: string[] = []
    const first = (): void => {
      fired.push('first')
    }
    const second = (): void => {
      fired.push('second')
    }
    syncHotkeys([{ owner: 'com.test.a', accelerator: 'Ctrl+Alt+A', action: first }])
    state.attempts = []
    syncHotkeys([{ owner: 'com.test.a', accelerator: 'Ctrl+Alt+A', action: second }])
    expect(state.attempts).toEqual([]) // 没退/重注册，避免"每次重扫键都短暂失效"
    state.registered.get('Ctrl+Alt+A')?.()
    expect(fired).toEqual(['second'])
  })

  it('某一项被占用不影响其他项', () => {
    state.blocked.add('Ctrl+Alt+A')
    const results = syncHotkeys([
      { owner: 'a', accelerator: 'Ctrl+Alt+A', action: noop },
      { owner: 'b', accelerator: 'Ctrl+Alt+B', action: noop }
    ])
    expect(results.find((r) => r.owner === 'a')?.ok).toBe(false)
    expect(results.find((r) => r.owner === 'b')?.ok).toBe(true)
    expect(state.registered.has('Ctrl+Alt+B')).toBe(true)
  })

  it('改键失败时把原键接回去（不能"改坏了连旧键也没了"）', () => {
    syncHotkeys([{ owner: 'a', accelerator: 'Ctrl+Alt+A', action: noop }])
    state.blocked.add('Ctrl+Alt+Z')
    const results = syncHotkeys([{ owner: 'a', accelerator: 'Ctrl+Alt+Z', action: noop }])
    expect(results[0].ok).toBe(false)
    expect([...state.registered.keys()]).toEqual(['Ctrl+Alt+A'])
  })

  it('空 accelerators 不注册也不报错（插件计划表会先过滤掉）', () => {
    const results = syncHotkeys([{ owner: 'a', accelerator: '  ', action: noop }])
    expect(results).toEqual([])
    expect(state.registered.size).toBe(0)
  })
})
