import { app, dialog, ipcMain, Notification, shell } from 'electron'
import { loadConfig, getConfig, updateConfig, type PluginOverride } from './config'
import {
  clampRect,
  createPanelWindow,
  getPanelWindow,
  hidePanel,
  savePanelBounds,
  showPanel,
  togglePinned
} from './windows/panel'
import {
  destroyAll,
  destroyPlugin,
  detachActivePlugin,
  detachPlugin,
  exitPlugin,
  exitToHome,
  initPluginHost,
  showPlugin,
  type PluginOpenPayload
} from './windows/pluginHost'
import {
  getPlugin,
  installPluginFromPath,
  listPlugins,
  scanPlugins,
  uninstallPlugin
} from './plugin/manager'
import { initGateway } from './plugin/gateway'
import { initHotkey, registerHotkey, unregisterAll } from './hotkey'
import { applyAutostart, createTray, refreshTray } from './tray'
import { launchExternalPlugin } from './services/external'
import { pluginStorage } from './services/storage'

/** 唤起面板并回到主页 */
function togglePanelWithHome(): void {
  const win = getPanelWindow()
  if (win?.isVisible()) {
    hidePanel()
  } else {
    exitToHome()
    showPanel()
  }
}

/** 打开插件的统一入口（面板回车/点击、托盘菜单共用） */
function activatePlugin(
  id: string,
  payload?: PluginOpenPayload,
  detached = false
): { ok: boolean; message?: string } {
  const rec = getPlugin(id)
  if (!rec) return { ok: false, message: '插件不存在' }
  if (rec.disabled) return { ok: false, message: '插件已停用' }
  if (rec.manifest.type === 'external') {
    const result = launchExternalPlugin(rec)
    hidePanel()
    return result
  }
  if (detached) return detachPlugin(id, payload)
  if (!getPanelWindow()?.isVisible()) showPanel()
  showPlugin(rec, payload)
  return { ok: true }
}

