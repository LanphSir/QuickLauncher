import { contextBridge, ipcRenderer } from 'electron'

function subscribe<T = unknown>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: unknown) => callback(payload as T)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  getPlugins: () => ipcRenderer.invoke('panel:get-plugins'),
  openPlugin: (id: string, query?: string) => ipcRenderer.invoke('panel:open-plugin', { id, query }),
  pin: (id: string, pinned: boolean) => ipcRenderer.invoke('panel:pin', { id, pinned }),
  getConfig: () => ipcRenderer.invoke('panel:get-config'),
  updateConfig: (patch: Record<string, unknown>) => ipcRenderer.invoke('panel:update-config', patch),
  hidePanel: () => ipcRenderer.invoke('panel:hide'),
  savePluginOverride: (id: string, data: { command?: string; args?: string }) =>
    ipcRenderer.invoke('panel:save-plugin-override', { id, ...data }),
  clearPluginData: (id: string) => ipcRenderer.invoke('panel:clear-plugin-data', id),
  onShown: (callback: () => void) => subscribe('panel:shown', callback),
  onPluginExited: (callback: () => void) => subscribe('panel:plugin-exited', callback),
  onPluginCrashed: (callback: (payload: { id: string; name: string }) => void) =>
    subscribe<{ id: string; name: string }>('panel:plugin-crashed', callback),
  onOpenSettings: (callback: () => void) => subscribe('panel:open-settings', callback)
}

contextBridge.exposeInMainWorld('panel', api)
