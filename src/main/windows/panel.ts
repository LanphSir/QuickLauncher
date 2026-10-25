import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'

export const PANEL_WIDTH = 760
export const PANEL_HEIGHT = 560

let panel: BrowserWindow | null = null

export function getPanelWindow(): BrowserWindow | null {
  return panel
}

export function createPanelWindow(): BrowserWindow {
  panel = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
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
  // 置顶级别抬高，避免被全屏应用之外的前台窗口遮挡
  panel.setAlwaysOnTop(true, 'screen-saver')

  panel.on('blur', () => {
    // 开着 DevTools 调试时不自动隐藏
    if (panel?.webContents.isDevToolsOpened()) return
    hidePanel()
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

export function showPanel(): void {
  if (!panel) return
  if (panel.isVisible()) {
    panel.focus()
    return
  }
  const { workArea } = screen.getPrimaryDisplay()
  const [width] = panel.getSize()
  panel.setPosition(
    Math.round(workArea.x + (workArea.width - width) / 2),
    Math.round(workArea.y + workArea.height * 0.16)
  )
  panel.show()
  panel.focus()
  panel.webContents.send('panel:shown')
}

export function hidePanel(): void {
  if (!panel?.isVisible()) return
  panel.hide()
}

export function togglePanel(): void {
  if (panel?.isVisible()) hidePanel()
  else showPanel()
}
