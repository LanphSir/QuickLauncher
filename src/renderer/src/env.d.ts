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
}

interface LauncherConfig {
  hotkey: string
  autostart: boolean
  pinnedIds: string[]
  isPackaged: boolean
}

interface PanelApi {
  getPlugins(): Promise<PluginSummary[]>
  openPlugin(id: string): Promise<{ ok: boolean; message?: string }>
  pin(id: string, pinned: boolean): Promise<string[]>
  getConfig(): Promise<LauncherConfig>
  updateConfig(patch: Partial<LauncherConfig>): Promise<{ ok: boolean; config?: LauncherConfig; message?: string }>
  hidePanel(): Promise<void>
  onShown(callback: () => void): void
  onPluginExited(callback: () => void): void
  onPluginCrashed(callback: (payload: { id: string; name: string }) => void): void
}

interface PluginApi {
  info(): Promise<{ id: string; name: string; version?: string; permissions: string[] }>
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
  window: { hide(): Promise<boolean> }
  exit(): Promise<boolean>
}

interface Window {
  panel: PanelApi
  appapi: PluginApi
}
