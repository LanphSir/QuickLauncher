import type { PluginChannel } from '../../../shared/pluginApi'
import type { ApiDefinition } from './define'
import { metaApi } from './meta'
import { storageApi } from './storage'
import { systemApi } from './system'
import { docsApi } from './docs'
import { searchApi } from './search'
import { netApi } from './net'
import { inlineApi } from './inline'

export type { ApiContext, ApiDef, ApiDefinition, RegisteredApiDef } from './define'

/**
 * 插件 API 注册表：加一个能力 = 在 shared/pluginApi.ts 声明通道与权限 +
 * 在本目录挑一个模块补一条 defineApi，网关与 preload 都不必改。
 */
export const apiDefs: ApiDefinition[] = [
  ...metaApi,
  ...storageApi,
  ...systemApi,
  ...docsApi,
  ...searchApi,
  ...netApi,
  ...inlineApi
]

/** 通道必须唯一：重复注册会让 ipcMain.handle 直接抛错，启动期就暴露 */
export function assertUniqueChannels(defs: ApiDefinition[]): void {
  const seen = new Set<PluginChannel>()
  for (const [channel] of defs) {
    if (seen.has(channel)) throw new Error(`[gateway] 通道重复注册: ${channel}`)
    seen.add(channel)
  }
}
