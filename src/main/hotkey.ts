import { globalShortcut } from 'electron'

let current: string | null = null
let toggle: () => void = () => {}

export function initHotkey(toggleFn: () => void): void {
  toggle = toggleFn
}

/** 注册全局快捷键；失败时回滚到原快捷键 */
export function registerHotkey(accelerator: string): { ok: boolean; message?: string } {
  if (current === accelerator) return { ok: true }
  const previous = current
  if (current) globalShortcut.unregister(current)
  try {
    if (!globalShortcut.register(accelerator, toggle)) {
      if (previous) globalShortcut.register(previous, toggle)
      return { ok: false, message: `快捷键 ${accelerator} 注册失败，可能已被其他程序占用` }
    }
    current = accelerator
    return { ok: true }
  } catch {
    if (previous) {
      try {
        globalShortcut.register(previous, toggle)
      } catch {
        /* ignore */
      }
    }
    return { ok: false, message: `快捷键 ${accelerator} 格式无效` }
  }
}

export function getCurrentHotkey(): string | null {
  return current
}

export function unregisterAll(): void {
  globalShortcut.unregisterAll()
  current = null
}
