import { app, dialog, Menu, nativeImage, Tray } from 'electron'
import { TRAY_ICON_DATA_URL } from './assets/tray-icon'
import { getConfig, updateConfig } from './config'
import { getPlugin } from './plugin/manager'

export interface TrayHandlers {
  onToggle(): void
  onQuit(): void
  onOpenPlugin(id: string): void
  onOpenSettings(): void
}

let tray: Tray | null = null
let handlers: TrayHandlers | null = null

function showAbout(): void {
  void dialog.showMessageBox({
    type: 'info',
    title: '关于 QuickLauncher',
    message: `QuickLauncher v${app.getVersion()}`,
    detail:
      '全局快捷键唤起的插件化工具面板\n\n' +
      `Electron ${process.versions.electron} · Node ${process.versions.node} · Chrome ${process.versions.chrome}`
  })
}

function buildMenu(): Menu {
  const cfg = getConfig()
  const pinnedPlugins = cfg.pinnedIds
    .map((id) => getPlugin(id))
    .filter((rec): rec is NonNullable<typeof rec> => Boolean(rec) && rec!.manifest.type === 'web')
  return Menu.buildFromTemplate([
    { label: `⚡  显示 / 隐藏面板\t${cfg.hotkey}`, click: () => handlers?.onToggle() },
    { type: 'separator' },
    {
      label: '📌  常用插件',
      submenu: pinnedPlugins.length
        ? pinnedPlugins.map((rec) => ({
            label: rec.manifest.name,
            click: () => handlers?.onOpenPlugin(rec.manifest.id)
          }))
        : [{ label: '暂无固定插件（面板中点击图钉固定）', enabled: false }]
    },
    { label: '⚙  设置…', click: () => handlers?.onOpenSettings() },
    { label: 'ℹ  关于 QuickLauncher', click: showAbout },
    { type: 'separator' },
    {
      label: '🔌  开机自启',
      type: 'checkbox',
      checked: cfg.autostart,
      click: (item) => {
        updateConfig({ autostart: item.checked })
        applyAutostart(item.checked)
      }
    },
    { type: 'separator' },
    { label: '✕  退出', click: () => handlers?.onQuit() }
  ])
}

export function applyAutostart(enabled: boolean): void {
  if (!app.isPackaged) return // 开发阶段不写系统登录项
  app.setLoginItemSettings({ openAtLogin: enabled })
}

export function createTray(handlers_: TrayHandlers): void {
  handlers = handlers_
  tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL))
  tray.on('click', () => handlers?.onToggle())
  refreshTray()
}

/** 配置/插件列表变化后重建托盘菜单（快捷键提示、常用插件子菜单） */
export function refreshTray(): void {
  if (!tray) return
  tray.setToolTip(`QuickLauncher（${getConfig().hotkey}）`)
  tray.setContextMenu(buildMenu())
}
