import { contextBridge, ipcRenderer } from 'electron'

const invoke = (channel: string, payload?: unknown) => ipcRenderer.invoke(channel, payload)

/**
 * 插件可用的受控 API（window.appapi）。
 * 主进程网关会校验调用方身份与 plugin.json 声明的权限。
 */
contextBridge.exposeInMainWorld('appapi', {
  info: () => invoke('plugin:info'),
  storage: {
    get: (key: string) => invoke('plugin:storage.get', key),
    set: (key: string, value: unknown) => invoke('plugin:storage.set', { key, value }),
    remove: (key: string) => invoke('plugin:storage.remove', key),
    keys: () => invoke('plugin:storage.keys')
  },
  clipboard: {
    readText: () => invoke('plugin:clipboard.readText'),
    writeText: (text: string) => invoke('plugin:clipboard.writeText', text)
  },
  notify: (title: string, body?: string) => invoke('plugin:notify', { title, body }),
  shell: {
    openExternal: (url: string) => invoke('plugin:shell.openExternal', url)
  },
  window: {
    hide: () => invoke('plugin:window.hide')
  },
  exit: () => invoke('plugin:exit')
})
