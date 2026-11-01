import { app } from 'electron'
import { existsSync, mkdirSync, watch, type FSWatcher } from 'node:fs'
import { getInstalledRoot, getPluginRoots } from './manager'
import { planPluginWatches } from './watchPlan'

/**
 * 插件目录监听：新放进来的插件、改了 plugin.json（改名/加权限/换入口）不用重启应用。
 *
 * 只监听两种变化：
 * 1. 根目录里的条目增删（新插件目录、卸载后的空目录）；
 * 2. 每个插件目录 / 其 dist 里的 plugin.json 被写入。
 * 插件构建会把 JS/CSS 整目录重写，那些事件重扫也没用（注册表只读 manifest），
 * 所以按文件名过滤掉，避免 `pnpm build:plugins` 期间反复重扫。
 *
 * 事件必须合并：一次保存可能触发 change + rename 两条，构建时更是几十条。
 */

/** 变化合并窗口：够吸收一次构建的连串写入，又不至于让人等太久才看到新插件 */
const DEBOUNCE_MS = 300

/** 需要监听的插件根：打包后内置插件躺在安装目录里不会变，只留用户安装目录 */
function watchRoots(): string[] {
  const roots = getPluginRoots()
  const list = app.isPackaged ? roots.filter((r) => r.source === 'installed') : roots
  const dirs = list.map((r) => r.root)
  // 用户安装目录默认可能还不存在；建出来才能监听"往里放插件"这件事（安装流程本来也会建）
  const installed = getInstalledRoot()
  if (!existsSync(installed)) {
    try {
      mkdirSync(installed, { recursive: true })
    } catch {
      /* 建不出来就退化成只认安装/卸载时的显式重扫 */
    }
  }
  return dirs
}

/**
 * 开始监听，返回停止函数。
 * onChange 在每次变化合并后调用一次（调用方在里面重扫 + 通知界面），
 * 随后按最新的目录结构重挂监听——新插件目录、新建的 dist 都要补上。
 */
export function watchPluginDirs(onChange: () => void): () => void {
  let watchers: FSWatcher[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false

  const disposeWatchers = (): void => {
    for (const watcher of watchers) {
      try {
        watcher.close()
      } catch {
        /* 已自行失效的监听关不掉也无所谓 */
      }
    }
    watchers = []
  }

  const schedule = (): void => {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      try {
        onChange()
      } finally {
        attach()
      }
    }, DEBOUNCE_MS)
    // 监听不该拖住应用退出
    timer.unref?.()
  }

  const attach = (): void => {
    if (closed) return
    disposeWatchers()
    for (const target of planPluginWatches(watchRoots())) {
      try {
        const watcher = watch(target.dir, { persistent: false }, (_event, name) => {
          // 有些平台不传文件名：宁可信其有，让它触发一次重扫
          if (name && target.match && !target.match.test(String(name))) return
          schedule()
        })
        watcher.on('error', () => {
          /* 目录被删/权限变化会让监听失效，下一次 attach 会重挂 */
        })
        watchers.push(watcher)
      } catch (err) {
        console.warn(`[plugin] 监听目录失败 ${target.dir}: ${(err as Error).message}`)
      }
    }
  }

  attach()
  return () => {
    closed = true
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    disposeWatchers()
  }
}
