import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 插件独立存储：userData/data/<pluginId>/store.json
 * 主进程按插件 id 强制命名空间，插件彼此不可见（数据隔离）。
 */
const cache = new Map<string, Record<string, unknown>>()

function safeId(pluginId: string): string {
  return pluginId.replace(/[^\w.-]/g, '_')
}

function storeFile(pluginId: string): string {
  return join(app.getPath('userData'), 'data', safeId(pluginId), 'store.json')
}

function load(pluginId: string): Record<string, unknown> {
  let data = cache.get(pluginId)
  if (data) return data
  const file = storeFile(pluginId)
  try {
    data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : {}
  } catch (err) {
    console.error(`[storage] 读取失败 ${pluginId}`, err)
    data = {}
  }
  cache.set(pluginId, data!)
  return data!
}

function persist(pluginId: string): void {
  const file = storeFile(pluginId)
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify(cache.get(pluginId) ?? {}, null, 2), 'utf-8')
  } catch (err) {
    console.error(`[storage] 写入失败 ${pluginId}`, err)
  }
}

export const pluginStorage = {
  get(pluginId: string, key: string): unknown {
    const data = load(pluginId)
    return key in data ? data[key] : null
  },
  set(pluginId: string, key: string, value: unknown): boolean {
    load(pluginId)[key] = value
    persist(pluginId)
    return true
  },
  remove(pluginId: string, key: string): boolean {
    delete load(pluginId)[key]
    persist(pluginId)
    return true
  },
  keys(pluginId: string): string[] {
    return Object.keys(load(pluginId))
  },
  /** 清空插件全部数据（面板"应用详情"里触发），下次 get 重新初始化 */
  clear(pluginId: string): boolean {
    cache.delete(pluginId)
    try {
      rmSync(join(storeFile(pluginId), '..'), { recursive: true, force: true })
    } catch (err) {
      console.error(`[storage] 清除失败 ${pluginId}`, err)
      return false
    }
    return true
  }
}
