import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  formatBytes,
  overQuota,
  parseShard,
  PLUGIN_STORE_QUOTA_BYTES,
  safeId,
  serializeShard,
  shardName
} from './storageShards'

/**
 * 插件独立存储：userData/data/<pluginId>/shards/<hash>-<slug>.json
 *
 * 四条设计约束：
 * 1. 分片：一个 key 一个文件。写一个键不再重写整个插件的全部数据；
 * 2. 原子：先写 .tmp 再 rename，进程被杀也不会留下半个 JSON；
 * 3. 防抖：同一插件的写盘合并到一次（250ms），插件在输入框里逐字 set 也打不满磁盘；
 * 4. 配额：单插件总量封顶 8MB（环境变量可改），超了就拒绝写入并说明原因——
 *    宁可让插件当场报错，也别让它在用户盘上悄悄长到几个 G。
 *
 * 主进程按插件 id 强制命名空间，插件彼此不可见（数据隔离）。内存里维护全量副本，
 * 读走内存、写只标脏，因此 get/keys 是同步的、不碰磁盘。
 */

/** 写盘合并窗口：足够吸收一串连续 set，又不至于让页面崩溃丢掉太多 */
const WRITE_DEBOUNCE_MS = 250

/**
 * 单插件总量上限。默认 8MB；`QUICKLAUNCHER_PLUGIN_STORE_LIMIT_MB=0` 关闭配额
 * （留给"我就要存一大堆"的场景，也方便测试）。
 */
const QUOTA_BYTES = ((): number => {
  const raw = process.env.QUICKLAUNCHER_PLUGIN_STORE_LIMIT_MB
  if (raw === undefined || raw === '') return PLUGIN_STORE_QUOTA_BYTES
  const mb = Number(raw)
  if (!Number.isFinite(mb) || mb < 0) return PLUGIN_STORE_QUOTA_BYTES
  return mb === 0 ? 0 : Math.floor(mb * 1024 * 1024)
})()

export interface StorageWriteResult {
  ok: boolean
  message?: string
}

interface PluginStore {
  data: Record<string, unknown>
  /** 待落盘的 key：只写这些，别的分片不动 */
  dirty: Set<string>
  /** key → 该键当前分片序列化后的字节数（配额判断 O(1)，不必每次遍历全量） */
  sizes: Map<string, number>
  /** 已序列化但还没落盘的文本：set 里算过一遍就别在 flush 里再算一遍 */
  pending: Map<string, string>
  /** 全量占用字节数（与 sizes 的合计保持一致） */
  bytes: number
  timer?: ReturnType<typeof setTimeout>
}

const cache = new Map<string, PluginStore>()

function baseDir(pluginId: string): string {
  return join(app.getPath('userData'), 'data', safeId(pluginId))
}

function shardDir(pluginId: string): string {
  return join(baseDir(pluginId), 'shards')
}

function shardFile(pluginId: string, key: string): string {
  return join(shardDir(pluginId), `${shardName(key)}.json`)
}

function legacyFile(pluginId: string): string {
  return join(baseDir(pluginId), 'store.json')
}

/** 写一个分片：text 由调用方给（set 里已经序列化过一次） */
function writeShard(pluginId: string, key: string, text: string): void {
  const file = shardFile(pluginId, key)
  mkdirSync(shardDir(pluginId), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, text, 'utf-8')
  // rename 在同一分区上是原子的；Windows 上也会覆盖同名文件
  renameSync(tmp, file)
}

/** 旧版单文件存储 → 分片。迁移完把原文件改名留档，不删用户数据 */
function migrateLegacy(pluginId: string, store: PluginStore): void {
  const file = legacyFile(pluginId)
  if (!existsSync(file)) return
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf-8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    const entries = Object.entries(raw as Record<string, unknown>)
    for (const [key, value] of entries) {
      const text = serializeShard(key, value)
      store.data[key] = value
      store.sizes.set(key, Buffer.byteLength(text, 'utf-8'))
      store.bytes += store.sizes.get(key) ?? 0
      writeShard(pluginId, key, text)
    }
    renameSync(file, `${file}.migrated`)
    if (entries.length) console.log(`[storage] ${pluginId}: ${entries.length} 个键已迁移为分片`)
  } catch (err) {
    // 旧文件损坏时不能让插件整个起不来：跳过迁移，按空存储继续
    console.error(`[storage] 迁移旧存储失败 ${pluginId}`, err)
  }
}

