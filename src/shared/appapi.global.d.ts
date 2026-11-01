import type { PluginApiSurface } from './pluginApi'

/**
 * 插件侧的 window.appapi 全局声明。
 *
 * 插件不再各自手写一份 appapi 接口（那会随 API 演进而漂移），改为在自己的
 * `src/env.d.ts` 里一行引用本文件：
 *
 *   /// <reference path="../../../src/shared/appapi.global.d.ts" />
 *
 * 类型来自 shared/pluginApi 的 PluginApiSurface，与 preload 的实现同源。
 */
declare global {
  interface Window {
    appapi: PluginApiSurface
  }
}

export {}
