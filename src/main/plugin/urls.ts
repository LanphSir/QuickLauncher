/**
 * 插件页地址的唯一构造点。
 * 单独一个无依赖的小模块，避免 manager（入口解析）与 protocol（请求处理）互相 import。
 */
export const PLUGIN_SCHEME = 'plugin'

/** plugin://<id>/<entry> */
export function pluginAppUrl(id: string, entry = 'index.html'): string {
  const rel = String(entry || 'index.html').replace(/^\/+/, '')
  return `${PLUGIN_SCHEME}://${id}/${rel}`
}

/** 取自定义协议 URL 的 host（小写）；不是 plugin:// 则返回 null */
export function pluginHostOf(url: string): string | null {
  if (!url || !url.startsWith(`${PLUGIN_SCHEME}://`)) return null
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}
