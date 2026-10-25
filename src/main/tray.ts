import { app, Menu, nativeImage, Tray } from 'electron'
import { TRAY_ICON_DATA_URL } from './assets/tray-icon'
import { getConfig, updateConfig } from './config'

let tray: Tray | null = null

export function applyAutostart(enabled: boolean): void {
  if (!app.isPackaged) return // 开发阶段不写系统登录项
  app.setLoginItemSettings({ openAtLogin: enabled })
}

export function createTray(onToggle: () => void, onQuit: () => void): void {
  tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL))
  refreshTray(onToggle, onQuit)
  tray.on('click', onToggle)
}

export function refreshTray(onToggle: () => void, onQuit: () => void): void {
  if (!tray) return
  tray.setToolTip(`QuickLauncher（${getConfig().hotkey}）`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 / 隐藏面板', click: onToggle },
      { type: 'separator' },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: getConfig().autostart,
        click: (item) => {
          updateConfig({ autostart: item.checked })
          applyAutostart(item.checked)
        }
      },
      { type: 'separator' },
      { label: '退出', click: onQuit }
    ])
  )
}
