import type { WebContents } from 'electron'
import type { PluginApiTypes, PluginChannel, PluginFeature } from '../../../shared/pluginApi'
import type { PluginRecord } from '../manager'

/** 调用上下文：调用方身份来自 callerRegistry，永不信任 payload 里自带的 id */
export interface ApiContext {
  rec: PluginRecord
  sender: WebContents
}

/**
 * 一个通道的定义。类型由 shared/pluginApi 的契约锚定：
 * parse 的返回值必须等于契约里的 req，handle 的返回值必须等于契约里的 res。
 */
export interface ApiDef<C extends PluginChannel> {
  /** 把不可信 payload 校验/归一化为契约入参；非法直接抛错 */
  parse?: (payload: unknown) => PluginApiTypes[C]['req']
  /**
   * 该通道要求插件在 manifest `features` 里声明的功能（如 inline）。
   * 与权限分开：权限是系统能力，功能是参与启动器的方式。
   */
  feature?: PluginFeature
  handle: (
    ctx: ApiContext,
    payload: PluginApiTypes[C]['req']
  ) => PluginApiTypes[C]['res'] | Promise<PluginApiTypes[C]['res']>
}

/**
 * 注册表内部用的类型擦除形态。
 * 这里是全项目唯一允许 `any` 的地方：网关要按通道批量注册，无法在运行时保留
 * 每个通道的具体类型；对外的类型安全由 defineApi 的泛型签名负责。
 */
export interface RegisteredApiDef {
  parse?: (payload: unknown) => unknown
  feature?: PluginFeature
  handle: (ctx: ApiContext, payload: any) => unknown
}

export type ApiDefinition = readonly [PluginChannel, RegisteredApiDef]

/**
 * 声明一个通道：`defineApi('plugin:storage.get', { parse, handle })`。
 * 通道名必须是契约里的 key，权限由共享表自动带出——不再手写第二份 PERMS。
 */
export function defineApi<C extends PluginChannel>(channel: C, def: ApiDef<C>): ApiDefinition {
  return [channel, def as unknown as RegisteredApiDef]
}
