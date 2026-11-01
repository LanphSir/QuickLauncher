import { createHash } from 'node:crypto'

/**
 * 存储分片的命名与解析：纯函数、不碰 fs / electron，单测直接跑这里。
 *
 * 为什么一个 key 一个文件：以前整插件一个 store.json，写任何一个键都要
 * 序列化 + 落盘全部数据；插件存了剪贴板历史这种大数组时，改一个布尔值
 * 也会把几 MB 重写一遍。分片后写入量与"被改的那个值"成正比。
 */

/** 文件名里能安全出现的字符（Windows 保留字符、路径分隔符、空格都不行） */
const UNSAFE = /[^\w.-]+/g

/** 插件 id → 目录名：不允许 `..`、斜杠等把路径带出数据目录 */
export function safeId(pluginId: string): string {
  // 前导点单独去掉：`..` 虽然不含分隔符，但 join 上去就是上一级目录
  const cleaned = pluginId.replace(UNSAFE, '_').replace(/^\.+/, '').slice(0, 64)
  return cleaned || '_'
}

/** key → 文件名主体：哈希保证唯一，slug 只为出问题时肉眼能认出来 */
export function shardName(key: string): string {
  const hash = createHash('sha256').update(key, 'utf-8').digest('hex').slice(0, 16)
  const slug = key.replace(UNSAFE, '_').replace(/^[.-]+/, '').slice(0, 32)
  return slug ? `${hash}-${slug}` : hash
}

/** 分片内容：把原始 key 一起存，`keys()` 才能还原（文件名只是哈希 + 缩写） */
export interface Shard {
  key: string
  value: unknown
}

export function serializeShard(key: string, value: unknown): string {
  return JSON.stringify({ k: key, v: value } satisfies { k: string; v: unknown })
}

/** 解析失败（手改坏、写到一半断电）返回 null，由调用方跳过这一个键 */
export function parseShard(text: string): Shard | null {
  try {
    const raw: unknown = JSON.parse(text)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const rec = raw as Record<string, unknown>
    if (typeof rec.k !== 'string' || !rec.k) return null
    return { key: rec.k, value: rec.v ?? null }
  } catch {
    return null
  }
}

/**
 * 单插件存储总量上限：8 MiB。
 * 分片让"改一个键"变便宜了，但总量仍要封顶——否则一个记日志/存历史不截断的插件
 * 能把用户盘占满，而且这些数据默认跟着漫游/备份走。
 */
export const PLUGIN_STORE_QUOTA_BYTES = 8 * 1024 * 1024

/**
 * 写入该键后会不会超配额。
 * @param total 当前已占用（含该键旧值）
 * @param prev 该键旧值占用（新增键为 0）
 * @param incoming 新值序列化后的字节数
 * @param quota 上限；≤0 表示不限制
 */
export function overQuota(total: number, prev: number, incoming: number, quota = PLUGIN_STORE_QUOTA_BYTES): boolean {
  if (quota <= 0) return false
  return total - prev + incoming > quota
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '∞'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
