import type { WebContents } from 'electron'
import type { PluginRecord } from './manager'

/** webContents.id -> 插件，用于 IPC 网关识别调用方身份（进程级隔离下的身份锚点） */
const callers = new Map<number, PluginRecord>()

export function registerPluginCaller(wc: WebContents, rec: PluginRecord): void {
  callers.set(wc.id, rec)
  wc.once('destroyed', () => callers.delete(wc.id))
}

export function getCaller(wc: WebContents): PluginRecord | undefined {
  return callers.get(wc.id)
}
