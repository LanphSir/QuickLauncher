/**
 * 插件快捷键的绑定计划（纯函数）。
 *
 * 配置里存的是「用户想让哪个插件用哪个键」，能不能真注册上是两回事：
 * 插件被停用、插件已卸载、两个插件抢同一个键、键就是全局唤起键——这些都在这里判掉，
 * 并且给出人能看懂的原因。真正调 globalShortcut 的部分在 src/main/hotkey.ts。
 *
 * 之所以拆成纯函数：注册成败只有真跑起来才知道（被别的程序占用），
 * 但「该不该尝试注册」是纯逻辑，必须能单测。
 */

export interface HotkeyPluginLike {
  id: string
  name: string
  /** 已停用的插件保留配置但不注册，重新启用即可恢复 */
  disabled?: boolean
}

export interface PlannedHotkey {
  id: string
  name: string
  accelerator: string
}

export type HotkeySkipReason = 'invalid' | 'disabled' | 'reserved' | 'duplicate'

export interface SkippedHotkey extends PlannedHotkey {
  reason: HotkeySkipReason
  /** 直接丢给设置页展示，省得渲染层再拼一遍文案 */
  message: string
}

export interface PluginHotkeyPlan {
  /** 实际要尝试注册的绑定 */
  active: PlannedHotkey[]
  /** 配置了但没注册的项（含原因） */
  skipped: SkippedHotkey[]
}

/** Electron accelerator 里的修饰键（小写比较） */
const MODIFIERS = new Set([
  'commandorcontrol',
  'cmdorctrl',
  'control',
  'ctrl',
  'alt',
  'shift',
  'super',
  'meta',
  'command',
  'cmd',
  'altgr'
])

const PLUGIN_ID_RE = /^[\w.-]+$/

/** 拆键：`Ctrl + Alt + K` 和 `ctrl+alt+k` 视为同一个键 */
function parseAccelerator(raw: string): string[] {
  return raw
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
}

/** 比较用的规范形式；注册仍用原始串（Electron 对大小写不敏感，但保留用户输入的写法更好看） */
export function normalizeAccelerator(raw: string): string {
  return parseAccelerator(raw).join('+')
}

/**
 * 像不像一个组合键：至少要有一个修饰键 + 一个非修饰键的主键。
 * 不做严格白名单——Electron 认的键太多（F1-F24、num0、PageUp…），
 * 拦错了会让手写配置的人莫名其妙；真正非法的键在 register 时会被拒。
 */
export function isAcceleratorLike(raw: string): boolean {
  const parts = parseAccelerator(raw)
  if (parts.length < 2) return false
  const key = parts[parts.length - 1]
  const mods = parts.slice(0, -1)
  if (!key || MODIFIERS.has(key)) return false
  return mods.every((m) => MODIFIERS.has(m))
}

/** 读配置时洗一遍：非字符串、空串、非法 id 一律丢（脏值写进去等于给未来埋雷） */
export function sanitizeHotkeyMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') continue
    if (!PLUGIN_ID_RE.test(id)) continue
    const accelerator = value.trim()
    if (!accelerator) continue
    out[id] = accelerator
  }
  return out
}

/**
 * 生成绑定计划。
 * 遍历顺序按 id 排序：谁先占住同一个键是确定的，不会因扫描顺序变化而今天 A 明天 B。
 * `reserved` 是全局唤起键——它优先级最高，插件不能抢。
 */
export function buildPluginHotkeyPlan(
  map: Record<string, string>,
  plugins: HotkeyPluginLike[],
  reserved: string[] = []
): PluginHotkeyPlan {
  /** 归一化键 → 占用者（全局键固定是那句固定文案） */
  const taken = new Map<string, string>()
  for (const acc of reserved) {
    const key = normalizeAccelerator(acc)
    if (key) taken.set(key, '全局唤起快捷键')
  }

  const active: PlannedHotkey[] = []
  const skipped: SkippedHotkey[] = []

  const ordered = [...plugins].sort((a, b) => a.id.localeCompare(b.id))
  for (const plugin of ordered) {
    const accelerator = map[plugin.id]?.trim()
    if (!accelerator) continue

    const skip = (reason: HotkeySkipReason, message: string): void => {
      skipped.push({ id: plugin.id, name: plugin.name, accelerator, reason, message })
    }

    if (!isAcceleratorLike(accelerator)) {
      skip('invalid', `${accelerator} 不是有效的组合键（至少要有 Alt / Ctrl / Shift / Win 之一）`)
      continue
    }
    if (plugin.disabled) {
      skip('disabled', '插件已停用，快捷键暂不生效')
      continue
    }
    const key = normalizeAccelerator(accelerator)
    const holder = taken.get(key)
    if (holder) {
      const reservedHit = holder === '全局唤起快捷键'
      skip(reservedHit ? 'reserved' : 'duplicate', `与${holder}冲突`)
      continue
    }
    taken.set(key, `「${plugin.name}」`)
    active.push({ id: plugin.id, name: plugin.name, accelerator })
  }

  return { active, skipped }
}
