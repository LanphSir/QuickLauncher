import { BrowserWindow, WebContentsView, screen } from 'electron'
import { join } from 'node:path'
import { getConfig, updateConfig, type WindowRect } from '../config'
import { getPlugin, pluginBuiltUrl, pluginEntryUrl, type PluginRecord } from '../plugin/manager'
import { ensurePluginSession } from '../plugin/sessions'
import { getCaller, registerPluginCaller } from '../plugin/callerRegistry'
import { enterPluginLayout, hidePanel, leavePluginLayout } from './panel'
import { pickEvictions, type LruCandidate } from './viewLru'
import { PLUGIN_FRAME, pluginViewRect } from '../../shared/pluginFrame'

export interface PluginOpenPayload {
  /** 面板搜索词，打开时透传给插件（appapi.onQuery 接收） */
  query?: string
  /** 面板搜索条目携带的意图（如手册+章节），插件自定义结构 */
  intent?: Record<string, unknown>
}

interface CacheEntry {
  view: WebContentsView
  rec: PluginRecord
  /** 非空 = 插件已分离到该独立窗口 */
  host: BrowserWindow | null
  pending?: PluginOpenPayload
  /** 当前加载的入口：dev server 启停后据此判断是否需要换源重载 */
  loadedUrl?: string
  /** 页面当前是否对用户可见（用于只在真正变化时推送生命周期事件） */
  visible: boolean
  /** 非空 = 已被 LRU 选中回收，正在给插件留收尾时间；再次打开会取消它 */
  destroyTimer?: ReturnType<typeof setTimeout>
}

/**
 * 常驻插件视图上限。每个 WebContentsView 都是独立渲染进程（20~40MB 起），
 * 不设上限的话，"每个插件都点一次"就能把常驻内存堆到看不下去。
 * 5 个覆盖绝大多数使用节奏：最近用过的几个来回切都是热的。
 *
 * 环境变量可覆盖：调内存问题时想更激进地回收，或用冒烟测试验证淘汰链路。
 */
const MAX_RESIDENT_VIEWS = Number.parseInt(process.env.QUICKLAUNCHER_PLUGIN_VIEW_LIMIT ?? '', 10) || 5

/** 淘汰前留给插件的收尾窗口：onDestroy 里还能赶上最后一次 storage.set */
const DESTROY_GRACE_MS = 400

/**
 * 插件宿主：每个 web 型插件一个独立 WebContentsView（独立渲染进程）。
 * - 视图缓存：退出插件不销毁页面，重进保留状态；缓存按 LRU 封顶（见 MAX_RESIDENT_VIEWS）
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
  // 面板整体隐藏（Esc / 失焦 / 快捷键收起）时，里面挂着的插件视图也看不见了
  win.on('hide', () => {
    const entry = activeId ? viewCache.get(activeId) : null
    if (entry) emitLifecycle(entry, 'hide')
  })
  win.on('show', () => {
    const entry = activeId ? viewCache.get(activeId) : null
    if (entry) emitLifecycle(entry, 'show')
  })
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

/**
 * 推 visible 状态给插件页（appapi.onShow / onHide）。
 * 只在状态真正变化时发：重复打开同一插件不该让插件重启轮询。
 * 页面还没加载完时不发——preload 初始态就是"可见"，与此时的事实一致。
 */
function emitLifecycle(entry: CacheEntry, state: 'show' | 'hide'): void {
  const next = state === 'show'
  if (entry.visible === next) return
  entry.visible = next
  const wc = entry.view.webContents
  if (wc.isDestroyed() || wc.isLoading()) return
  wc.send('plugin:lifecycle', { state })
}

function entryFor(wc: Electron.WebContents): CacheEntry | undefined {
  for (const entry of viewCache.values()) {
    if (entry.view.webContents.id === wc.id) return entry
  }
  return undefined
}

/**
 * 插件入口 URL。dev 模式在地址上带 `?__plugin=<id>` 标记：
 * 调试时能一眼看出哪个 target 属于哪个插件，冒烟脚本也靠它识别 dev 入口的页面。
 */
function entryUrlFor(rec: PluginRecord): string {
  const url = pluginEntryUrl(rec)
  if (!rec.devUrl) return url
  return `${url}${url.includes('?') ? '&' : '?'}__plugin=${encodeURIComponent(rec.manifest.id)}`
}

