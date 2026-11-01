import { session } from 'electron'
import { installOnSession } from './protocol'
import { pluginHostOf } from './urls'

/**
 * 每个插件一个独立 session（persist:plugin:<id>）。
 *
 * 之前所有插件共用 defaultSession：翻译插件里登录第三方翻译站拿到的 cookie，
 * 别的插件（以及它内嵌的 webview）都能读到；a 插件的 localStorage 与 b 插件也只是
 * 靠 origin 区分，一旦插件页还是 file:// 就完全混在一起。
 * 现在 origin + session 双隔离：换插件 = 换浏览器配置文件。
 */

/** 允许插件页直接申请的权限；其余（摄像头/麦克风/定位/通知/串口…）默认拒绝 */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock'])

export function pluginPartition(id: string): string {
  return `persist:plugin:${id}`
}

const ready = new Set<string>()

/** 取插件分区名，首次调用时完成该分区的注册与权限策略 */
export function ensurePluginSession(id: string): string {
  const partition = pluginPartition(id)
  if (ready.has(partition)) return partition
  ready.add(partition)
  const ses = session.fromPartition(partition)
  installOnSession(ses)
  /**
   * plugin:// 的响应由主进程直接产生，Chromium 不做 CORS 校验，
   * 于是 a 插件能直接 fetch 到 b 插件的文件。这里按"本分区只许访问自己"兜住：
   * 分区与插件一一对应，插件页（及它内嵌的 webview）读别人的 plugin:// 一律取消。
   */
  const selfHost = id.toLowerCase()
  ses.webRequest.onBeforeRequest((details, callback) => {
    const host = pluginHostOf(details.url)
    if (host && host !== selfHost) {
      console.warn(`[plugin] ${id} 试图访问其他插件的资源已拦截: ${details.url}`)
      callback({ cancel: true })
      return
    }
    callback({})
  })
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    const ok = ALLOWED_PERMISSIONS.has(permission)
    if (!ok) console.warn(`[plugin] ${id} 请求权限 ${permission} 已被默认策略拒绝`)
    callback(ok)
  })
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))
  return partition
}

/** 清除插件的浏览器侧数据（localStorage / IndexedDB / cookie / 缓存） */
export async function clearPluginSession(id: string): Promise<void> {
  const ses = session.fromPartition(pluginPartition(id))
  await ses.clearStorageData()
  await ses.clearCache()
}
