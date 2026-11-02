/**
 * manifest 新字段的纯校验逻辑（v0.6.2）：`apiVersion` / `window` / `ai`。
 *
 * 抽出来单独放，是因为 manager 里的 validate 直接摸 fs，没法单测；
 * 这里的三个函数都只依赖传进来的「文件是否存在」判定，测试里给个假函数就行。
 *
 * 共同原则与 hosts / features 一致：**坏一项只丢一项**，不整插件拒载。
 * 插件写错一个路径就整个消失，用户只会看到「我的插件不见了」而拿不到原因。
 */
import type { PluginAiMeta } from '../../shared/ai'

export const MANIFEST_API_VERSION = 2

/** 插件页建议尺寸的边界：太小放不下内容，太大在 1366×768 的屏上会超出屏幕 */
export const MIN_WINDOW_WIDTH = 420
export const MAX_WINDOW_WIDTH = 2400
export const MIN_WINDOW_HEIGHT = 320
export const MAX_WINDOW_HEIGHT = 1800

export interface WindowHint {
  width: number
  height: number
}

/**
 * `apiVersion` 缺省视为 1。只接受 1 和 2：
 * 未来版本的插件可能依赖新字段语义，这里认不出来就当 1 加载，
 * 至少它还能跑；报错拒载反而更糟。
 */
export function normalizeApiVersion(raw: unknown, warn: (message: string) => void): number {
  if (raw === undefined || raw === null) return 1
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    warn(`apiVersion 应为数字，已按 1 处理`)
    return 1
  }
  const value = Math.floor(raw)
  if (value < 1) return 1
  if (value > MANIFEST_API_VERSION) {
    warn(`apiVersion=${value} 高于本版支持的 ${MANIFEST_API_VERSION}，按 ${MANIFEST_API_VERSION} 加载`)
    return MANIFEST_API_VERSION
  }
  return value
}

function clamp(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(Math.max(Math.round(value), min), max)
}

/**
 * `window` 是**建议**尺寸：用户手动改过窗口大小后以用户记忆的为准，
 * 所以这里只提供默认值，不强制锁定。
 */
export function normalizeWindowHint(raw: unknown, warn: (message: string) => void): WindowHint | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object') {
    warn('window 应为对象，已忽略')
    return undefined
  }
  const obj = raw as Record<string, unknown>
  const width = clamp(obj.width, MIN_WINDOW_WIDTH, MAX_WINDOW_WIDTH)
  const height = clamp(obj.height, MIN_WINDOW_HEIGHT, MAX_WINDOW_HEIGHT)
  if (width === null || height === null) {
    warn('window.width/height 应为数字，已忽略')
    return undefined
  }
  return { width, height }
}

/**
 * `ai` 段的三个路径都必须是**插件目录内的相对路径**。
 *
 * 只校验存在与形态、不读内容：tools.json 是否合法是 AI 目录那边的事，
 * 坏掉只该丢工具，不该让插件加载失败。
 */
export function normalizeAiSection(
  raw: unknown,
  exists: (relativePath: string) => boolean,
  warn: (message: string) => void,
  type: 'web' | 'external' = 'web'
): PluginAiMeta | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object') {
    warn('ai 应为对象，已忽略')
    return undefined
  }
  if (type !== 'web') {
    // external 型插件没有页面，工具调用没有可以回调的端点。
    // 与其发下去一个必然超时的工具，不如现在就说明白。
    warn('external 型插件不支持 ai 能力（没有页面可以回传工具结果），已忽略')
    return undefined
  }
  const obj = raw as Record<string, unknown>
  const out: PluginAiMeta = {}

  for (const key of ['tools', 'skill', 'mcp'] as const) {
    const value = obj[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string' || !value.trim()) {
      warn(`ai.${key} 应为非空字符串，已忽略`)
      continue
    }
    const safe = safeRelative(value)
    if (!safe) {
      // `../` 或绝对路径会把「插件自带的文件」变成「机器上任意文件」，
      // 后面的工具描述、SKILL 正文都会进模型上下文，等于给了一条读取任意文件的路
      warn(`ai.${key} 必须是插件目录内的相对路径：${value}`)
      continue
    }
    if (!exists(safe)) {
      warn(`ai.${key} 指向的文件不存在：${safe}`)
      continue
    }
    out[key] = safe
  }

  return Object.keys(out).length ? out : undefined
}

/**
 * 归一化相对路径并挡掉越界写法。
 * 返回 null 表示不该用（绝对路径、盘符、`..`、空串）。
 */
export function safeRelative(input: string): string | null {
  const value = input.trim().replace(/\\/g, '/')
  if (!value) return null
  if (value.startsWith('/')) return null
  if (/^[a-zA-Z]:/.test(value)) return null
  // URL 形式（http://、file://）同样不该出现在这里
  if (/^[a-zA-Z][\w+.-]*:\/\//.test(value)) return null
  const parts: string[] = []
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') return null
    parts.push(segment)
  }
  return parts.length ? parts.join('/') : null
}
