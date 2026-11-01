import { globalShortcut } from 'electron'

/**
 * 全局快捷键注册表。
 *
 * 应用里有两类全局键：唤起面板（唯一）和每个插件各自的启动键（多个）。
 * 过去这里只维护一个 current 变量，加第二个用途就得复制一份状态；
 * 现在统一成「owner → 绑定」的表，注册是差量的：
 * 键没变就一个系统调用都不发（plugin 表每次重扫都会调一次同步，不能抖），
 * 某一项失败也只影响它自己，不会把别人的键一起带走。
 */

/** 唤起面板的归属名；插件用自己的插件 id 作 owner */
export const TOGGLE_OWNER = '__toggle__'

export interface HotkeyBinding {
  owner: string
  accelerator: string
  action: () => void
}

export interface HotkeyApplyResult {
  owner: string
  accelerator: string
  ok: boolean
  message?: string
}

interface Registered {
  accelerator: string
  action: () => void
}

/** 期望注册的绑定（owner → 绑定），由 syncHotkeys 整体替换 */
const desired = new Map<string, HotkeyBinding>()
/** 当前真正生效的绑定 */
const registered = new Map<string, Registered>()

let toggleAction: (() => void) | null = null

export function initHotkey(toggleFn: () => void): void {
  toggleAction = toggleFn
  const cur = desired.get(TOGGLE_OWNER)
  if (cur) cur.action = toggleFn
}

/**
 * 向系统注册一个**稳定的转发函数**。
 *
 * 直接把 `action` 交给 Electron 是不行的：系统侧记住的是当时那个闭包，
 * 之后只改 `registered` 里的 action 对系统无效（按下还是跑旧回调）。
 * 而每次插件重扫都会重建闭包——要是靠"回调变了就重新 register"来更新，
 * 每扫一次键就短暂失效一次。转发函数让系统侧永远指向 owner 当前的回调。
 */
function bindSystem(owner: string, accelerator: string): boolean {
  return globalShortcut.register(accelerator, () => registered.get(owner)?.action())
}

/** 失败时把该 owner 原来的键接回去：改一个键没成功，不该把旧键也弄丢 */
function restore(owner: string, previous: Map<string, Registered>): void {
  const prev = previous.get(owner)
  if (!prev) return
  try {
    if (bindSystem(owner, prev.accelerator)) {
      registered.set(owner, prev)
      previous.delete(owner)
    }
  } catch {
    /* 旧键也接不回去就只能算了，调用方会回滚配置 */
  }
}

function flush(): HotkeyApplyResult[] {
  const results: HotkeyApplyResult[] = []
  const previous = new Map<string, Registered>()

  // 1) 解绑：不再需要这个 owner，或换了键
  for (const [owner, cur] of [...registered]) {
    const want = desired.get(owner)
    if (want && want.accelerator === cur.accelerator) continue
    try {
      globalShortcut.unregister(cur.accelerator)
    } catch {
      /* 已经不在系统里了，忽略 */
    }
    previous.set(owner, cur)
    registered.delete(owner)
  }

  // 2) 绑定：新加的、换了键的；没变的只更新回调（热重载后回调是新的闭包）
  for (const [owner, want] of desired) {
    const cur = registered.get(owner)
    if (cur && cur.accelerator === want.accelerator) {
      cur.action = want.action
      results.push({ owner, accelerator: want.accelerator, ok: true })
      continue
    }
    if (!want.accelerator) {
      // 空 = 主动解绑（不是失败）。第 1 步已经 unregister 过了，这里不能 restore，
      // 否则"清除唤起快捷键"会被判成注册失败、旧键又被接回去，用户会觉得清不掉。
      results.push({ owner, accelerator: '', ok: true })
      continue
    }
    try {
      if (!bindSystem(owner, want.accelerator)) {
        results.push({
          owner,
          accelerator: want.accelerator,
          ok: false,
          message: `快捷键 ${want.accelerator} 注册失败，可能已被其他程序占用`
        })
        restore(owner, previous)
        continue
      }
    } catch {
      results.push({ owner, accelerator: want.accelerator, ok: false, message: `快捷键 ${want.accelerator} 格式无效` })
      restore(owner, previous)
      continue
    }
    registered.set(owner, { accelerator: want.accelerator, action: want.action })
    results.push({ owner, accelerator: want.accelerator, ok: true })
  }

  // 3) 已在第 1 步解绑又不在 desired 里的 owner 就是被移除的，不恢复
  return results
}

/** 整体同步绑定表（幂等：重复调用只动真正变化的项） */
export function syncHotkeys(bindings: HotkeyBinding[]): HotkeyApplyResult[] {
  desired.clear()
  for (const b of bindings) {
    const accelerator = b.accelerator.trim()
    if (!accelerator) continue
    desired.set(b.owner, { owner: b.owner, accelerator, action: b.action })
  }
  return flush()
}

/**
 * 只改唤起键（设置页用）；失败时旧键仍在生效。
 * 传空串 = 解绑（允许用户不用全局快捷键，只用托盘/面板按钮唤起）。
 */
export function registerHotkey(accelerator: string): { ok: boolean; message?: string } {
  if (!toggleAction) return { ok: false, message: '快捷键尚未初始化' }
  const acc = accelerator.trim()
  if (!acc) {
    desired.delete(TOGGLE_OWNER)
    flush()
    return { ok: true }
  }
  desired.set(TOGGLE_OWNER, { owner: TOGGLE_OWNER, accelerator: acc, action: toggleAction })
  const mine = flush().find((r) => r.owner === TOGGLE_OWNER)
  if (mine?.ok) return { ok: true }
  return { ok: false, message: mine?.message ?? '快捷键注册失败' }
}

export function unregisterAll(): void {
  globalShortcut.unregisterAll()
  desired.clear()
  registered.clear()
}
