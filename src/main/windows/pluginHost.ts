import { BrowserWindow, WebContentsView } from 'electron'
import { join } from 'node:path'
import { pluginEntryUrl, type PluginRecord } from '../plugin/manager'
import { getCaller, registerPluginCaller } from '../plugin/callerRegistry'

export interface PluginOpenPayload {
  /** 面板搜索词，打开时透传给插件（appapi.onQuery 接收） */
  query?: string
}

interface CacheEntry {
  view: WebContentsView
  rec: PluginRecord
  pending?: PluginOpenPayload
}

/**
 * 插件宿主：每个 web 型插件一个独立 WebContentsView（独立渲染进程）。
 * - 视图缓存：退出插件不销毁页面，重进保留状态
 * - 崩溃隔离：单个插件崩溃只影响自身，主面板与其他插件不受影响
 */
const viewCache = new Map<string, CacheEntry>()
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

function flushPayload(entry: CacheEntry): void {
  if (!entry.pending) return
  entry.view.webContents.send('plugin:query', entry.pending)
  entry.pending = undefined
}

export function showPlugin(rec: PluginRecord, payload?: PluginOpenPayload): void {
  if (!panel) return
  let entry = viewCache.get(rec.manifest.id)
  if (!entry) {
    const view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '../preload/plugin.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // 插件可嵌入第三方网页（如官方翻译页）；实际放行由 will-attach-webview 按权限校验
        webviewTag: true
      }
    })
    entry = { view, rec }
    viewCache.set(rec.manifest.id, entry)
    registerPluginCaller(view.webContents, rec)
    // <webview> 权限门禁：仅声明 webview 权限的插件允许嵌入，且收紧 guest 偏好
    view.webContents.on('will-attach-webview', (event, webPreferences, params) => {
      const caller = getCaller(view.webContents)
      if (!caller?.manifest.permissions?.includes('webview')) {
        console.warn(`[plugin] ${caller?.manifest.id ?? '未知插件'} 未声明 webview 权限，已拦截`)
        event.preventDefault()
        return
      }
      delete webPreferences.preload
      webPreferences.nodeIntegration = false
      webPreferences.contextIsolation = true
      webPreferences.sandbox = true
    })
    view.webContents.on('did-finish-load', () => flushPayload(entry!))
    view.webContents.on('render-process-gone', (_event, details) => {
      onPluginCrashed(rec, details.reason)
    })
    void view.webContents.loadURL(pluginEntryUrl(rec))
  }

  detachActive()
  panel.contentView.addChildView(entry.view)
  activeId = rec.manifest.id
  entry.pending = payload
  // 缓存视图页面已就绪时立即送达；新视图等 did-finish-load 再送
  if (!entry.view.webContents.isLoading()) flushPayload(entry)
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

/** 卸载/重置单个插件：主动退出 + 销毁缓存视图 */
export function destroyPlugin(id: string): void {
  const entry = viewCache.get(id)
  if (!entry) return
  if (activeId === id) {
    panel?.contentView.removeChildView(entry.view)
    activeId = null
    panel?.webContents.focus()
    panel?.webContents.send('panel:plugin-exited')
  }
  viewCache.delete(id)
  try {
    entry.view.webContents.close()
  } catch {
    /* ignore */
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