function registerPanelIpc(): void {
  /** 插件列表变化后通知面板刷新 */
  function notifyPluginsChanged(): void {
    getPanelWindow()?.webContents.send('panel:plugins-changed')
  }

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
      pinned: pinnedIds.includes(rec.manifest.id),
      permissions: rec.manifest.permissions ?? [],
      source: rec.source,
      disabled: rec.disabled,
      command: rec.manifest.type === 'external' ? rec.manifest.command : undefined,
      args: rec.manifest.type === 'external' ? rec.manifest.args : undefined,
      dir: rec.dir
    }))
  })

  ipcMain.handle('panel:open-plugin', (_event, { id, query }: { id: string; query?: string }) => {
    const rec = getPlugin(String(id))
    if (rec?.disabled) return { ok: false, message: '插件已停用，请在 设置 → 插件管理 中启用' }
    return activatePlugin(String(id), query ? { query: String(query) } : undefined)
  })

  ipcMain.handle('panel:detach-plugin', (_event, id: string) => {
    const rec = getPlugin(String(id))
    if (rec?.disabled) return { ok: false, message: '插件已停用，请在 设置 → 插件管理 中启用' }
    return detachPlugin(String(id))
  })

  // —— 窗口管理：自实现缩放（透明无边框窗口不支持系统边缘缩放）——
  ipcMain.handle('panel:get-window-bounds', () => getPanelWindow()?.getBounds() ?? null)

  ipcMain.handle('panel:set-window-bounds', (_event, rect: { x: number; y: number; width: number; height: number }) => {
    getPanelWindow()?.setBounds(clampRect(rect))
    return true
  })

  ipcMain.handle('panel:save-window-bounds', () => {
    savePanelBounds()
    return true
  })

  ipcMain.handle('panel:toggle-pinned', () => ({ pinned: togglePinned() }))

  ipcMain.handle('panel:install-plugin', async (_event, mode: string) => {
    const panelWin = getPanelWindow()
    if (!panelWin) return { ok: false, message: '面板未就绪' }
    const picked =
      mode === 'zip'
        ? await dialog.showOpenDialog(panelWin, {
            title: '选择插件 ZIP 包',
            properties: ['openFile'],
            filters: [{ name: 'ZIP 插件包', extensions: ['zip'] }]
          })
        : await dialog.showOpenDialog(panelWin, {
            title: '选择插件目录（含 plugin.json 或 dist/plugin.json）',
            properties: ['openDirectory']
          })
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true }
    const result = installPluginFromPath(picked.filePaths[0])
    if (result.ok) {
      refreshTray()
      notifyPluginsChanged()
    }
    return result
  })

  ipcMain.handle('panel:uninstall-plugin', (_event, id: string) => {
    destroyPlugin(String(id))
    const result = uninstallPlugin(String(id))
    if (result.ok) {
      refreshTray()
      notifyPluginsChanged()
    }
    return result
  })

  ipcMain.handle('panel:set-plugin-disabled', (_event, { id, disabled }) => {
    const cur = getConfig().disabledPluginIds
    const next = disabled
      ? [...new Set([...cur, String(id)])]
      : cur.filter((x) => x !== String(id))
    updateConfig({ disabledPluginIds: next })
    scanPlugins()
    refreshTray()
    notifyPluginsChanged()
    return { ok: true }
  })

  ipcMain.handle('panel:reveal-plugin-dir', (_event, id: string) => {
    const rec = getPlugin(String(id))
    if (!rec) return { ok: false, message: '插件不存在' }
    void shell.openPath(rec.baseDir)
    return { ok: true }
  })

  ipcMain.handle('panel:pin', (_event, { id, pinned }) => {
    const { pinnedIds } = getConfig()
    const next = pinned
      ? [...new Set([...pinnedIds, String(id)])]
      : pinnedIds.filter((x) => x !== String(id))
    updateConfig({ pinnedIds: next })
    refreshTray()
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
    }
    const { autostart, ...rest } = patch
    updateConfig(rest)
    if (typeof autostart === 'boolean') {
      updateConfig({ autostart })
      applyAutostart(autostart)
    }
    refreshTray()
    return { ok: true, config: { ...getConfig(), isPackaged: app.isPackaged } }
  })

  ipcMain.handle('panel:hide', () => {
    hidePanel()
    return true
  })

  // 插件页外框：返回主页 / 把当前插件甩到独立窗口
  ipcMain.handle('panel:exit-plugin', () => {
    exitPlugin()
    return { ok: true }
  })

  ipcMain.handle('panel:detach-active', () => detachActivePlugin())

  // 保存 external 型插件的启动命令覆盖（command 留空 = 恢复默认）
  ipcMain.handle(
    'panel:save-plugin-override',
    (_event, { id, command, args }: { id: string; command?: string; args?: string }) => {
      const rec = getPlugin(String(id))
      if (!rec || rec.manifest.type !== 'external') return { ok: false, message: '插件不存在或不是外部程序型' }
      const cmd = String(command ?? '').trim()
      const overrides: Record<string, PluginOverride> = { ...getConfig().pluginOverrides }
      if (!cmd) {
        delete overrides[String(id)]
        rec.manifest.command = rec.baseCommand
        rec.manifest.args = [...(rec.baseArgs ?? [])]
      } else {
        const argList = String(args ?? '')
          .split(/\s+/)
          .filter(Boolean)
        overrides[String(id)] = { command: cmd, args: argList }
        rec.manifest.command = cmd
        rec.manifest.args = argList
      }
      updateConfig({ pluginOverrides: overrides })
      refreshTray()
      return { ok: true, command: rec.manifest.command, args: rec.manifest.args }
    }
  )

  ipcMain.handle('panel:clear-plugin-data', (_event, id: string) => {
    const rec = getPlugin(String(id))
    if (!rec) return { ok: false, message: '插件不存在' }
    return { ok: pluginStorage.clear(String(id)) }
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

    createTray({
      onToggle: togglePanelWithHome,
      onQuit: () => app.quit(),
      onOpenPlugin: (id) => void activatePlugin(id),
      onOpenSettings: () => {
        if (!getPanelWindow()?.isVisible()) showPanel()
        panel.webContents.send('panel:open-settings')
      }
    })
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
