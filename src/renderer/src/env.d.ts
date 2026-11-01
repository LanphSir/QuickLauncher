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
  /** 声明参与的功能形态（inline 等） */
  features?: string[]
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

/** 插件通过 appapi.search.set 注册的可搜条目（主进程补全插件归属后返回） */
interface SearchHit {
  id: string
  title: string
  subtitle?: string
  keywords?: string[]
  group?: string
  weight?: number
  intent?: Record<string, unknown>
  pluginId: string
  pluginName: string
  icon: string | null
}

interface PanelApi {
  getPlugins(): Promise<PluginSummary[]>
  openPlugin(
    id: string,
    query?: string,
    intent?: Record<string, unknown>
  ): Promise<{ ok: boolean; message?: string }>
  search(query: string): Promise<SearchHit[]>
  /** 内联结果：声明 features:["inline"] 的插件在后台回话，超时（120ms）即返回已到的部分 */
  inline(query: string): Promise<import('../../shared/inline').InlineHit[]>
  /** 内联结果回车复制的落地：写剪贴板由主进程统一做 */
  copyText(text: string): Promise<boolean>
  pin(id: string, pinned: boolean): Promise<string[]>
  getConfig(): Promise<LauncherConfig>
  updateConfig(patch: Partial<LauncherConfig>): Promise<{ ok: boolean; config?: LauncherConfig; message?: string }>
  hidePanel(): Promise<void>
  savePluginOverride(
    id: string,
    data: { command?: string; args?: string }
  ): Promise<{ ok: boolean; command?: string; args?: string[]; message?: string }>
  /** 浏览本地文件挑一个可执行文件（取消时 canceled=true） */
  pickCommand(): Promise<{ ok: boolean; canceled?: boolean; path?: string; message?: string }>
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
  /** 内联插件页刚加载完：用当前搜索词补查一次，避免第一次输入看不到结果 */
  onInlineReady(callback: () => void): void
}

interface Window {
  panel: PanelApi
  /** appapi 的声明在 src/shared/appapi.global.d.ts（与 preload 实现同源） */
}