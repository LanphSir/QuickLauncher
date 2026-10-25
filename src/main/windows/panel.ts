import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { getConfig, updateConfig, type WindowRect } from '../config'

export const PANEL_DEFAULT_WIDTH = 760
export const PANEL_DEFAULT_HEIGHT = 560
export const PANEL_MIN_WIDTH = 520
export const PANEL_MIN_HEIGHT = 400

let panel: BrowserWindow | null = null
/** 置顶钉住模式：失焦不自动隐藏（Esc/快捷键仍可隐藏） */
let pinned = false
/** 启动时是否恢复了上次的位置尺寸（决定 show 时要不要重新定位） */
let restoredBounds = false

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
  updateConfig({ panelBounds: panel.getBounds() })
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
