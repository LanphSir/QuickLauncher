import { describe, expect, it } from 'vitest'
import { PLUGIN_FEATURES, PLUGIN_PERMISSIONS, PLUGIN_PERMS } from '../src/shared/pluginApi'
import { pluginAppUrl, pluginHostOf } from '../src/main/plugin/urls'

describe('能力契约表', () => {
  it('通道声明的权限必须是已定义的权限名（拼错会在运行期变成"永远没权限"）', () => {
    const known = new Set<string>(PLUGIN_PERMISSIONS)
    for (const [channel, perm] of Object.entries(PLUGIN_PERMS)) {
      if (perm === null) continue
      expect(known.has(perm), `${channel} 声明了未知权限 ${perm}`).toBe(true)
    }
  })

  it('每个业务通道都有明确的权限结论（不允许漏配成 undefined）', () => {
    for (const [channel, perm] of Object.entries(PLUGIN_PERMS)) {
      expect(perm === null || typeof perm === 'string', `${channel} 缺少权限声明`).toBe(true)
    }
    // 窗口控制 / 退出 / 自述 / 内联回传属于"插件对自己做的事"，不该要权限
    expect(PLUGIN_PERMS['plugin:exit']).toBeNull()
    expect(PLUGIN_PERMS['plugin:inline.set']).toBeNull()
    expect(PLUGIN_PERMS['plugin:info']).toBeNull()
    // 这些必须走权限：跨进程读写用户数据/网络
    expect(PLUGIN_PERMS['plugin:storage.set']).toBe('storage')
    expect(PLUGIN_PERMS['plugin:net.request']).toBe('net')
  })

  it('features 与 permissions 是两个维度，内联不在权限列表里', () => {
    expect(PLUGIN_FEATURES).toContain('inline')
    expect(PLUGIN_PERMISSIONS as readonly string[]).not.toContain('inline')
  })
})

describe('plugin:// 地址', () => {
  it('构造时去掉多余的前导斜杠，缺省入口是 index.html', () => {
    expect(pluginAppUrl('calc')).toBe('plugin://calc/index.html')
    expect(pluginAppUrl('calc', '/dist/index.html')).toBe('plugin://calc/dist/index.html')
    expect(pluginAppUrl('calc', '')).toBe('plugin://calc/index.html')
  })

  it('host 解析只认 plugin://，并统一小写', () => {
    expect(pluginHostOf('plugin://Calculator/index.html')).toBe('calculator')
    expect(pluginHostOf('plugin://calc/a/b?x=1#h')).toBe('calc')
    expect(pluginHostOf('https://example.com')).toBeNull()
    expect(pluginHostOf('')).toBeNull()
    expect(pluginHostOf('not a url')).toBeNull()
  })
})