/**
 * 把条目提到 LRU 队尾（Map 的插入顺序就是顺序表：删了再塞即"最新"）。
 * 只动顺序不动数据，代价可以忽略。
 */
function touch(entry: CacheEntry): void {
  const id = entry.rec.manifest.id
  if (viewCache.get(id) !== entry) return
  viewCache.delete(id)
  viewCache.set(id, entry)
}

/** 内联插件是"输入即得"的常驻角色，淘汰它等于下次敲键要等页面启动 */
function mustStayResident(entry: CacheEntry): boolean {
  return (entry.rec.manifest.features ?? []).includes('inline')
}

/** 真正占着渲染进程的条目数：已排队回收的不算（它们 400ms 后就没了） */
function residentCount(): number {
  let count = 0
  for (const entry of viewCache.values()) if (!entry.destroyTimer) count++
  return count
}

/**
 * 按 LRU 回收到上限以内（策略见 viewLru.ts）。
 * 不淘汰的：当前激活的、分离到独立窗口的（用户看得见）、正在收尾的、内联插件；
 * 都在保护名单里就宁可暂时超出上限——下一次打开再收。
 */
function evictOverflow(): void {
  if (residentCount() <= MAX_RESIDENT_VIEWS) return
  const order: LruCandidate[] = []
  for (const [id, entry] of viewCache) {
    if (entry.destroyTimer) continue
    order.push({ id, protect: id === activeId || !!entry.host || mustStayResident(entry) })
  }
  for (const id of pickEvictions(order, MAX_RESIDENT_VIEWS)) {
    const entry = viewCache.get(id)
    if (entry) beginEvict(id, entry)
  }
}

/**
 * 先通知、后关闭：给插件 DESTROY_GRACE_MS 把内存里的状态落盘。
 * 这期间条目仍留在缓存里，重新打开会取消淘汰（页面状态原样保留）。
 */
function beginEvict(id: string, entry: CacheEntry): void {
  const wc = entry.view.webContents
  if (wc.isDestroyed()) {
    viewCache.delete(id)
    return
  }
  entry.destroyTimer = setTimeout(() => {
    if (viewCache.get(id) === entry) viewCache.delete(id)
    try {
      wc.close()
    } catch {
      /* 页面可能已自行关闭 */
    }
  }, DESTROY_GRACE_MS)
  // 定时器不该拖住应用退出
  entry.destroyTimer.unref?.()
  try {
    wc.send('plugin:lifecycle', { state: 'destroy' })
  } catch {
    /* 页面还没加载完时事件无人接收，直接等宽限期结束 */
  }
}

/** 确保插件视图存在（懒创建 + 预热加载），并把该条目提到 LRU 最新位 */
function ensureEntry(rec: PluginRecord): CacheEntry {
  const cached = viewCache.get(rec.manifest.id)
  if (cached) {
    // 正在被回收的视图又被打开了：撤销淘汰，页面原样留着
    if (cached.destroyTimer) {
      clearTimeout(cached.destroyTimer)
      cached.destroyTimer = undefined
    }
    touch(cached)
    return cached
  }
  const view = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/plugin.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // 独立分区：每个插件的 cookie / localStorage / 缓存互相看不到（含它内嵌的 webview）
      partition: ensurePluginSession(rec.manifest.id),
      // 插件可嵌入第三方网页（如官方翻译页）；实际放行由 will-attach-webview 按权限校验
      webviewTag: true
    }
  })
  const entry: CacheEntry = { view, rec, host: null, loadedUrl: entryUrlFor(rec), visible: false }
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
  view.webContents.on('did-finish-load', () => flushPayload(entry))
  /**
   * dev server 被强杀时 .dev-plugins.json 可能留下死地址（脚本没来得及清理），
   * 这时不能让插件页停在 "无法访问此网站"——回退到构建产物，功能至少可用。
   */
  view.webContents.on('did-fail-load', (_event, errorCode, errorDesc, validatedURL) => {
    const current = entry
    if (!current?.loadedUrl || !rec.devUrl) return
    if (!validatedURL.startsWith(rec.devUrl)) return
    // -3 是 ABORTED（用户/代码主动中断加载），不是故障
    if (errorCode === -3) return
    console.warn(`[plugin] ${rec.manifest.id} dev server 不可用(${errorDesc})，回退到构建产物`)
    current.loadedUrl = pluginBuiltUrl(rec)
    void view.webContents.loadURL(current.loadedUrl)
  })
  view.webContents.on('render-process-gone', (_event, details) => {
    onPluginCrashed(rec, details.reason)
  })
  void view.webContents.loadURL(entry.loadedUrl!)
  return entry
}

