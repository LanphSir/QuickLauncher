import { app, clipboard, dialog, ipcMain, Notification, shell } from 'electron'
import { loadConfig, getConfig, updateConfig, type PluginOverride } from './config'
import {
  clampRect,
  createPanelWindow,
  getPanelWindow,
  hidePanel,
  savePanelBounds,
  showPanel,
  togglePinned,
  withPanelDialog
} from './windows/panel'
import {
  destroyAll,
  destroyPlugin,
  detachActivePlugin,
  detachPlugin,
  exitPlugin,
  exitToHome,
  initPluginHost,
  refreshPluginRecords,
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
import { installPluginProtocol, registerPluginSchemePrivileges } from './plugin/protocol'
import { clearPluginSession } from './plugin/sessions'
import { forgetInline, queryInline } from './plugin/inline'
import { watchDevServers } from './plugin/devServers'
import { watchPluginDirs } from './plugin/watcher'
import { initHotkey, registerHotkey, unregisterAll } from './hotkey'
import { applyAutostart, createTray, refreshTray } from './tray'
import { launchExternalPlugin } from './services/external'
import { pluginStorage } from './services/storage'
import { clearSearchEntries, loadSearchIndexes, querySearch } from './services/searchIndex'

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
      features: rec.manifest.features ?? [],
      source: rec.source,
      disabled: rec.disabled,
      command: rec.manifest.type === 'external' ? rec.manifest.command : undefined,
      args: rec.manifest.type === 'external' ? rec.manifest.args : undefined,
      dir: rec.dir
    }))
  })

  ipcMain.handle('panel:open-plugin', (_event, { id, query, intent }: { id: string; query?: string; intent?: Record<string, unknown> }) => {
    const rec = getPlugin(String(id))
    if (rec?.disabled) return { ok: false, message: '插件已停用，请在 设置 → 插件管理 中启用' }
    const payload: PluginOpenPayload = {}
    if (query) payload.query = String(query)
    if (intent && typeof intent === 'object') payload.intent = intent
    return activatePlugin(String(id), Object.keys(payload).length ? payload : undefined)
  })

  // 搜索贡献：插件注册的条目在这里被检索（面板每敲一次键查一次）
  ipcMain.handle('panel:search', (_event, query: string) => querySearch(String(query ?? ''), listPlugins()))

  /**
   * 内联结果：声明 features:["inline"] 的插件在后台接查询，最多等 120ms。
   * 与 panel:search 分成两条通道：条目检索是纯内存查表（毫秒级），内联要等插件回话，
   * 混在一起会拖慢本来很快的那条路径。
   */
  ipcMain.handle('panel:inline', (_event, query: string) => queryInline(String(query ?? ''), listPlugins()))

  /** 内联结果「回车复制」：写系统剪贴板由主进程统一做，渲染层不碰权限 */
  ipcMain.handle('panel:copy-text', (_event, text: string) => {
    const value = String(text ?? '')
    if (!value) return false
    clipboard.writeText(value)
    return true
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
    const picked = await withPanelDialog(() =>
      mode === 'zip'
        ? dialog.showOpenDialog(panelWin, {
            title: '选择插件 ZIP 包',
            properties: ['openFile'],
            filters: [{ name: 'ZIP 插件包', extensions: ['zip'] }]
          })
        : dialog.showOpenDialog(panelWin, {
            title: '选择插件目录（含 plugin.json 或 dist/plugin.json）',
            properties: ['openDirectory']
          })
    )
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true }
    const result = installPluginFromPath(picked.filePaths[0])
    if (result.ok) {
      refreshTray()
      notifyPluginsChanged()
    }
    return result
  })

  // 浏览本地文件挑可执行文件：路径手打最容易打错（空格、中文目录、隐藏的 Program Files）
  ipcMain.handle('panel:pick-command', async () => {
    const panelWin = getPanelWindow()
    if (!panelWin) return { ok: false, message: '面板未就绪' }
    const picked = await withPanelDialog(() =>
      dialog.showOpenDialog(panelWin, {
        title: '选择要启动的程序',
        buttonLabel: '选这个',
        properties: ['openFile'],
        filters:
          process.platform === 'win32'
            ? [
                { name: '程序与快捷方式', extensions: ['exe', 'com', 'bat', 'cmd', 'lnk'] },
                { name: '所有文件', extensions: ['*'] }
              ]
            : [{ name: '所有文件', extensions: ['*'] }]
      })
    )
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true }
    return { ok: true, path: picked.filePaths[0] }
  })

  ipcMain.handle('panel:uninstall-plugin', (_event, id: string) => {
    destroyPlugin(String(id))
    forgetInline(String(id))
    const result = uninstallPlugin(String(id))
    if (result.ok) {
      clearSearchEntries(String(id))
      // 卸载后把该插件的分区数据（cookie / localStorage / 缓存）一并清掉，不留残留登录态
      void clearPluginSession(String(id))
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
    // 停用后不再参与内联查询：作废等待中的一轮，免得面板空等 120ms
    if (disabled) forgetInline(String(id))
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

  ipcMain.handle('panel:clear-plugin-data', async (_event, id: string) => {
    const rec = getPlugin(String(id))
    if (!rec) return { ok: false, message: '插件不存在' }
    const storeOk = pluginStorage.clear(String(id))
    // 一并清掉浏览器侧数据（localStorage / cookie / 缓存），否则"清除数据"只清了一半
    try {
      await clearPluginSession(String(id))
    } catch (err) {
      console.error('[plugin] 清除会话数据失败', err)
    }
    return { ok: storeOk }
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // 自定义协议必须在 app ready 之前声明特权，否则 standard/secure 等语义不生效
  registerPluginSchemePrivileges()
  app.setAppUserModelId(app.isPackaged ? 'com.zcode.quicklauncher' : process.execPath)

  app.on('second-instance', () => {
    exitToHome()
    showPanel()
  })

  void app.whenReady().then(() => {
    // 插件页走 plugin://<id>/…：注册请求处理（插件各自的分区在首次创建视图时注册）
    installPluginProtocol()
    loadConfig()
    scanPlugins()
    // 搜索索引在插件扫描后恢复：落盘条目 + 插件目录里的静态索引共同构成冷启动可搜内容
    loadSearchIndexes()

    const panel = createPanelWindow()
    initPluginHost(panel)
    initGateway()
    registerPanelIpc()

    // 开发期热更新：`pnpm dev:plugin <name>` 启停 dev server 会改写 .dev-plugins.json，
    // 这里跟着重扫插件表并给已打开的视图换源，不必重启应用。打包版此函数直接 return。
    watchDevServers(() => {
      scanPlugins()
      refreshPluginRecords()
      refreshTray()
      getPanelWindow()?.webContents.send('panel:plugins-changed')
      console.log('[plugin] 开发期入口已更新')
    })

    // 插件目录监听：把插件目录丢进来、改了 plugin.json 都自动生效，不用重启
    // （打包版只监听用户安装目录——内置插件在安装目录里不会变）
    watchPluginDirs(() => {
      scanPlugins()
      refreshPluginRecords()
      refreshTray()
      getPanelWindow()?.webContents.send('panel:plugins-changed')
      console.log('[plugin] 插件目录已变化，已重扫')
    })

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
  // 存储写盘是防抖的：退出前把还在排队的分片落下去，否则最后几次 set 会丢
  pluginStorage.flushAll()
  destroyAll()
})
