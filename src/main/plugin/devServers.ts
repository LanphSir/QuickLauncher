import { app } from 'electron'
import { existsSync, readFileSync, watchFile } from 'node:fs'
import { join } from 'node:path'

/**
 * 开发期插件热更新：把插件的入口从 `dist/index.html` 换成 vite dev server 的地址。
 *
 * 为什么不把 devServer 写进 manifest：manifest 是随插件发布的产物，塞本地端口会污染
 * 协议，也会被打进安装包。改用一个仓库根的本地文件 `.dev-plugins.json`（已 gitignore），
 * 由 `pnpm dev:plugin <name>` 维护；主进程只读它，打包后完全不看。
 *
 * 文件格式：{ "com.launcher.handbook": "http://localhost:5273/" }
 */

export type DevServerMap = Record<string, string>

function devFile(): string {
  return join(app.getAppPath(), '.dev-plugins.json')
}

/** 只接受本机地址：这个文件在磁盘上，不该成为远程代码加载的入口 */
function isLocalUrl(url: unknown): url is string {
  return typeof url === 'string' && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?/.test(url)
}

export function readDevServers(): DevServerMap {
  if (app.isPackaged) return {}
  const file = devFile()
  if (!existsSync(file)) return {}
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
    const map: DevServerMap = {}
    for (const [id, url] of Object.entries(raw)) {
      if (isLocalUrl(url)) map[id] = url.endsWith('/') ? url : `${url}/`
    }
    return map
  } catch (err) {
    console.warn('[plugin] .dev-plugins.json 解析失败，忽略开发期入口', (err as Error).message)
    return {}
  }
}

function readRaw(file: string): string {
  try {
    return readFileSync(file, 'utf-8')
  } catch {
    return ''
  }
}

/**
 * 监听 dev 入口变化：脚本启停插件 dev server 时自动重扫并重载已打开的视图，
 * 不用重启应用。
 *
 * 比较的是文件原文而不是解析后的映射：同端口重启 dev server 时 URL 没变
 * （脚本只更新 `_updatedAt` 时间戳），比映射会漏掉这次变化，页面就切不回来。
 */
export function watchDevServers(onChange: (map: DevServerMap) => void): void {
  if (app.isPackaged) return
  const file = devFile()
  let lastRaw = readRaw(file)
  watchFile(file, { interval: 400 }, () => {
    const raw = readRaw(file)
    if (raw === lastRaw) return
    lastRaw = raw
    onChange(readDevServers())
  })
}
