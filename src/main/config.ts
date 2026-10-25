import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 用户对面板内置插件的运行时覆盖（如 external 型启动命令） */
export interface PluginOverride {
  command?: string
  args?: string[]
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
}

const DEFAULTS: AppConfig = {
  hotkey: 'Alt+Space',
  autostart: false,
  pinnedIds: ['com.launcher.clipboard', 'com.launcher.calculator'],
  disabledPluginIds: [],
  pluginOverrides: {}
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
