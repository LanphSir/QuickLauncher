import { contextBridge, ipcRenderer } from 'electron'

function subscribe<T = unknown>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: unknown) => callback(payload as T)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  getPlugins: () => ipcRenderer.invoke('panel:get-plugins'),
  openPlugin: (id: string, query?: string, intent?: Record<string, unknown>) =>
    ipcRenderer.invoke('panel:open-plugin', { id, query, intent }),
  /** 搜索贡献：插件注册的条目（手册章节、笔记等） */
  search: (query: string) => ipcRenderer.invoke('panel:search', query),
  /** 内联结果：features:["inline"] 的插件在后台回话（有 120ms 超时） */
  inline: (query: string) => ipcRenderer.invoke('panel:inline', query),
  /** 内联结果「回车复制」用；写剪贴板统一由主进程做 */
  copyText: (text: string) => ipcRenderer.invoke('panel:copy-text', text),
  pin: (id: string, pinned: boolean) => ipcRenderer.invoke('panel:pin', { id, pinned }),
  getConfig: () => ipcRenderer.invoke('panel:get-config'),
  updateConfig: (patch: Record<string, unknown>) => ipcRenderer.invoke('panel:update-config', patch),
  hidePanel: () => ipcRenderer.invoke('panel:hide'),
  /** 浮层打开期间登记可见性：失焦不收起面板（token 由渲染层生成，关闭时释放） */
  holdVisible: (token: string) => ipcRenderer.invoke('panel:hold-visible', token),
  releaseVisible: (token: string) => ipcRenderer.invoke('panel:release-visible', token),
  savePluginOverride: (id: string, data: { command?: string; args?: string }) =>
    ipcRenderer.invoke('panel:save-plugin-override', { id, ...data }),
  /** 浏览本地文件挑可执行文件，回填 external 型插件的启动命令 */
  pickCommand: () => ipcRenderer.invoke('panel:pick-command'),
  clearPluginData: (id: string) => ipcRenderer.invoke('panel:clear-plugin-data', id),
  /** 自定义外部应用：读取/保存/删除/从系统导入 */
  getShortcuts: () => ipcRenderer.invoke('panel:get-shortcuts'),
  getShortcut: (id: string) => ipcRenderer.invoke('panel:get-shortcut', id),
  saveShortcut: (draft: Record<string, unknown>) => ipcRenderer.invoke('panel:save-shortcut', draft),
  deleteShortcut: (id: string) => ipcRenderer.invoke('panel:delete-shortcut', id),
  scanShortcutCandidates: () => ipcRenderer.invoke('panel:scan-shortcut-candidates'),
  importShortcuts: (items: { path: string; name: string }[]) => ipcRenderer.invoke('panel:import-shortcuts', items),
  pickIconImage: () => ipcRenderer.invoke('panel:pick-icon-image'),
  pickDirectory: () => ipcRenderer.invoke('panel:pick-directory'),
  installPlugin: (mode: 'dir' | 'zip') => ipcRenderer.invoke('panel:install-plugin', mode),
  uninstallPlugin: (id: string) => ipcRenderer.invoke('panel:uninstall-plugin', id),
  setPluginDisabled: (id: string, disabled: boolean) =>
    ipcRenderer.invoke('panel:set-plugin-disabled', { id, disabled }),
  /** 设置/清除插件启动快捷键（accelerator，空串 = 清除）；冲突或注册失败时 ok=false */
  setPluginHotkey: (id: string, accelerator: string) =>
    ipcRenderer.invoke('panel:set-plugin-hotkey', { id, accelerator }),
  revealPluginDir: (id: string) => ipcRenderer.invoke('panel:reveal-plugin-dir', id),
  detachPlugin: (id: string) => ipcRenderer.invoke('panel:detach-plugin', id),
  getWindowBounds: () => ipcRenderer.invoke('panel:get-window-bounds'),
  setWindowBounds: (rect: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('panel:set-window-bounds', rect),
  saveWindowBounds: () => ipcRenderer.invoke('panel:save-window-bounds'),
  togglePinned: () => ipcRenderer.invoke('panel:toggle-pinned'),
  /** 从插件页返回主界面（视图保留缓存，再进状态不丢） */
  exitPlugin: () => ipcRenderer.invoke('panel:exit-plugin'),
  /** 把当前插件页分离为独立窗口 */
  detachActive: () => ipcRenderer.invoke('panel:detach-active'),
  onShown: (callback: () => void) => subscribe('panel:shown', callback),
  onPluginOpened: (callback: (payload: { id: string; name: string; icon: string | null }) => void) =>
    subscribe<{ id: string; name: string; icon: string | null }>('panel:plugin-opened', callback),
  onPluginExited: (callback: () => void) => subscribe('panel:plugin-exited', callback),
  onPluginCrashed: (callback: (payload: { id: string; name: string }) => void) =>
    subscribe<{ id: string; name: string }>('panel:plugin-crashed', callback),
  onOpenSettings: (callback: () => void) => subscribe('panel:open-settings', callback),
  onPluginsChanged: (callback: () => void) => subscribe('panel:plugins-changed', callback),
  onPinnedChanged: (callback: (pinned: boolean) => void) =>
    subscribe<boolean>('panel:pinned-changed', callback),
  /** 内联插件页加载完成：面板用当前搜索词补查一次（首次输入时插件还没就绪的场景） */
  onInlineReady: (callback: () => void) => subscribe('panel:inline-ready', callback)
}

contextBridge.exposeInMainWorld('panel', api)
