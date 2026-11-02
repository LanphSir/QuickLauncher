/**
 * 工具名映射（v0.6.3）：全局名 → 下发给模型的函数名。
 *
 * 为什么单独一个文件：这段规则要能单测。纯函数、不 import electron，
 * 测试里可以直接跑上千次；而 toolCatalog 依赖插件注册表，一 import 就得起整个 Electron。
 *
 * 规则：`plugin:com.launcher.translator:translate` → `plugin_com_launcher_translator_translate`。
 * 保留可读性是有意的——出问题时从请求日志能直接看出是哪个插件的哪个工具，
 * 而不是一串哈希。
 */

/** 函数名上限：OpenAI 与多数兼容实现都是 64 */
const MAX_API_NAME = 64

/** 稳定短哈希（FNV-1a）：只用来防撞名，不承担安全职责 */
function shortHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36).slice(0, 6).padStart(6, '0')
}

export function apiToolName(fullName: string): string {
  const base = fullName
    .replace(/^plugin:/, 'plugin_')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/_{2,}/g, '_')
  // 函数名必须以字母或下划线开头：数字开头的 id 极少，但不能让它把整份清单废掉
  const safe = /^[A-Za-z_]/.test(base) ? base : `t_${base}`
  if (safe.length <= MAX_API_NAME) return safe
  return `${safe.slice(0, MAX_API_NAME - 7)}_${shortHash(fullName)}`
}

/** 是否满足端点的函数名约束（冒烟与单测共用的一条口径） */
export function isValidApiToolName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(name)
}