function load(pluginId: string): PluginStore {
  const cached = cache.get(pluginId)
  if (cached) return cached
  const store: PluginStore = { data: {}, dirty: new Set(), sizes: new Map(), pending: new Map(), bytes: 0 }
  const dir = shardDir(pluginId)
  try {
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue
        const text = readFileSync(join(dir, name), 'utf-8')
        const shard = parseShard(text)
        // 单个分片坏了只丢这一个键，不影响其他数据
        if (!shard) continue
        store.data[shard.key] = shard.value
        const size = Buffer.byteLength(text, 'utf-8')
        store.sizes.set(shard.key, size)
        store.bytes += size
      }
    }
  } catch (err) {
    console.error(`[storage] 读取失败 ${pluginId}`, err)
  }
  migrateLegacy(pluginId, store)
  cache.set(pluginId, store)
  return store
}

function schedulePersist(pluginId: string, store: PluginStore): void {
  if (store.timer) return
  store.timer = setTimeout(() => {
    store.timer = undefined
    flush(pluginId)
  }, WRITE_DEBOUNCE_MS)
  // 未落盘的定时器不该拖住应用退出（退出前会显式 flushAll）
  store.timer.unref?.()
}

function flush(pluginId: string): void {
  const store = cache.get(pluginId)
  if (!store) return
  if (store.timer) {
    clearTimeout(store.timer)
    store.timer = undefined
  }
  if (!store.dirty.size) return
  for (const key of store.dirty) {
    try {
      const text = store.pending.get(key) ?? serializeShard(key, store.data[key])
      writeShard(pluginId, key, text)
      store.pending.delete(key)
    } catch (err) {
      console.error(`[storage] 写入失败 ${pluginId}/${key}`, err)
    }
  }
  store.dirty.clear()
}

export const pluginStorage = {
  get(pluginId: string, key: string): unknown {
    const store = load(pluginId)
    return key in store.data ? store.data[key] : null
  },
  /** 超配额或写盘失败时返回 ok:false + 可读原因（由 API 层抛给插件） */
  set(pluginId: string, key: string, value: unknown): StorageWriteResult {
    const store = load(pluginId)
    // 序列化只做一次：既要算准确字节数，落盘时也直接用它
    const text = serializeShard(key, value)
    const size = Buffer.byteLength(text, 'utf-8')
    const prev = store.sizes.get(key) ?? 0
    if (overQuota(store.bytes, prev, size, QUOTA_BYTES)) {
      return {
        ok: false,
        message:
          `存储配额已满（已用 ${formatBytes(store.bytes)}，上限 ${formatBytes(QUOTA_BYTES)}）：` +
          `「${key}」写入被拒绝。删掉不需要的键，或先截断数组/历史记录再写入。`
      }
    }
    store.data[key] = value
    store.bytes += size - prev
    store.sizes.set(key, size)
    store.pending.set(key, text)
    store.dirty.add(key)
    schedulePersist(pluginId, store)
    return { ok: true }
  },
  remove(pluginId: string, key: string): boolean {
    const store = load(pluginId)
    delete store.data[key]
    store.bytes -= store.sizes.get(key) ?? 0
    store.sizes.delete(key)
    // 正在排队写这个键的话一并撤销，否则删完又被写回来
    store.dirty.delete(key)
    store.pending.delete(key)
    try {
      const file = shardFile(pluginId, key)
      if (existsSync(file)) unlinkSync(file)
    } catch (err) {
      console.error(`[storage] 删除失败 ${pluginId}/${key}`, err)
      return false
    }
    return true
  },
  keys(pluginId: string): string[] {
    return Object.keys(load(pluginId).data)
  },
  /** 该插件当前占用与上限（面板展示用；也方便排查"为什么写不进去"） */
  usage(pluginId: string): { bytes: number; quota: number } {
    return { bytes: load(pluginId).bytes, quota: QUOTA_BYTES }
  },
  /** 退出前落盘：main 的 before-quit 调它（防抖窗口里还压着写请求时尤其重要） */
  flushAll(): void {
    for (const pluginId of cache.keys()) flush(pluginId)
  },
  /** 清空插件全部数据（面板"应用详情"里触发），下次 get 重新初始化 */
  clear(pluginId: string): boolean {
    const store = cache.get(pluginId)
    if (store?.timer) clearTimeout(store.timer)
    cache.delete(pluginId)
    try {
      rmSync(baseDir(pluginId), { recursive: true, force: true })
    } catch (err) {
      console.error(`[storage] 清除失败 ${pluginId}`, err)
      return false
    }
    return true
  }
}
