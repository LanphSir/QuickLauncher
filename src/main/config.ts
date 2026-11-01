import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BlurBehavior } from './windows/panelVisibility'
import { sanitizeHotkeyMap } from './plugin/hotkeyPlan'

/** 用户对面板内置插件的运行时覆盖（如 external 型启动命令） */
export interface PluginOverride {
  command?: string
  args?: string[]
}

export interface WindowRect {
  x?: number
  y?: number
  width: number
  height: number
}

export interface AppConfig {
  /** 全局唤起快捷键（Electron accelerator 格式） */
  hotkey: string
  /** 开机自启（仅打包后生效） */
  autostart: boolean
  /** 已固定插件 id，按固定顺序排列 */
  pinnedIds: string[]
  /** 被停用的插件 id（仍注册但不出现在面板/不可打开） */
  disabledPluginIds: string[]
  /** 插件运行时配置覆盖，key 为插件 id */
  pluginOverrides: Record<string, PluginOverride>
  /** 插件启动快捷键，key 为插件 id、value 为 accelerator；停下/卸载的插件保留配置 */
  pluginHotkeys: Record<string, string>
  /** 面板窗口上次的边界（分离缩放后恢复用） */
  panelBounds?: WindowRect
  /** 插件页窗口尺寸：进插件时按它伸展，只记宽高避免位置漂移 */
  pluginBounds?: WindowRect
  /** 各插件分离窗口的边界，key 为插件 id */
  windowStates?: Record<string, WindowRect>
  /** 面板失焦后的行为（浮层打开期间一律不收起，与该项无关） */
  blurBehavior: BlurBehavior
}

/**
 * 唤起面板的默认键。
 *
 * 不用 Alt+Space：Windows 把它留给窗口系统菜单，`globalShortcut.register` 会失败
 * （表现是点「恢复默认」直接提示"可能被其他程序占用"，而那个键本来就注册不上）。
 */
export const DEFAULT_HOTKEY = 'CommandOrControl+Shift+Space'

const DEFAULTS: AppConfig = {
  hotkey: DEFAULT_HOTKEY,
  autostart: false,
  pinnedIds: ['com.launcher.clipboard', 'com.launcher.calculator'],
  disabledPluginIds: [],
  pluginOverrides: {},
  pluginHotkeys: {},
  windowStates: {},
  blurBehavior: 'delay'
}

let config: AppConfig = { ...DEFAULTS }

function configFile(): string {
  return join(app.getPath('userData'), 'config.json')
}

export function loadConfig(): AppConfig {
  try {
    if (existsSync(configFile())) {
      const raw = JSON.parse(readFileSync(configFile(), 'utf-8'))
      config = { ...DEFAULTS, ...raw }
      // 手改配置/旧版本升级都可能留下脏值（null、数组、空串），这里一次性洗掉
      config.pluginHotkeys = sanitizeHotkeyMap(config.pluginHotkeys)
    }
  } catch (err) {
    console.error('[config] 读取失败，使用默认配置', err)
  }
  return config
}

export function getConfig(): AppConfig {
  return config
}

export function updateConfig(patch: Partial<AppConfig>): AppConfig {
  config = { ...config, ...patch }
  try {
    writeFileSync(configFile(), JSON.stringify(config, null, 2), 'utf-8')
  } catch (err) {
    console.error('[config] 保存失败', err)
  }
  return config
}
