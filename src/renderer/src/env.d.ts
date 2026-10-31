/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

interface PluginSummary {
  id: string
  name: string
  version?: string
  description?: string
  type: 'web' | 'external'
  keywords: string[]
  icon: string | null
  pinned: boolean
  /** 申请的 API 权限（详情页展示） */
  permissions?: string[]
  /** 插件来源：builtin 随应用发布 / installed 用户安装 */
  source?: 'builtin' | 'installed'
  /** 已停用（设置中可重新启用） */
  disabled?: boolean
  /** external 型当前生效的启动命令/参数（含用户覆盖） */
  command?: string
  args?: string[]
  /** 插件磁盘目录（详情页展示用） */
  dir?: string
}

interface LauncherConfig {
  hotkey: string
  autostart: boolean
  pinnedIds: string[]
  pluginOverrides: Record<string, { command?: string; args?: string[] }>
  isPackaged: boolean
}

interface PanelApi {
  getPlugins(): Promise<PluginSummary[]>
  openPlugin(id: string, query?: string): Promise<{ ok: boolean; message?: string }>
  pin(id: string, pinned: boolean): Promise<string[]>
  getConfig(): Promise<LauncherConfig>
  updateConfig(patch: Partial<LauncherConfig>): Promise<{ ok: boolean; config?: LauncherConfig; message?: string }>
  hidePanel(): Promise<void>
  savePluginOverride(
    id: string,
    data: { command?: string; args?: string }
  ): Promise<{ ok: boolean; command?: string; args?: string[]; message?: string }>
  clearPluginData(id: string): Promise<{ ok: boolean }>
  installPlugin(mode: 'dir' | 'zip'): Promise<{ ok: boolean; canceled?: boolean; message?: string }>
  uninstallPlugin(id: string): Promise<{ ok: boolean; message?: string }>
  setPluginDisabled(id: string, disabled: boolean): Promise<{ ok: boolean }>
  revealPluginDir(id: string): Promise<{ ok: boolean }>
  detachPlugin(id: string): Promise<{ ok: boolean; message?: string }>
  getWindowBounds(): Promise<{ x: number; y: number; width: number; height: number } | null>
  setWindowBounds(rect: { x: number; y: number; width: number; height: number }): Promise<boolean>
  saveWindowBounds(): Promise<boolean>
  togglePinned(): Promise<{ pinned: boolean }>
  exitPlugin(): Promise<{ ok: boolean }>
  detachActive(): Promise<{ ok: boolean; message?: string }>
  onShown(callback: () => void): void
  onPluginOpened(callback: (payload: { id: string; name: string; icon: string | null }) => void): void
  onPluginExited(callback: () => void): void
  onPluginCrashed(callback: (payload: { id: string; name: string }) => void): void
  onOpenSettings(callback: () => void): void
  onPluginsChanged(callback: () => void): void
  onPinnedChanged(callback: (pinned: boolean) => void): void
}

interface PluginApi {
  info(): Promise<{ id: string; name: string; version?: string; permissions: string[] }>
  /** 打开插件时面板搜索词（每次打开/带新搜索词重开都会推送一次） */
  onQuery(callback: (payload: { query?: string }) => void): void
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<boolean>
    remove(key: string): Promise<boolean>
    keys(): Promise<string[]>
  }
  clipboard: {
    readText(): Promise<string>
    writeText(text: string): Promise<boolean>
  }
  notify(title: string, body?: string): Promise<boolean>
  shell: { openExternal(url: string): Promise<boolean> }
  window: {
    hide(): Promise<boolean>
    /** 把当前插件分离为独立窗口（状态保留，任务栏可见） */
    detach(): Promise<{ ok: boolean; message?: string }>
  }
  exit(): Promise<boolean>
}

interface Window {
  panel: PanelApi
  appapi: PluginApi
}
