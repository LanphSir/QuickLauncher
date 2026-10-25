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
  installPlugin: (mode: 'dir' | 'zip') => ipcRenderer.invoke('panel:install-plugin', mode),
  uninstallPlugin: (id: string) => ipcRenderer.invoke('panel:uninstall-plugin', id),
  setPluginDisabled: (id: string, disabled: boolean) =>
    ipcRenderer.invoke('panel:set-plugin-disabled', { id, disabled }),
  revealPluginDir: (id: string) => ipcRenderer.invoke('panel:reveal-plugin-dir', id),
  detachPlugin: (id: string) => ipcRenderer.invoke('panel:detach-plugin', id),
  getWindowBounds: () => ipcRenderer.invoke('panel:get-window-bounds'),
  setWindowBounds: (rect: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('panel:set-window-bounds', rect),
  saveWindowBounds: () => ipcRenderer.invoke('panel:save-window-bounds'),
  togglePinned: () => ipcRenderer.invoke('panel:toggle-pinned'),
  onShown: (callback: () => void) => subscribe('panel:shown', callback),
  onPluginExited: (callback: () => void) => subscribe('panel:plugin-exited', callback),
  onPluginCrashed: (callback: (payload: { id: string; name: string }) => void) =>
    subscribe<{ id: string; name: string }>('panel:plugin-crashed', callback),
  onOpenSettings: (callback: () => void) => subscribe('panel:open-settings', callback),
  onPluginsChanged: (callback: () => void) => subscribe('panel:plugins-changed', callback),
  onPinnedChanged: (callback: (pinned: boolean) => void) =>
    subscribe<boolean>('panel:pinned-changed', callback)
}

contextBridge.exposeInMainWorld('panel', api)
