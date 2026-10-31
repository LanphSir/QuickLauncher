import { BrowserWindow, WebContentsView, screen } from 'electron'
import { join } from 'node:path'
import { getConfig, updateConfig, type WindowRect } from '../config'
import { getPlugin, pluginEntryUrl, type PluginRecord } from '../plugin/manager'
import { getCaller, registerPluginCaller } from '../plugin/callerRegistry'
import { enterPluginLayout, hidePanel, leavePluginLayout } from './panel'
import { PLUGIN_FRAME, pluginViewRect } from '../../shared/pluginFrame'

export interface PluginOpenPayload {
  /** 面板搜索词，打开时透传给插件（appapi.onQuery 接收） */
  query?: string
}

interface CacheEntry {
  view: WebContentsView
  rec: PluginRecord
  /** 非空 = 插件已分离到该独立窗口 */
  host: BrowserWindow | null
  pending?: PluginOpenPayload
}

/**
 * 插件宿主：每个 web 型插件一个独立 WebContentsView（独立渲染进程）。
 * - 视图缓存：退出插件不销毁页面，重进保留状态
 * - 崩溃隔离：单个插件崩溃只影响自身，主面板与其他插件不受影响
 * - 分离模式：视图可整体挂载到独立 BrowserWindow（状态保留、任务栏可见）
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
  if (!entry || !panel || entry.host) return
  const [width, height] = panel.getContentSize()
  // 顶部让出工具条、四周留出边带：边缘留白让缩放热区与插件内边缘控件都点得到
  entry.view.setBounds(pluginViewRect(width, height))
}

function flushPayload(entry: CacheEntry): void {
  if (!entry.pending) return
  entry.view.webContents.send('plugin:query', entry.pending)
  entry.pending = undefined
}

function entryFor(wc: Electron.WebContents): CacheEntry | undefined {
  for (const entry of viewCache.values()) {
    if (entry.view.webContents.id === wc.id) return entry
  }
  return undefined
}

/** 确保插件视图存在（懒创建 + 预热加载） */
function ensureEntry(rec: PluginRecord): CacheEntry {
  let entry = viewCache.get(rec.manifest.id)
  if (entry) return entry
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
  entry = { view, rec, host: null }
  viewCache.set(rec.manifest.id, entry)
  // 卡片视觉：白底 + 圆角（角落由原生视图自身裁切，渲染层无法盖住它）
  view.setBackgroundColor('#ffffff')
  try {
    view.setBorderRadius(PLUGIN_FRAME.radius)
  } catch {
    /* 旧版本 Electron 没有圆角能力，直角也不影响使用 */
  }
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
  return entry
}

export function showPlugin(rec: PluginRecord, payload?: PluginOpenPayload): void {
  if (!panel) return
  const entry = ensureEntry(rec)

  // 已分离 → 聚焦独立窗口并透传查询词，不再挂回面板
  if (entry.host) {
    entry.pending = payload
    if (!entry.host.isVisible()) entry.host.show()
    entry.host.focus()
    if (!entry.view.webContents.isLoading()) flushPayload(entry)
    return
  }

  detachActive(false)
  panel.contentView.addChildView(entry.view)
  activeId = rec.manifest.id
  entry.pending = payload
  // 插件页比主页需要更大空间：进页面前先把窗口伸展好，再按新尺寸排视图
  enterPluginLayout()
  // 缓存视图页面已就绪时立即送达；新视图等 did-finish-load 再送
  if (!entry.view.webContents.isLoading()) flushPayload(entry)
  syncBounds()
  panel.webContents.send('panel:plugin-opened', {
    id: rec.manifest.id,
    name: rec.manifest.name,
    icon: rec.iconDataUrl
  })
  entry.view.webContents.focus()
}

/**
 * 把插件分离为独立窗口：整个 WebContentsView 重挂载到新的 BrowserWindow，
 * 渲染进程与页面状态原样保留；窗口带原生标题栏，出现在任务栏/Alt-Tab。
 */
