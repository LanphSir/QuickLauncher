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
  /** 插件来源：builtin 随应用发布 / installed 用户安装 / shortcut 用户自建的外部应用 */
  source?: 'builtin' | 'installed' | 'shortcut'
  /** 已停用（设置中可重新启用） */
  disabled?: boolean
  /** external 型当前生效的启动命令/参数（含用户覆盖） */
  command?: string
  args?: string[]
  /** 插件磁盘目录（详情页展示用） */
  dir?: string
  /** 用户为它设置的启动快捷键（accelerator，未设置为空串） */
  hotkey?: string
  /** 插件作者在 manifest 里的建议快捷键（仅提示，不自动注册） */
  hotkeySuggestion?: string
  /** 快捷键当前没生效的原因（冲突/被占用）；空表示正常或未设置 */
  hotkeyError?: string
}

/** 自定义外部应用：存在 userData/shortcuts.json，扫描时注入插件表（source='shortcut'） */
interface ShortcutEntry {
  id: string
  name: string
  command: string
  args: string[]
  workDir?: string
  keywords: string[]
  description?: string
  icon: { kind: 'auto' | 'file' | 'none'; path?: string }
  createdAt: number
}

/** 从开始菜单/桌面扫出来的候选（.lnk 或 .url 解析出的网址） */
interface ShortcutCandidate {
  path: string
  name: string
  group: string
  kind: 'lnk' | 'url'
}

/** 面板失焦后的行为：立即收起 / 宽限一会儿（默认）/ 永不收起 */
type BlurBehavior = 'immediate' | 'delay' | 'never'

interface LauncherConfig {
  hotkey: string
  autostart: boolean
  pinnedIds: string[]
  pluginOverrides: Record<string, { command?: string; args?: string[] }>
  /** 插件启动快捷键：插件 id → accelerator（停用/卸载的插件保留配置） */
  pluginHotkeys: Record<string, string>
  /** 面板失焦后的行为（浮层打开期间一律不收起） */
  blurBehavior: BlurBehavior
  isPackaged: boolean
  /** 主进程定义的默认唤起键（「恢复默认」用；前端不要自己再写一份） */
  defaultHotkey?: string
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
  /** 浮层打开时登记：这期间面板失焦不收起 */
  holdVisible(token: string): Promise<boolean>
  releaseVisible(token: string): Promise<boolean>
  savePluginOverride(
    id: string,
    data: { command?: string; args?: string }
  ): Promise<{ ok: boolean; command?: string; args?: string[]; message?: string }>
  /** 浏览本地文件挑一个可执行文件（取消时 canceled=true） */
  pickCommand(): Promise<{ ok: boolean; canceled?: boolean; path?: string; message?: string }>
  clearPluginData(id: string): Promise<{ ok: boolean }>
  /** 自定义外部应用（设置 → 外部应用） */
  getShortcuts(): Promise<ShortcutEntry[]>
  getShortcut(id: string): Promise<ShortcutEntry | null>
  saveShortcut(draft: Partial<ShortcutEntry> & { id?: string }): Promise<{
    ok: boolean
    entry?: ShortcutEntry
    message?: string
  }>
  deleteShortcut(id: string): Promise<{ ok: boolean; message?: string }>
  /** 扫开始菜单/桌面的 .lnk / .url（已导入的已剔除） */
  scanShortcutCandidates(): Promise<ShortcutCandidate[]>
  importShortcuts(
    items: { path: string; name: string }[]
  ): Promise<{ ok: boolean; created: number; skipped: number; message?: string }>
  /** 选图标图片：回源路径 + 预览 dataURL（保存时才复制进 userData） */
  pickIconImage(): Promise<{ ok: boolean; canceled?: boolean; path?: string; dataUrl?: string; message?: string }>
  pickDirectory(): Promise<{ ok: boolean; canceled?: boolean; path?: string; message?: string }>
  installPlugin(mode: 'dir' | 'zip'): Promise<{ ok: boolean; canceled?: boolean; message?: string }>
  uninstallPlugin(id: string): Promise<{ ok: boolean; message?: string }>
  setPluginDisabled(id: string, disabled: boolean): Promise<{ ok: boolean }>
  /** 设置插件的启动快捷键（空串 = 清除）；冲突或被占用时返回 ok=false 并附原因 */
  setPluginHotkey(
    id: string,
    accelerator: string
  ): Promise<{ ok: boolean; hotkey?: string; message?: string }>
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