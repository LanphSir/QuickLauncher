import { clipboard, ipcMain, Notification, shell } from 'electron'
import { getCaller } from './callerRegistry'
import { pluginStorage } from '../services/storage'
import { exitPlugin } from '../windows/pluginHost'
import { hidePanel } from '../windows/panel'
import type { PluginRecord } from './manager'

type Handler = (rec: PluginRecord, payload: any) => unknown

/** 通道 -> 所需权限；未列出的通道（窗口控制/退出/自述信息）默认放行 */
const PERMS: Record<string, string> = {
  'plugin:storage.get': 'storage',
  'plugin:storage.set': 'storage',
  'plugin:storage.remove': 'storage',
  'plugin:storage.keys': 'storage',
  'plugin:clipboard.readText': 'clipboard',
  'plugin:clipboard.writeText': 'clipboard',
  'plugin:notify': 'notify',
  'plugin:shell.openExternal': 'shell'
}

function handle(channel: string, handler: Handler): void {
  ipcMain.handle(channel, async (event, payload) => {
    const rec = getCaller(event.sender)
    if (!rec) throw new Error('gateway: 未注册的调用方')
    const perm = PERMS[channel]
    if (perm && !(rec.manifest.permissions ?? []).includes(perm)) {
      throw new Error(`插件 ${rec.manifest.id} 缺少权限: ${perm}（请在 plugin.json 的 permissions 中声明）`)
    }
    return handler(rec, payload)
  })
}

export function initGateway(): void {
  handle('plugin:info', (rec) => ({
    id: rec.manifest.id,
    name: rec.manifest.name,
    version: rec.manifest.version,
    permissions: rec.manifest.permissions ?? []
  }))
  handle('plugin:storage.get', (rec, key: string) => pluginStorage.get(rec.manifest.id, key))
  handle('plugin:storage.set', (rec, { key, value }) => {
    pluginStorage.set(rec.manifest.id, key, value)
    return true
  })
  handle('plugin:storage.remove', (rec, key: string) => {
    pluginStorage.remove(rec.manifest.id, key)
    return true
  })
  handle('plugin:storage.keys', (rec) => pluginStorage.keys(rec.manifest.id))
  handle('plugin:clipboard.readText', () => clipboard.readText())
  handle('plugin:clipboard.writeText', (_rec, text: string) => {
    clipboard.writeText(String(text ?? ''))
    return true
  })
  handle('plugin:notify', (rec, { title, body }) => {
    new Notification({ title: title || rec.manifest.name, body: body ?? '' }).show()
    return true
  })
  handle('plugin:shell.openExternal', (_rec, url: string) => {
    if (!/^https?:\/\//i.test(String(url))) throw new Error('仅允许 http(s) 链接')
    void shell.openExternal(String(url))
    return true
  })
  handle('plugin:window.hide', () => {
    hidePanel()
    return true
  })
  handle('plugin:exit', () => {
    exitPlugin()
    return true
  })
}