export function detachPlugin(id: string, payload?: PluginOpenPayload): { ok: boolean; message?: string } {
  const rec = getPlugin(id)
  if (!rec) return { ok: false, message: '插件不存在' }
  if (rec.manifest.type !== 'web') return { ok: false, message: '仅 web 型插件支持分离为独立窗口' }
  const entry = ensureEntry(rec)

  if (entry.host) {
    entry.pending = payload
    if (!entry.host.isVisible()) entry.host.show()
    entry.host.focus()
    if (!entry.view.webContents.isLoading()) flushPayload(entry)
    return { ok: true }
  }

  if (activeId === id && panel) {
    panel.contentView.removeChildView(entry.view)
    activeId = null
    leavePluginLayout()
    panel.webContents.send('panel:plugin-exited')
  }

  const saved = getConfig().windowStates?.[id]
  const rect: WindowRect = saved ?? { width: 860, height: 640 }
  const area = screen.getDisplayMatching({
    x: rect.x ?? 0,
    y: rect.y ?? 0,
    width: rect.width,
    height: rect.height
  }).workArea
  const host = new BrowserWindow({
    width: Math.min(Math.max(rect.width, 420), area.width),
    height: Math.min(Math.max(rect.height, 360), area.height),
    ...(rect.x !== undefined
      ? {
          x: Math.min(Math.max(rect.x, area.x), area.x + area.width - rect.width),
          y: Math.min(Math.max(rect.y ?? area.y, area.y), area.y + area.height - rect.height)
        }
      : {}),
    minWidth: 420,
    minHeight: 360,
    title: rec.manifest.name,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    show: false
  })
  host.setMenuBarVisibility(false)
  host.contentView.addChildView(entry.view)

  const sync = (): void => {
    const [width, height] = host.getContentSize()
    entry.view.setBounds({ x: 0, y: 0, width, height })
  }
  host.on('resize', sync)
  sync()
  host.on('close', () => {
    const states = { ...(getConfig().windowStates ?? {}) }
    states[id] = host.getBounds()
    updateConfig({ windowStates: states })
  })
  host.on('closed', () => {
    const e = viewCache.get(id)
    if (e?.host === host) {
      viewCache.delete(id)
      try {
        e.view.webContents.close()
      } catch {
        /* ignore */
      }
    }
  })
  host.show()
  entry.host = host
  entry.pending = payload
  if (!entry.view.webContents.isLoading()) flushPayload(entry)
  entry.view.webContents.focus()
  return { ok: true }
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

/**
 * 摘掉面板里的插件视图。
 * restoreLayout=false 用于"换一个插件"：外框尺寸保持不变，不必先缩回主页再撑开。
 */
function detachActive(restoreLayout = true): boolean {
  if (!activeId || !panel) return false
  const entry = viewCache.get(activeId)
  if (entry) panel.contentView.removeChildView(entry.view)
  activeId = null
  if (restoreLayout) leavePluginLayout()
  return true
}

/** 当前在面板里打开的插件 id（分离到独立窗口的不算） */
export function getActivePluginId(): string | null {
  return activeId
}

/** 把当前插件页分离为独立窗口（面板外框随即收起、回到主页尺寸） */
export function detachActivePlugin(): { ok: boolean; message?: string } {
  if (!activeId) return { ok: false, message: '当前没有打开的插件' }
  const id = activeId
  return detachPlugin(id)
}

/** 按 webContents 定位调用方视图，处理 exit/hide/detach（区分面板内与已分离） */
export function exitBySender(wc: Electron.WebContents): void {
  const entry = entryFor(wc)
  if (entry?.host) {
    entry.host.close() // closed 事件里销毁视图并清缓存
    return
  }
  exitPlugin()
}

export function hideBySender(wc: Electron.WebContents): void {
  const entry = entryFor(wc)
  if (entry?.host) entry.host.hide()
  else hidePanel()
}

export function detachBySender(wc: Electron.WebContents): { ok: boolean; message?: string } {
  const entry = entryFor(wc)
  if (!entry) return { ok: false, message: '未找到插件视图' }
  return detachPlugin(entry.rec.manifest.id)
}

function onPluginCrashed(rec: PluginRecord, reason: string): void {
  console.error(`[plugin] 「${rec.manifest.name}」渲染进程崩溃(${reason})，已卸载该实例`)
  const entry = viewCache.get(rec.manifest.id)
  if (!entry) return
  if (activeId === rec.manifest.id) {
    panel?.contentView.removeChildView(entry.view)
    activeId = null
    leavePluginLayout()
    panel?.webContents.focus()
    panel?.webContents.send('panel:plugin-crashed', {
      id: rec.manifest.id,
      name: rec.manifest.name
    })
  }
  if (entry.host && !entry.host.isDestroyed()) entry.host.destroy()
  viewCache.delete(rec.manifest.id)
  try {
    entry.view.webContents.close()
  } catch {
    /* 崩溃后可能已不可关闭 */
  }
}

/** 卸载/重置单个插件：主动退出 + 销毁缓存视图与分离窗口 */
export function destroyPlugin(id: string): void {
  const entry = viewCache.get(id)
  if (!entry) return
  if (entry.host) {
    entry.host.destroy()
  } else if (activeId === id) {
    panel?.contentView.removeChildView(entry.view)
    activeId = null
    leavePluginLayout()
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
