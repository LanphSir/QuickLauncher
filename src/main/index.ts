import { app, clipboard, dialog, ipcMain, Notification, shell } from 'electron'
import { readFileSync, statSync } from 'node:fs'
import {
  loadConfig,
  getConfig,
  updateConfig,
  DEFAULT_HOTKEY,
  type AppConfig,
  type PluginOverride
} from './config'
import {
  clampRect,
  createPanelWindow,
  getPanelWindow,
  hidePanel,
  holdPanelVisible,
  releasePanelVisible,
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
import { isBlurBehavior } from './windows/panelVisibility'
import {
  TOGGLE_OWNER,
  initHotkey,
  registerHotkey,
  syncHotkeys,
  unregisterAll,
  type HotkeyApplyResult
} from './hotkey'
import {
  buildPluginHotkeyPlan,
  isAcceleratorLike,
  normalizeAccelerator,
  sanitizeHotkeyMap,
  type HotkeyPluginLike
} from './plugin/hotkeyPlan'
import { applyAutostart, createTray, refreshTray } from './tray'
import { launchExternalPlugin } from './services/external'
import { pluginStorage } from './services/storage'
import {
  deleteShortcut,
  getShortcut,
  importShortcuts,
  listShortcuts,
  saveShortcut,
  scanShortcutCandidates
} from './services/shortcuts'
import { warmShortcutIcons } from './services/shortcutIcons'
import type { ShortcutEntry } from './services/shortcutModel'
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

/** 插件快捷键当前没生效的原因（key 为插件 id）；getPlugins 和设置页共用这一份 */
let pluginHotkeyErrors = new Map<string, string>()

/**
 * 把「配置里的快捷键」同步成「系统里真正注册的快捷键」。
 * 插件表、停用状态、唤起键任一变化后都要调一次——只同步差量，调频繁了也不抖。
 */
function syncAllHotkeys(): HotkeyApplyResult[] {
  const cfg = getConfig()
  const plugins: HotkeyPluginLike[] = listPlugins().map((rec) => ({
    id: rec.manifest.id,
    name: rec.manifest.name,
    disabled: rec.disabled
  }))
  const plan = buildPluginHotkeyPlan(cfg.pluginHotkeys ?? {}, plugins, [cfg.hotkey])
  const results = syncHotkeys([
    { owner: TOGGLE_OWNER, accelerator: cfg.hotkey, action: togglePanelWithHome },
    ...plan.active.map((item) => ({
      owner: item.id,
      accelerator: item.accelerator,
      // web 型：唤起面板并进插件页；external 型：直接拉起程序（activatePlugin 内部已分流）
      action: () => {
        void activatePlugin(item.id)
      }
    }))
  ])

  pluginHotkeyErrors = new Map()
  // 静态冲突（被抢/非法）在前，运行时注册失败（被别的程序占用）覆盖在后面。
  // 「插件已停用」不算错误：配置本就该留着，重新启用即可恢复，界面上另有停用标记
  for (const skip of plan.skipped) {
    if (skip.reason !== 'disabled') pluginHotkeyErrors.set(skip.id, skip.message)
  }
  for (const r of results) {
    if (!r.ok && r.owner !== TOGGLE_OWNER && r.message) pluginHotkeyErrors.set(r.owner, r.message)
  }
  return results
}

/**
 * 找出当前占着这个键的插件。
 * 停用的插件不算：它没在系统里真正占位，全局键可以拿走（重新启用时再判冲突）。
 */
function pluginHotkeyHolder(norm: string): string | null {
  for (const [id, acc] of Object.entries(getConfig().pluginHotkeys ?? {})) {
    if (normalizeAccelerator(acc) !== norm) continue
    const rec = getPlugin(id)
    if (!rec || rec.disabled) continue
    return rec.manifest.name
  }
  return null
}


/** 图标一个个异步到，合并成一次通知：否则一次启动会触发 N 次整表刷新 */
let iconNotifyTimer: ReturnType<typeof setTimeout> | null = null

/** 补图标：先把界面上已有的（缓存）用着，缺的异步填进去 */
function warmShortcutIconsAsync(entries: ShortcutEntry[]): void {
  if (!entries.length) return
  void warmShortcutIcons(entries, (id, dataUrl) => {
    const rec = getPlugin(id)
    if (rec) rec.iconDataUrl = dataUrl
    if (iconNotifyTimer) return
    iconNotifyTimer = setTimeout(() => {
      iconNotifyTimer = null
      getPanelWindow()?.webContents.send('panel:plugins-changed')
    }, 200)
  })
}

/** 自定义应用变化后的统一收尾：重扫注册表 → 刷新已开视图 → 托盘 → 快捷键 → 通知面板 */
function afterShortcutChange(entries?: ShortcutEntry[]): void {
  scanPlugins()
  refreshPluginRecords()
  refreshTray()
  syncAllHotkeys()
  getPanelWindow()?.webContents.send('panel:plugins-changed')
  warmShortcutIconsAsync(entries ?? listShortcuts())
}

function shortcutTakenIds(): Set<string> {
  return new Set(listPlugins().map((rec) => rec.manifest.id))
}

/**
 * 设置页拿的配置：额外带 isPackaged（前端据此提示自启）和 defaultHotkey。
 * 默认键只在主进程定义一处——前端硬编码一份必然会和 config.ts 走岔。
 */
function configView(): AppConfig & { isPackaged: boolean; defaultHotkey: string } {
  return { ...getConfig(), isPackaged: app.isPackaged, defaultHotkey: DEFAULT_HOTKEY }
}

function registerPanelIpc(): void {
  /** 插件列表变化后通知面板刷新 */
  function notifyPluginsChanged(): void {
    // 插件增删/启停都会改变「该注册哪些键」，顺手同步一次
    syncAllHotkeys()
    getPanelWindow()?.webContents.send('panel:plugins-changed')
  }

  ipcMain.handle('panel:get-plugins', () => {
    const { pinnedIds, pluginHotkeys } = getConfig()
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
      // 快捷启动键：hotkey 是用户配的（生效中），suggestion 只是插件作者的建议值
      hotkey: pluginHotkeys?.[rec.manifest.id] ?? '',
      hotkeySuggestion: rec.manifest.hotkey,
      hotkeyError: pluginHotkeyErrors.get(rec.manifest.id),
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

  // —— 自定义外部应用（userData/shortcuts.json）——

  ipcMain.handle('panel:get-shortcuts', () => listShortcuts())

  ipcMain.handle('panel:get-shortcut', (_event, id: string) => getShortcut(String(id)) ?? null)

  ipcMain.handle('panel:save-shortcut', (_event, draft: Record<string, unknown>) => {
    const result = saveShortcut(draft ?? {}, shortcutTakenIds())
    if (!result.ok || !result.entry) return { ok: false, message: result.message ?? '保存失败' }
    afterShortcutChange([result.entry])
    return { ok: true, entry: result.entry }
  })

  ipcMain.handle('panel:delete-shortcut', (_event, id: string) => {
    if (!deleteShortcut(String(id))) return { ok: false, message: '没找到这个应用' }
    afterShortcutChange()
    return { ok: true }
  })

  /** 开始菜单 / 桌面里的候选（.lnk / .url），已导入的会被剔掉 */
  ipcMain.handle('panel:scan-shortcut-candidates', () => scanShortcutCandidates())

  ipcMain.handle('panel:import-shortcuts', (_event, items: unknown) => {
    const list = Array.isArray(items)
      ? items
          .filter(
            (x): x is { path: string; name?: unknown } =>
              !!x && typeof x === 'object' && typeof (x as { path?: unknown }).path === 'string'
          )
          .map((x) => ({ path: x.path, name: typeof x.name === 'string' ? x.name : '' }))
      : []
    const result = importShortcuts(list, shortcutTakenIds())
    if (result.created) afterShortcutChange()
    return result
  })

  /**
   * 选图标图片：这里只回源路径 + 预览。
   * 复制进 userData 放到"保存"时做——那时才知道这条记录的最终 id，文件名才不会乱。
   */
  ipcMain.handle('panel:pick-icon-image', async () => {
    const panelWin = getPanelWindow()
    if (!panelWin) return { ok: false, message: '面板未就绪' }
    const picked = await withPanelDialog(() =>
      dialog.showOpenDialog(panelWin, {
        title: '选择图标图片',
        properties: ['openFile'],
        filters: [{ name: '图片', extensions: ['png', 'ico', 'jpg', 'jpeg', 'svg', 'webp', 'bmp'] }]
      })
    )
    const file = picked.filePaths[0]
    if (picked.canceled || !file) return { ok: false, canceled: true }
    const mime: Record<string, string> = {
      '.png': 'image/png',
      '.ico': 'image/x-icon',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp'
    }
    try {
      if (statSync(file).size > 512 * 1024) return { ok: false, message: '图片太大了（上限 512KB）' }
      const type = mime[file.slice(file.lastIndexOf('.')).toLowerCase()]
      if (!type) return { ok: false, message: '不支持这种图片格式' }
      return { ok: true, path: file, dataUrl: `data:${type};base64,${readFileSync(file).toString('base64')}` }
    } catch (err) {
      return { ok: false, message: `读取图片失败：${err instanceof Error ? err.message : String(err)}` }
    }
  })

  ipcMain.handle('panel:pick-directory', async () => {
    const panelWin = getPanelWindow()
    if (!panelWin) return { ok: false, message: '面板未就绪' }
    const picked = await withPanelDialog(() =>
      dialog.showOpenDialog(panelWin, {
        title: '选择工作目录',
        buttonLabel: '用这个目录',
        properties: ['openDirectory']
      })
    )
    const dir = picked.filePaths[0]
    if (picked.canceled || !dir) return { ok: false, canceled: true }
    return { ok: true, path: dir }
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
    if (!rec.baseDir) return { ok: false, message: '自定义应用没有插件目录' }
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

  /**
   * 设置/清除某个插件的启动快捷键。
   * 冲突预检放在写配置之前：两个插件抢同一个键时，先落盘再让用户发现"有一个没生效"很难查。
   * 注册失败（被别的程序占用）则回滚配置——宁可没设上，也不要留一个看着有、按了没反应的键。
   */
  ipcMain.handle('panel:set-plugin-hotkey', (_event, { id, accelerator }: { id: string; accelerator?: string }) => {
    const rec = getPlugin(String(id))
    if (!rec) return { ok: false, message: '插件不存在' }
    const pluginId = String(id)
    const acc = String(accelerator ?? '').trim()
    if (acc && !isAcceleratorLike(acc)) {
      return { ok: false, message: `${acc} 不是有效的组合键（至少要有 Alt / Ctrl / Shift / Win 之一）` }
    }

    const before = getConfig().pluginHotkeys ?? {}
    const next: Record<string, string> = { ...before }
    if (acc) next[pluginId] = acc
    else delete next[pluginId]

    // 与全局唤起键、或别的插件抢同一个键时直接拒绝（按归一化后的键比较，大小写/空格不算不同）
    if (acc) {
      const norm = normalizeAccelerator(acc)
      if (norm === normalizeAccelerator(getConfig().hotkey)) {
        return { ok: false, message: `与全局唤起快捷键 ${getConfig().hotkey} 冲突` }
      }
      const holder = Object.keys(next).find(
        (pid) => pid !== pluginId && normalizeAccelerator(next[pid]) === norm
      )
      if (holder) {
        const name = getPlugin(holder)?.manifest.name ?? holder
        return { ok: false, message: `与「${name}」的快捷键冲突` }
      }
    }

    updateConfig({ pluginHotkeys: next })
    syncAllHotkeys()
    const error = pluginHotkeyErrors.get(pluginId)
    if (error) {
      updateConfig({ pluginHotkeys: sanitizeHotkeyMap(before) })
      syncAllHotkeys()
      return { ok: false, message: error }
    }
    return { ok: true, hotkey: acc }
  })

  ipcMain.handle('panel:get-config', () => (configView()))

  ipcMain.handle('panel:update-config', (_event, patch: Record<string, unknown>) => {
    let hotkeyResult: { ok: boolean; message?: string } = { ok: true }
    let hotkeyChanged = false
    const nextHotkey = typeof patch.hotkey === 'string' ? patch.hotkey.trim() : null
    if (nextHotkey !== null && nextHotkey !== getConfig().hotkey) {
      if (!nextHotkey) {
        // 空串 = 解绑：明确允许"不用全局快捷键"（只用托盘/面板入口），不查冲突直接清
        hotkeyResult = registerHotkey('')
        if (!hotkeyResult.ok) {
          return { ok: false, message: hotkeyResult.message, config: configView() }
        }
        // 写进配置的也是 trim 后的空串（下面 rest 里带的是原始值）
        patch = { ...patch, hotkey: '' }
        hotkeyChanged = true
      } else {
        // 先看是不是被某个插件的启动键占了：直接 register 也能失败，但会报成"被其他程序占用"，指向不明
        const holder = pluginHotkeyHolder(normalizeAccelerator(nextHotkey))
        if (holder) {
          return {
            ok: false,
            message: `与「${holder}」的插件快捷键冲突，请先在「插件快捷键」里改掉它`,
            config: configView()
          }
        }
        hotkeyResult = registerHotkey(nextHotkey)
        if (!hotkeyResult.ok) {
          return { ok: false, message: hotkeyResult.message, config: configView() }
        }
        patch = { ...patch, hotkey: nextHotkey }
        hotkeyChanged = true
      }
    }
    const { autostart, blurBehavior, pluginHotkeys, ...rest } = patch
    updateConfig(rest)
    if (typeof autostart === 'boolean') {
      updateConfig({ autostart })
      applyAutostart(autostart)
    }
    // 白名单：脏值写进配置会让 blur 分支永远落到默认，用户改了"没反应"却查不出原因
    if (isBlurBehavior(blurBehavior)) updateConfig({ blurBehavior })
    // 插件快捷键走单独的 IPC，这里只兜底接受整张表（同样洗一遍脏值）
    if (pluginHotkeys !== undefined) {
      updateConfig({ pluginHotkeys: sanitizeHotkeyMap(pluginHotkeys) })
      syncAllHotkeys()
    }
    // 唤起键变了 → 保留键集合变了，插件快捷键要重新判一次冲突
    if (hotkeyChanged) syncAllHotkeys()
    refreshTray()
    return { ok: true, config: configView() }
  })

  ipcMain.handle('panel:hide', () => {
    hidePanel()
    return true
  })

  // 渲染层浮层（详情/编辑/右键菜单）打开期间登记可见性：面板不会因为一次误移出焦点就收起。
  // token 由渲染层生成，关闭时原样传回；同一 token 重复登记/释放都是幂等的。
  ipcMain.handle('panel:hold-visible', (_event, token: unknown) => {
    if (typeof token !== 'string' || !token) return false
    holdPanelVisible(token)
    return true
  })
  ipcMain.handle('panel:release-visible', (_event, token: unknown) => {
    if (typeof token !== 'string' || !token) return false
    releasePanelVisible(token)
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
      // 自定义应用的启动配置以 shortcuts.json 为准，走"编辑表单"才不会两处配置打架
      if (rec.source === 'shortcut') return { ok: false, message: '自定义应用请在该应用的编辑表单里修改' }
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

    // 自定义应用的图标是异步补的（缓存已有的先出，缺的后填）
    warmShortcutIconsAsync(listShortcuts())

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
      syncAllHotkeys()
      getPanelWindow()?.webContents.send('panel:plugins-changed')
      console.log('[plugin] 开发期入口已更新')
    })

    // 插件目录监听：把插件目录丢进来、改了 plugin.json 都自动生效，不用重启
    // （打包版只监听用户安装目录——内置插件在安装目录里不会变）
    watchPluginDirs(() => {
      scanPlugins()
      refreshPluginRecords()
      refreshTray()
      syncAllHotkeys()
      getPanelWindow()?.webContents.send('panel:plugins-changed')
      console.log('[plugin] 插件目录已变化，已重扫')
    })

    // 唤起键和插件快捷键一起装上：两者共用一张注册表，分开注册容易互相抢键
    initHotkey(togglePanelWithHome)
    const results = syncAllHotkeys()
    const toggle = results.find((r) => r.owner === TOGGLE_OWNER)
    if (toggle && !toggle.ok && toggle.message) {
      new Notification({ title: 'QuickLauncher', body: toggle.message }).show()
    }
    // 插件键失败（多半被别的程序占了）不弹窗：开机连弹好几条太吵，设置页里有红字
    for (const [id, message] of pluginHotkeyErrors) console.warn(`[hotkey] ${id}: ${message}`)

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
