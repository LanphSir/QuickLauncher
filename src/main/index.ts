import { app, ipcMain, Notification } from 'electron'
import { loadConfig, getConfig, updateConfig } from './config'
import {
  createPanelWindow,
  getPanelWindow,
  hidePanel,
  showPanel
} from './windows/panel'
import { destroyAll, exitToHome, initPluginHost, showPlugin } from './windows/pluginHost'
import { getPlugin, listPlugins, scanPlugins } from './plugin/manager'
import { initGateway } from './plugin/gateway'
import { initHotkey, registerHotkey, unregisterAll } from './hotkey'
import { applyAutostart, createTray, refreshTray } from './tray'
import { launchExternalPlugin } from './services/external'

function togglePanelWithHome(): void {
  const win = getPanelWindow()
  if (win?.isVisible()) {
    hidePanel()
  } else {
    exitToHome()
    showPanel()
  }
}

function registerPanelIpc(): void {
  ipcMain.handle('panel:get-plugins', () => {
    const { pinnedIds } = getConfig()
    return listPlugins().map((rec) => ({
      id: rec.manifest.id,
      name: rec.manifest.name,
      version: rec.manifest.version,
      description: rec.manifest.description,
      type: rec.manifest.type,
      keywords: rec.manifest.keywords ?? [],
      icon: rec.iconDataUrl,
      pinned: pinnedIds.includes(rec.manifest.id)
    }))
  })

  ipcMain.handle('panel:open-plugin', (_event, id: string) => {
    const rec = getPlugin(String(id))
    if (!rec) return { ok: false, message: '插件不存在' }
    if (rec.manifest.type === 'external') {
      const result = launchExternalPlugin(rec)
      hidePanel()
      return result
    }
    showPlugin(rec)
    return { ok: true }
  })

  ipcMain.handle('panel:pin', (_event, { id, pinned }) => {
    const { pinnedIds } = getConfig()
    const next = pinned
      ? [...new Set([...pinnedIds, String(id)])]
      : pinnedIds.filter((x) => x !== String(id))
    updateConfig({ pinnedIds: next })
    return next
  })

  ipcMain.handle('panel:get-config', () => ({ ...getConfig(), isPackaged: app.isPackaged }))

  ipcMain.handle('panel:update-config', (_event, patch: Record<string, unknown>) => {
    let hotkeyResult: { ok: boolean; message?: string } = { ok: true }
    if (typeof patch.hotkey === 'string' && patch.hotkey !== getConfig().hotkey) {
      hotkeyResult = registerHotkey(patch.hotkey)
      if (!hotkeyResult.ok) {
        return { ok: false, message: hotkeyResult.message, config: { ...getConfig(), isPackaged: app.isPackaged } }
      }
      refreshTray(togglePanelWithHome, () => app.quit())
    }
    const { autostart, ...rest } = patch
    updateConfig(rest)
    if (typeof autostart === 'boolean') {
      updateConfig({ autostart })
      applyAutostart(autostart)
    }
    return { ok: true, config: { ...getConfig(), isPackaged: app.isPackaged } }
  })

  ipcMain.handle('panel:hide', () => {
    hidePanel()
    return true
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.setAppUserModelId(app.isPackaged ? 'com.zcode.quicklauncher' : process.execPath)

  app.on('second-instance', () => {
    exitToHome()
    showPanel()
  })

  void app.whenReady().then(() => {
    loadConfig()
    scanPlugins()

    const panel = createPanelWindow()
    initPluginHost(panel)
    initGateway()
    registerPanelIpc()

    initHotkey(togglePanelWithHome)
    const reg = registerHotkey(getConfig().hotkey)
    if (!reg.ok && reg.message) {
      new Notification({ title: 'QuickLauncher', body: reg.message }).show()
    }

    createTray(togglePanelWithHome, () => app.quit())
    if (getConfig().autostart) applyAutostart(true)
  })
}

app.on('window-all-closed', () => {
  /* 托盘常驻，不随窗口关闭退出 */
})

app.on('before-quit', () => {
  unregisterAll()
  destroyAll()
})
