import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { getConfig, updateConfig, type WindowRect } from '../config'
import { centerInWorkArea, pluginSize } from './panelLayout'

export const PANEL_DEFAULT_WIDTH = 760
export const PANEL_DEFAULT_HEIGHT = 560
export const PANEL_MIN_WIDTH = 520
export const PANEL_MIN_HEIGHT = 400

/** 进插件页时至少伸展到的尺寸：主页是"搜一个就打开"，插件页是要在里面读/用的 */
export const PLUGIN_DEFAULT_WIDTH = 980
export const PLUGIN_DEFAULT_HEIGHT = 720
const DEFAULT_PLUGIN_SIZE = { width: PLUGIN_DEFAULT_WIDTH, height: PLUGIN_DEFAULT_HEIGHT }

let panel: BrowserWindow | null = null
/** 置顶钉住模式：失焦不自动隐藏（Esc/快捷键仍可隐藏） */
let pinned = false
/** 正在打开的原生对话框数量：dialog 会抢焦点，这期间不能把面板当"失焦"收起 */
let dialogDepth = 0
/** 启动时是否恢复了上次的位置尺寸（决定 show 时要不要重新定位） */
let restoredBounds = false
/** 进插件页前的窗口边界：返回主页时原样还原，避免主页被撑成大窗口 */
let homeBounds: (WindowRect & { x: number; y: number }) | null = null

export function getPanelWindow(): BrowserWindow | null {
  return panel
}

export function isPinned(): boolean {
  return pinned
}

/** 把矩形钳制进最近显示器的工作区，防止恢复历史位置跑出屏幕 */
export function clampRect(rect: WindowRect): WindowRect & { x: number; y: number } {
  const width = Math.max(PANEL_MIN_WIDTH, Math.round(rect.width))
  const height = Math.max(PANEL_MIN_HEIGHT, Math.round(rect.height))
  const display = screen.getDisplayMatching({
    x: rect.x ?? 0,
    y: rect.y ?? 0,
    width,
    height
  })
  const area = display.workArea
  const x = Math.round(
    Math.min(Math.max(rect.x ?? area.x + (area.width - width) / 2, area.x), area.x + area.width - width)
  )
  const y = Math.round(
    Math.min(Math.max(rect.y ?? area.y + workAreaOffset(area, height), area.y), area.y + area.height - height)
  )
  return { x, y, width, height }
}

function workAreaOffset(area: Electron.Rectangle, height: number): number {
  return Math.round(((area.height - height) / 3) * 1)
}

export function createPanelWindow(): BrowserWindow {
  const saved = getConfig().panelBounds
  const base: WindowRect & { x: number; y: number } = saved
    ? clampRect(saved)
    : {
        x: 0,
        y: 0,
        width: PANEL_DEFAULT_WIDTH,
        height: PANEL_DEFAULT_HEIGHT
      }

  panel = new BrowserWindow({
    width: base.width,
    height: base.height,
    ...(saved ? { x: base.x, y: base.y } : {}),
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/panel.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  restoredBounds = Boolean(saved)
  // 置顶级别抬高，避免被全屏应用之外的前台窗口遮挡
  panel.setAlwaysOnTop(true, 'screen-saver')

  panel.on('blur', () => {
    // 原生对话框（安装插件、挑可执行文件）自己会抢焦点，别把它连面板一起收起
    if (dialogDepth > 0) return
    // 置顶钉住或开着 DevTools 调试时不自动隐藏
    if (pinned || panel?.webContents.isDevToolsOpened()) return
    hidePanel()
  })
  panel.on('close', () => {
    savePanelBounds()
  })
  panel.on('closed', () => {
    panel = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void panel.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void panel.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return panel
}

export function savePanelBounds(): void {
  if (!panel) return
  // 插件页里隐藏面板时持久化的应是主页尺寸，否则下次唤起主页会拿到插件的宽窗口
  updateConfig({ panelBounds: homeBounds ?? panel.getBounds() })
}

export function showPanel(): void {
  if (!panel) return
  if (panel.isVisible()) {
    panel.focus()
    return
  }
  if (!restoredBounds) {
    const { workArea } = screen.getPrimaryDisplay()
    const [width] = panel.getSize()
    panel.setPosition(
      Math.round(workArea.x + (workArea.width - width) / 2),
      Math.round(workArea.y + workArea.height * 0.16)
    )
  }
  panel.show()
  panel.focus()
  panel.webContents.send('panel:shown')
}

export function hidePanel(): void {
  if (!panel?.isVisible()) return
  savePanelBounds()
  panel.hide()
}

export function togglePanel(): void {
  if (panel?.isVisible()) hidePanel()
  else showPanel()
}

/** 切换置顶钉住：钉住时点击面板外不会收起 */
export function togglePinned(): boolean {
  pinned = !pinned
  panel?.webContents.send('panel:pinned-changed', pinned)
  return pinned
}

/**
 * 以面板为父窗口开原生对话框。
 * 对话框会把焦点从面板拿走，不挡一下的话面板会先被 blur 收起，对话框就成了没爹的孤儿窗口
 * （选完文件回来，面板已经不见了）。结束后把焦点还给面板。
 */
export async function withPanelDialog<T>(open: () => Promise<T>): Promise<T> {
  dialogDepth++
  try {
    return await open()
  } finally {
    dialogDepth--
    if (panel && !panel.isDestroyed() && panel.isVisible()) panel.focus()
  }
}

/**
 * 进入插件页：面板伸展到适合"在里面读/用"的尺寸，并**以屏幕中心为锚点**展开。
 *
 * 主页贴着唤起位置（略偏上，像输入框"掉下来"），但插件页是要连续看/操作一段时间的窗口，
 * 端在屏幕正中才不别扭——以前保持顶边、只做水平居中，窗口一变大下半截就偏下。
 */
export function enterPluginLayout(): void {
  if (!panel) return
  const cur = panel.getBounds()
  if (!homeBounds) homeBounds = { ...cur }

  const area = screen.getDisplayMatching(cur).workArea
  const size = pluginSize(cur, getConfig().pluginBounds ?? DEFAULT_PLUGIN_SIZE, area)
  const target = centerInWorkArea(area, size)
  const same =
    target.x === cur.x && target.y === cur.y && target.width === cur.width && target.height === cur.height
  if (same) return
  panel.setBounds(target, false)
}

/** 退出插件页：记住这次的插件页尺寸，并还原主页尺寸 */
export function leavePluginLayout(): void {
  if (!panel || !homeBounds) return
  const b = panel.getBounds()
  updateConfig({ pluginBounds: { width: b.width, height: b.height } })
  panel.setBounds(clampRect(homeBounds), false)
  homeBounds = null
}
