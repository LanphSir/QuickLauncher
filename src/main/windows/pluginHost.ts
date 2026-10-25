import { BrowserWindow, WebContentsView } from 'electron'
import { join } from 'node:path'
import { pluginEntryUrl, type PluginRecord } from '../plugin/manager'
import { registerPluginCaller } from '../plugin/callerRegistry'

/**
 * 插件宿主：每个 web 型插件一个独立 WebContentsView（独立渲染进程）。
 * - 视图缓存：退出插件不销毁页面，重进保留状态
 * - 崩溃隔离：单个插件崩溃只影响自身，主面板与其他插件不受影响
 */
const viewCache = new Map<string, { view: WebContentsView; rec: PluginRecord }>()
let activeId: string | null = null
let panel: BrowserWindow | null = null

export function initPluginHost(win: BrowserWindow): void {
  panel = win
  win.on('resize', () => syncBounds())
  win.on('closed', () => destroyAll())
}

function syncBounds(): void {
  const entry = activeId ? viewCache.get(activeId) : null
  if (!entry || !panel) return
  const [width, height] = panel.getContentSize()
  entry.view.setBounds({ x: 0, y: 0, width, height })
}

export function showPlugin(rec: PluginRecord): void {
  if (!panel) return
  let entry = viewCache.get(rec.manifest.id)
  if (!entry) {
    const view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '../preload/plugin.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    entry = { view, rec }
    viewCache.set(rec.manifest.id, entry)
    registerPluginCaller(view.webContents, rec)
    view.webContents.on('render-process-gone', (_event, details) => {
      onPluginCrashed(rec, details.reason)
    })
    void view.webContents.loadURL(pluginEntryUrl(rec))
  }

  detachActive()
  panel.contentView.addChildView(entry.view)
  activeId = rec.manifest.id
  syncBounds()
  entry.view.webContents.focus()
}

/** 从插件返回主面板（视图保留在缓存中，状态不丢） */
export function exitPlugin(sendEvent = true): void {
  const hadActive = detachActive()
  if (!hadActive || !panel) return
  panel.webContents.focus()
  if (sendEvent) panel.webContents.send('panel:plugin-exited')
}

/** 面板重新唤起时回到主页 */
export function exitToHome(): void {
  exitPlugin(false)
}

function detachActive(): boolean {
  if (!activeId || !panel) return false
  const entry = viewCache.get(activeId)
  if (entry) panel.contentView.removeChildView(entry.view)
  activeId = null
  return true
}

function onPluginCrashed(rec: PluginRecord, reason: string): void {
  console.error(`[plugin] 「${rec.manifest.name}」渲染进程崩溃(${reason})，已卸载该实例`)
  const entry = viewCache.get(rec.manifest.id)
  if (!entry) return
  if (activeId === rec.manifest.id) {
    panel?.contentView.removeChildView(entry.view)
    activeId = null
    panel?.webContents.focus()
    panel?.webContents.send('panel:plugin-crashed', {
      id: rec.manifest.id,
      name: rec.manifest.name
    })
  }
  viewCache.delete(rec.manifest.id)
  try {
    entry.view.webContents.close()
  } catch {
    /* 崩溃后可能已不可关闭 */
  }
}

export function destroyAll(): void {
  for (const [, entry] of viewCache) {
    try {
      entry.view.webContents.close()
    } catch {
      /* ignore */
    }
  }
  viewCache.clear()
  activeId = null
}
