import { describe, expect, it } from 'vitest'
import {
  buildPluginHotkeyPlan,
  isAcceleratorLike,
  normalizeAccelerator,
  sanitizeHotkeyMap
} from '../src/main/plugin/hotkeyPlan'

const plugins = [
  { id: 'com.a.clipboard', name: '剪贴板' },
  { id: 'com.b.calc', name: '计算器' },
  { id: 'com.c.off', name: '已停用的', disabled: true }
]

describe('normalizeAccelerator：比较用的规范形式', () => {
  it('大小写与空格不影响判等', () => {
    expect(normalizeAccelerator(' Ctrl + Alt + K ')).toBe('ctrl+alt+k')
    expect(normalizeAccelerator('ctrl+alt+k')).toBe(normalizeAccelerator('Ctrl+Alt+K'))
  })

  it('丢掉空段，避免 Ctrl++K 这种手写串被判成不同键', () => {
    expect(normalizeAccelerator('Ctrl++K')).toBe('ctrl+k')
  })
})

describe('isAcceleratorLike：像不像组合键', () => {
  it('接受常见写法', () => {
    expect(isAcceleratorLike('Alt+Space')).toBe(true)
    expect(isAcceleratorLike('CommandOrControl+Shift+F5')).toBe(true)
    expect(isAcceleratorLike('Ctrl+Alt+K')).toBe(true)
  })

  it('拒绝单键与纯修饰键', () => {
    expect(isAcceleratorLike('K')).toBe(false)
    expect(isAcceleratorLike('Alt')).toBe(false)
    expect(isAcceleratorLike('Ctrl+Alt')).toBe(false)
    expect(isAcceleratorLike('')).toBe(false)
  })
})

describe('sanitizeHotkeyMap：配置读写的白名单', () => {
  it('丢掉非字符串、空串与非法 id', () => {
    expect(
      sanitizeHotkeyMap({
        'com.a.clipboard': ' Alt+Shift+V ',
        'com.b.calc': '',
        'com.c.off': 42,
        'has space': 'Ctrl+1',
        'com.d.null': null
      })
    ).toEqual({ 'com.a.clipboard': 'Alt+Shift+V' })
  })

  it('非对象输入返回空表而不是抛错', () => {
    expect(sanitizeHotkeyMap(null)).toEqual({})
    expect(sanitizeHotkeyMap(['Ctrl+K'])).toEqual({})
    expect(sanitizeHotkeyMap('Ctrl+K')).toEqual({})
  })
})

describe('buildPluginHotkeyPlan：哪些键真的去注册', () => {
  it('启用的插件按配置进 active', () => {
    const plan = buildPluginHotkeyPlan({ 'com.a.clipboard': 'Alt+Shift+V' }, plugins, ['Alt+Space'])
    expect(plan.active).toEqual([
      { id: 'com.a.clipboard', name: '剪贴板', accelerator: 'Alt+Shift+V' }
    ])
    expect(plan.skipped).toEqual([])
  })

  it('停用的插件保留配置但不注册', () => {
    const plan = buildPluginHotkeyPlan({ 'com.c.off': 'Ctrl+Alt+O' }, plugins)
    expect(plan.active).toEqual([])
    expect(plan.skipped[0]).toMatchObject({ id: 'com.c.off', reason: 'disabled' })
  })

  it('与全局唤起键冲突时报 reserved', () => {
    const plan = buildPluginHotkeyPlan({ 'com.b.calc': 'alt+space' }, plugins, ['Alt+Space'])
    expect(plan.active).toEqual([])
    expect(plan.skipped[0].reason).toBe('reserved')
    expect(plan.skipped[0].message).toContain('全局唤起')
  })

  it('两个插件抢同一个键时按 id 顺序先到先得，后者报 duplicate', () => {
    const plan = buildPluginHotkeyPlan(
      { 'com.b.calc': 'Ctrl+Alt+K', 'com.a.clipboard': 'ctrl+alt+k' },
      plugins
    )
    expect(plan.active.map((x) => x.id)).toEqual(['com.a.clipboard'])
    expect(plan.skipped).toHaveLength(1)
    expect(plan.skipped[0]).toMatchObject({ id: 'com.b.calc', reason: 'duplicate' })
    expect(plan.skipped[0].message).toContain('剪贴板')
  })

  it('格式非法报 invalid，不影响其它插件', () => {
    const plan = buildPluginHotkeyPlan(
      { 'com.a.clipboard': 'K', 'com.b.calc': 'Ctrl+Alt+C' },
      plugins
    )
    expect(plan.active.map((x) => x.id)).toEqual(['com.b.calc'])
    expect(plan.skipped[0]).toMatchObject({ id: 'com.a.clipboard', reason: 'invalid' })
  })

  it('插件已卸载时配置残留不会变成 skip 项，也不会注册', () => {
    const plan = buildPluginHotkeyPlan({ 'com.gone.x': 'Ctrl+Alt+X' }, plugins)
    expect(plan.active).toEqual([])
    expect(plan.skipped).toEqual([])
  })

  it('空值视为未设置', () => {
    const plan = buildPluginHotkeyPlan({ 'com.a.clipboard': '   ' }, plugins)
    expect(plan.active).toEqual([])
    expect(plan.skipped).toEqual([])
  })
})