/**
 * 开发期切换入口来源后重载视图：例如插件从 dist 换成 dev server（或反过来），
 * 已缓存的页面要跟着换源，否则继续跑旧代码。
 */
export function reloadPluginViews(): void {
  for (const [id, entry] of viewCache) {
    const rec = getPlugin(id)
    if (!rec) continue
    // 已排队回收的视图没必要再换源加载
    if (entry.destroyTimer) continue
    const url = entryUrlFor(rec)
    if (url === entry.loadedUrl) continue
    entry.loadedUrl = url
    void entry.view.webContents.loadURL(url)
  }
}

/**
 * 重扫插件表后刷新已缓存条目：换掉 manifest 引用（权限/名称/入口都可能改了），
 * 重新登记身份锚定，入口 URL 变了就换源加载；插件被删掉的视图直接销毁。
 * 只改引用不动页面，正在跑的状态不受影响。
 */
export function refreshPluginRecords(): void {
  const gone: string[] = []
  for (const [id, entry] of viewCache) {
    const rec = getPlugin(id)
    if (!rec) {
      gone.push(id)
      continue
    }
    if (entry.rec === rec) continue
    entry.rec = rec
    registerPluginCaller(entry.view.webContents, rec)
  }
  for (const id of gone) destroyPlugin(id)
  // 入口来源可能变了（dev server 启停、entry 改名），需要换源的在这里重载
  reloadPluginViews()
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
  emitLifecycle(entry, 'show')
  panel.webContents.send('panel:plugin-opened', {
    id: rec.manifest.id,
    name: rec.manifest.name,
    icon: rec.iconDataUrl
  })
  entry.view.webContents.focus()
  // 激活关系变了：上一个插件现在不再是"当前可见"，可以参与淘汰了。
  // 这一步必须放在 activeId 更新之后——创建视图时旧插件还受保护，只看那里永远清不掉。
  evictOverflow()
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
  // 分离窗口的最小化/隐藏也算"不可见"，插件可以照样暂停后台工作
  host.on('show', () => emitLifecycle(entry, 'show'))
  host.on('hide', () => emitLifecycle(entry, 'hide'))
  host.on('close', () => {
    const states = { ...(getConfig().windowStates ?? {}) }
    states[id] = host.getBounds()
    updateConfig({ windowStates: states })
  })
  host.on('closed', () => {
    const e = viewCache.get(id)
    if (e?.host === host) {
      viewCache.delete(id)
      if (e.destroyTimer) clearTimeout(e.destroyTimer)
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
  if (entry) {
    panel.contentView.removeChildView(entry.view)
    // 被切走 = 不可见：插件据此暂停轮询/动画（剪贴板历史就是这么省电的）
    emitLifecycle(entry, 'hide')
  }
  activeId = null
  if (restoreLayout) leavePluginLayout()
  return true
}

/**
 * 预热插件视图但不挂到面板上：内联插件（features: ["inline"]）要在后台接查询。
 * 页面可能还在加载，是否可用由调用方看 isLoading() 决定（加载中就别推查询，
 * 等 did-finish-load 后再让面板重查一次）。
 */
export function warmPluginContents(rec: PluginRecord): Electron.WebContents | null {
  const wc = ensureEntry(rec).view.webContents
  // 预热不经过"激活"这一步，回收只能在这里做（新建的条目在队尾，不会先被选中）
  evictOverflow()
  return wc.isDestroyed() ? null : wc
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
  if (entry.destroyTimer) clearTimeout(entry.destroyTimer)
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
  if (entry.destroyTimer) clearTimeout(entry.destroyTimer)
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
    if (entry.destroyTimer) clearTimeout(entry.destroyTimer)
    try {
      entry.view.webContents.close()
    } catch {
      /* ignore */
    }
  }
  viewCache.clear()
  activeId = null
}
