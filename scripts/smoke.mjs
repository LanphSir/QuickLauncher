// 功能冒烟测试：通过 CDP 驱动真实运行的 QuickLauncher
// 用法: 先启动 npx electron . --remote-debugging-port=9222，再运行 node scripts/smoke.mjs
import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CDP = 'http://127.0.0.1:9222'

async function targets() {
  const res = await fetch(`${CDP}/json/list`)
  if (!res.ok) throw new Error(`CDP HTTP ${res.status}`)
  return res.json()
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.onopen = () => resolve(ws)
    ws.onerror = (e) => reject(new Error('WS 连接失败'))
  })
}

let msgId = 0
function send(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    const onMsg = (event) => {
      const data = JSON.parse(event.data)
      if (data.id === id) {
        ws.removeEventListener('message', onMsg)
        data.error ? reject(new Error(JSON.stringify(data.error))) : resolve(data.result)
      }
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(ws, expression) {
  const { result, exceptionDetails } = await send(ws, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (exceptionDetails) throw new Error('页面执行出错: ' + JSON.stringify(exceptionDetails))
  return result.value
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

/**
 * 插件页判定：生产走自定义协议 plugin://<id>/index.html，
 * 用 pnpm dev:plugin 起了 dev server 时走 http://localhost:<port>/?__plugin=<id>，
 * 两种都要认，否则本地开着热更新时冒烟会全部找不到插件页。
 */
const isPluginPage = (target, name) =>
  target.url.startsWith(`plugin://com.launcher.${name}/`) ||
  target.url.includes(`__plugin=com.launcher.${name}`)

/** 在插件页里执行表达式（插件有独立 partition，页面不在主面板 WS 上） */
async function evaluateIn(name, expression) {
  const target = (await targets()).find((t) => isPluginPage(t, name))
  if (!target) throw new Error(`未找到插件页: ${name}`)
  const ws = await connect(target.webSocketDebuggerUrl)
  try {
    return await evaluate(ws, expression)
  } finally {
    ws.close()
  }
}

const list = await targets()
// 只能用主面板页面：插件页同为 index.html，且没有 window.panel
const page =
  list.find((t) => t.type === 'page' && t.url.includes('out/renderer/index.html')) ??
  list.find(
    (t) => t.type === 'page' && t.url.includes('localhost') && !t.url.includes('/plugins/') && !t.url.includes('__plugin=')
  )
if (!page) {
  console.error('未找到主面板页面，targets:', list.map((t) => `${t.type}:${t.url}`).join('\n'))
  process.exit(1)
}

const ws = await connect(page.webSocketDebuggerUrl)
await send(ws, 'Runtime.enable')

// 0. 复位到主页：上一次跑完可能停在某个插件页（此时主页 UI 已卸载，搜索框不存在，
//    后续 setter 会报 Illegal invocation）。冒烟应可从任意状态重跑。
await evaluate(ws, 'window.panel.exitPlugin()')
await new Promise((r) => setTimeout(r, 400))
// 设置页/全部应用页同理：它们是 store.view，不是插件视图，exitPlugin 不会退出来
const backHome = await evaluate(
  ws,
  `(() => {
    if (!document.querySelector('.settings, .manage')) return 'already-home'
    const back = document.querySelector('.settings-header .back, .manage .back')
    if (!back) return 'no-back'
    back.click()
    return 'clicked'
  })()`
)
if (backHome === 'clicked') await new Promise((r) => setTimeout(r, 400))

// 1. 面板桥存在
const hasBridge = await evaluate(ws, 'typeof window.panel === "object" && typeof window.panel.openPlugin === "function"')
check('主面板 preload 桥注入', hasBridge === true)

// 2. 插件列表
const plugins = await evaluate(ws, 'window.panel.getPlugins().then(l => l.map(p => ({id: p.id, type: p.type, icon: !!p.icon})))')
const ids = plugins.map((p) => p.id)
check(
  '插件扫描注册',
  ['com.launcher.clipboard', 'com.launcher.calculator', 'com.launcher.notepad', 'com.launcher.translator', 'com.launcher.handbook'].every((id) => ids.includes(id)),
  ids.join(', ')
)
check('插件图标 dataURL 化', plugins.every((p) => p.icon))

// 3. 配置读取（快捷键可能被用户改过，只验证格式合法：空 = 主动解绑，或至少一个修饰键 + 主键）
const cfg = await evaluate(ws, 'window.panel.getConfig().then(c => c.hotkey)')
check(
  '全局配置读取(快捷键格式合法)',
  typeof cfg === 'string' && (cfg === '' || /^[A-Za-z0-9]+(\+[A-Za-z0-9]+)+$/.test(cfg)),
  cfg === '' ? '(未绑定)' : String(cfg)
)

// 3.5 通配/正则关键词：英文输入应命中快速翻译（re: 正则）
await evaluate(ws, `(() => {
  const input = document.querySelector('.search')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, 'hello world')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await new Promise((r) => setTimeout(r, 400))
const searched = await evaluate(ws, 'Array.from(document.querySelectorAll(".tile-label")).map(e => e.textContent)')
check('re: 正则关键词命中(英文输入→翻译)', searched.some((t) => t?.includes('快速翻译')), searched.join(' / '))
await evaluate(ws, `(() => {
  const input = document.querySelector('.search')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, '')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)

// 3b. 浮层（弹窗/菜单）：统一宿主、只关栈顶、焦点不外逃
// 先清掉上一轮或手动调试留下的浮层，否则下面数层数会从 1 起步直接判失败
for (let i = 0; i < 5; i++) {
  if ((await evaluate(ws, `document.querySelectorAll('[data-overlay-id]').length`)) === 0) break
  await evaluate(ws, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await new Promise((r) => setTimeout(r, 200))
}
await evaluate(ws, `(() => {
  const tile = document.querySelector('.tile')
  const r = tile.getBoundingClientRect()
  tile.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 20, clientY: r.y + 20 }))
  return true
})()`)
await new Promise((r) => setTimeout(r, 300))
const menuLayers = await evaluate(ws, `Array.from(document.querySelectorAll('[data-overlay-id]')).map(e => e.dataset.overlay)`)
check('右键菜单经统一浮层渲染', menuLayers.length === 1 && menuLayers[0] === 'context-menu', menuLayers.join(','))

await evaluate(ws, `(() => {
  const item = Array.from(document.querySelectorAll('.ctx-item')).find((e) => e.textContent.includes('应用详情'))
  if (!item) return false
  item.click()
  return true
})()`)
await new Promise((r) => setTimeout(r, 400))
const detailLayers = await evaluate(ws, `Array.from(document.querySelectorAll('[data-overlay-id]')).map(e => e.dataset.overlay)`)
check(
  '菜单→详情只留一层（不是叠两层）',
  detailLayers.length === 1 && detailLayers[0] === 'plugin-detail',
  detailLayers.join(',')
)
check(
  '详情浮层打开后焦点进浮层',
  (await evaluate(ws, `!!document.querySelector('[data-overlay-id]')?.contains(document.activeElement)`)) === true
)

// 遮罩必须压在内容下面：遮罩是 absolute，弹窗是静态定位，不显式分层就会把弹窗整个盖住
// （表现是弹窗灰蒙蒙一层、点哪都触发"点外面关闭"，输入框根本点不进去）
const layerHit = await evaluate(
  ws,
  `(() => {
    const modal = document.querySelector('[data-overlay-id] .modal')
    if (!modal) return { ok: false, top: 'no modal' }
    const r = modal.getBoundingClientRect()
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + 12)
    return { ok: !!el && modal.contains(el), top: el ? (el.className || el.tagName) : '' }
  })()`
)
check('遮罩不遮挡弹窗内容', layerHit.ok === true, String(layerHit.top))

// Tab 必须困在浮层里：第一版没做，Tab 会跑到遮罩下面的磁贴上
for (let i = 0; i < 8; i++) {
  await send(ws, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Tab',
    code: 'Tab',
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 9
  })
  await send(ws, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Tab',
    code: 'Tab',
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 9
  })
}
check(
  'Tab 焦点困在浮层内',
  (await evaluate(ws, `!!document.querySelector('[data-overlay-id]')?.contains(document.activeElement)`)) === true
)

await evaluate(ws, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
await new Promise((r) => setTimeout(r, 350))
check(
  'Esc 关闭浮层（回到主页而不是隐藏面板）',
  (await evaluate(ws, `document.querySelectorAll('[data-overlay-id]').length`)) === 0 &&
    (await evaluate(ws, 'document.visibilityState')) === 'visible'
)

// 失焦策略走配置链路：能改、能读回、脏值被拒
const blurBefore = await evaluate(ws, 'window.panel.getConfig().then((c) => c.blurBehavior)')
const blurSet = await evaluate(ws, `window.panel.updateConfig({ blurBehavior: 'never' }).then((r) => r.config.blurBehavior)`)
const blurBad = await evaluate(ws, `window.panel.updateConfig({ blurBehavior: 'later' }).then((r) => r.config.blurBehavior)`)
await evaluate(ws, `window.panel.updateConfig({ blurBehavior: ${JSON.stringify(blurBefore)} })`)
check(
  '失焦策略可配置且拒绝脏值',
  Boolean(blurBefore) && blurSet === 'never' && blurBad === 'never',
  `${blurBefore} -> ${blurSet} / 脏值后 ${blurBad}`
)

// 设置页分组侧栏：卡片多了以后靠侧栏切换，不用一路滚着找
await evaluate(ws, `document.querySelector('button[title="设置"]').click()`)
await new Promise((r) => setTimeout(r, 500))
const navCount = await evaluate(ws, `document.querySelectorAll('.settings-nav .nav-item').length`)
const navActive = await evaluate(ws, `document.querySelector('.nav-item.active')?.textContent?.trim() ?? ''`)
await evaluate(
  ws,
  `Array.from(document.querySelectorAll('.nav-item')).find((e) => e.textContent.includes('应用'))?.click()`
)
await new Promise((r) => setTimeout(r, 260))
const appCard = await evaluate(ws, `!!document.querySelector('.settings-body .card-head')`)
await evaluate(ws, `document.querySelector('.settings-header .back')?.click()`)
await new Promise((r) => setTimeout(r, 360))
check(
  '设置页有分组侧栏且可切换',
  navCount === 4 && navActive.includes('快捷键') && appCard === true,
  `${navCount} 项 / 默认 ${navActive}`
)

// 快捷键解绑：允许"不用全局快捷键"，清掉后要能干净读回空串（不能报注册失败又把旧键接回去）
let toggleBefore = await evaluate(ws, 'window.panel.getConfig().then((c) => c.hotkey)')
if (!toggleBefore) {
  await evaluate(ws, 'window.panel.getConfig().then((c) => window.panel.updateConfig({ hotkey: c.defaultHotkey }))')
  toggleBefore = await evaluate(ws, 'window.panel.getConfig().then((c) => c.hotkey)')
}
const toggleCleared = await evaluate(
  ws,
  `window.panel.updateConfig({ hotkey: '' }).then((r) => ({ ok: r.ok, hotkey: r.config.hotkey, msg: r.message || '' }))`
)
const toggleRestored = await evaluate(
  ws,
  `window.panel.updateConfig({ hotkey: ${JSON.stringify(toggleBefore)} }).then((r) => ({ ok: r.ok, hotkey: r.config.hotkey }))`
)
check(
  '唤起快捷键可解绑并能恢复',
  toggleCleared.ok === true &&
    toggleCleared.hotkey === '' &&
    toggleRestored.ok === true &&
    toggleRestored.hotkey === toggleBefore,
  `${toggleBefore} -> '' -> ${toggleRestored.hotkey}`
)

// 3c. 插件快捷启动键：建议值只作提示、能设能清、冲突拒绝
const suggest = await evaluate(
  ws,
  `window.panel.getPlugins().then(l => l.find(p => p.id === 'com.launcher.clipboard')?.hotkeySuggestion ?? null)`
)
check('插件可声明建议快捷键(仅提示)', suggest === 'Alt+Shift+V', String(suggest))

const hkKey = 'Ctrl+Alt+Shift+F9'
const hkSet = await evaluate(
  ws,
  `window.panel.setPluginHotkey('com.launcher.calculator', ${JSON.stringify(hkKey)}).then(r => r)`
)
const hkStored = await evaluate(
  ws,
  `window.panel.getPlugins().then(l => { const p = l.find(x => x.id === 'com.launcher.calculator'); return { hotkey: p?.hotkey, error: p?.hotkeyError ?? null } })`
)
check(
  '插件快捷键设置并落配置',
  hkSet?.ok === true && hkStored.hotkey === hkKey && !hkStored.error,
  `${JSON.stringify(hkSet)} / ${JSON.stringify(hkStored)}`
)

const dup = await evaluate(
  ws,
  `window.panel.setPluginHotkey('com.launcher.clipboard', ${JSON.stringify(hkKey)}).then(r => r)`
)
check('两个插件抢同一个键被拒', dup?.ok === false && String(dup.message).includes('冲突'), String(dup?.message))

const globalCfg = await evaluate(ws, 'window.panel.getConfig().then(c => c.hotkey)')
const vsGlobal = await evaluate(
  ws,
  `window.panel.setPluginHotkey('com.launcher.clipboard', ${JSON.stringify(globalCfg)}).then(r => r)`
)
check(
  '插件快捷键不能占用唤起键',
  vsGlobal?.ok === false && String(vsGlobal.message).includes('全局'),
  String(vsGlobal?.message)
)

const noMod = await evaluate(
  ws,
  `window.panel.setPluginHotkey('com.launcher.clipboard', 'K').then(r => r)`
)
check('单键被拒(需修饰键)', noMod?.ok === false, String(noMod?.message))

const hkCleared = await evaluate(
  ws,
  `window.panel.setPluginHotkey('com.launcher.calculator', '').then(r => r.ok).then(ok => window.panel.getPlugins().then(l => ({ ok, hotkey: l.find(x => x.id === 'com.launcher.calculator')?.hotkey })))`
)
check('插件快捷键可清除', hkCleared.ok === true && hkCleared.hotkey === '', JSON.stringify(hkCleared))

// 3d. 自定义外部应用：保存 → 进插件表（带系统图标）→ 校验 → 启动 → 导入候选 → 清理
const scSaved = await evaluate(
  ws,
  `window.panel.saveShortcut({ name: '冒烟应用', command: 'C:/Windows/System32/cmd.exe', args: '/c exit', keywords: 'smoke 冒烟' }).then(r => ({ ok: r.ok, id: r.entry?.id, message: r.message }))`
)
check(
  '自定义应用可保存并生成 id',
  scSaved?.ok === true && /^com\.launcher\.shortcut\./.test(String(scSaved.id)),
  JSON.stringify(scSaved)
)
// 图标是异步补的（getFileIcon），等它落到插件表里
await new Promise((r) => setTimeout(r, 1200))
const scList = await evaluate(
  ws,
  `window.panel.getPlugins().then(l => l.filter(p => p.source === 'shortcut').map(p => ({ id: p.id, name: p.name, type: p.type, icon: !!p.icon })))`
)
check(
  '自定义应用进入插件表(含系统图标)',
  scList.some((p) => p.id === scSaved?.id && p.type === 'external' && p.icon),
  JSON.stringify(scList)
)

const scBad = await evaluate(ws, `window.panel.saveShortcut({ name: '  ', command: 'x.exe' }).then(r => r)`)
check('名称为空被拒', scBad?.ok === false, String(scBad?.message))

const scLaunch = await evaluate(ws, `window.panel.openPlugin(${JSON.stringify(scSaved?.id)}).then(r => r)`)
check('自定义应用可启动(external 直接拉起)', scLaunch?.ok === true, JSON.stringify(scLaunch))

const cands = await evaluate(ws, `window.panel.scanShortcutCandidates()`)
check(
  '开始菜单/桌面候选可扫描',
  Array.isArray(cands) && cands.every((c) => c.path && c.name && c.group),
  `${cands?.length ?? 0} 个候选`
)

const imported = await evaluate(
  ws,
  `window.panel.importShortcuts([{ path: 'C:/Windows/System32/cmd.exe', name: '冒烟导入项' }]).then(r => r)`
)
check('批量导入可用', imported?.ok === true && imported.created === 1, JSON.stringify(imported))

// 清理：删掉本轮造的条目（删除会同时清 pin/快捷键等引用）
const cleaned = await evaluate(
  ws,
  `(async () => {
    const list = await window.panel.getShortcuts()
    const mine = list.filter((x) => x.name.startsWith('冒烟'))
    for (const item of mine) await window.panel.deleteShortcut(item.id)
    const after = await window.panel.getPlugins()
    return { removed: mine.length, left: after.filter((p) => p.source === 'shortcut' && p.name.startsWith('冒烟')).length }
  })()`
)
check(
  '自定义应用可删除并立即下架',
  cleaned.removed === 2 && cleaned.left === 0,
  JSON.stringify(cleaned)
)

// 4. 打开 web 插件 → 出现独立插件进程页面
const homeBounds = await evaluate(ws, 'window.panel.getWindowBounds()')
await evaluate(ws, 'window.panel.openPlugin("com.launcher.clipboard")')
await new Promise((r) => setTimeout(r, 2000))
const list2 = await targets()
const pluginPage = list2.find((t) => isPluginPage(t, 'clipboard'))
check('web 插件视图加载(独立进程)', !!pluginPage, pluginPage?.url ?? '未找到')

// 4b. 插件页外框：窗口自动伸展 + 提供返回主界面
const pluginBounds = await evaluate(ws, 'window.panel.getWindowBounds()')
check(
  '插件页自动伸展窗口',
  pluginBounds.width >= homeBounds.width && pluginBounds.height >= homeBounds.height && pluginBounds.width >= 900,
  `${homeBounds.width}x${homeBounds.height} -> ${pluginBounds.width}x${pluginBounds.height}`
)
check(
  '插件页外框(返回主界面)',
  (await evaluate(ws, 'document.querySelector(".frame .back")?.textContent?.includes("主界面")')) === true
)

// 4c. 插件页要"端在屏幕正中"：窗口中心与工作区中心对齐（125% 缩放取整，允许几像素误差）
const offset = await evaluate(
  ws,
  `(async () => {
    const b = await window.panel.getWindowBounds()
    const s = window.screen
    return {
      dx: Math.round(Math.abs(b.x + b.width / 2 - (s.availLeft + s.availWidth / 2))),
      dy: Math.round(Math.abs(b.y + b.height / 2 - (s.availTop + s.availHeight / 2)))
    }
  })()`
)
check('插件页窗口居中于屏幕', offset.dx <= 6 && offset.dy <= 6, `偏移 ${offset.dx}px / ${offset.dy}px`)

// 5. 插件内 appapi 可用 + storage 隔离
if (pluginPage) {
  const pws = await connect(pluginPage.webSocketDebuggerUrl)
  await send(pws, 'Runtime.enable')
  const apiOk = await evaluate(pws, 'typeof window.appapi === "object" && typeof window.appapi.storage.get === "function"')
  check('插件 preload 桥注入', apiOk === true)
  await evaluate(pws, 'window.appapi.storage.set("smoke", "hello-" + Date.now())')
  const stored = await evaluate(pws, 'window.appapi.storage.get("smoke")')
  check('插件 storage 读写', typeof stored === 'string' && stored.startsWith('hello-'), String(stored))
  const info = await evaluate(pws, 'window.appapi.info()')
  check('插件身份信息', info?.id === 'com.launcher.clipboard', JSON.stringify(info))

  // 5b. 协议与分区隔离：插件页有自己的 origin，同源可 fetch，跨插件与越界都被拦
  const origin = await evaluate(pws, 'location.origin')
  check('插件页 origin 为 plugin://<id>', String(origin).startsWith('plugin://com.launcher.clipboard'), String(origin))
  const ls = await evaluate(
    pws,
    `(() => { try { localStorage.setItem('smokeOrigin', 'clipboard'); return localStorage.getItem('smokeOrigin') } catch (e) { return 'ERR:' + e.message } })()`
  )
  check('插件页 localStorage 可用', ls === 'clipboard', String(ls))
  const sameOrigin = await evaluate(
    pws,
    `fetch('plugin.json').then(r => r.ok ? r.json() : { id: 'HTTP ' + r.status }).then(j => j.id).catch(e => 'ERR:' + e.message)`
  )
  check('plugin:// 下同源 fetch 本地资源', sameOrigin === 'com.launcher.clipboard', String(sameOrigin))
  const cross = await evaluate(
    pws,
    `fetch('plugin://com.launcher.calculator/index.html').then(() => 'ALLOWED').catch(() => 'BLOCKED')`
  )
  check('跨插件资源读取被拦(CORS)', cross === 'BLOCKED', String(cross))
  const escape = await evaluate(pws, `fetch('..%2f..%2fpackage.json').then(r => r.status).catch(() => 'THREW')`)
  check('路径越界被拒', escape === 403 || escape === 'THREW', String(escape))
  // 点外框的"主界面"：插件视图摘掉、主页回来、窗口缩回原尺寸
  await evaluate(ws, '(() => { document.querySelector(".frame .back")?.click(); return true })()')
  await new Promise((r) => setTimeout(r, 700))
  check(
    '外框返回主界面',
    (await evaluate(ws, '!document.querySelector(".frame")')) === true &&
      (await evaluate(ws, '!!document.querySelector(".search")')) === true
  )
  const backBounds = await evaluate(ws, 'window.panel.getWindowBounds()')
  check(
    '返回主页还原窗口尺寸',
    Math.abs(backBounds.width - homeBounds.width) <= 2 && Math.abs(backBounds.height - homeBounds.height) <= 2,
    `${backBounds.width}x${backBounds.height}`
  )
}

// 6. 搜索贡献：插件注册的条目在面板可搜（静态索引兜底）+ intent 直达
const linuxHits = await evaluate(ws, 'window.panel.search("linux")')
check(
  '搜索贡献命中手册条目',
  Array.isArray(linuxHits) && linuxHits.some((h) => h.pluginId === 'com.launcher.handbook'),
  JSON.stringify(linuxHits?.map((h) => h.title))
)
check(
  '手册级条目排在章节之前(weight)',
  Array.isArray(linuxHits) && linuxHits.length > 0 && linuxHits[0].id.startsWith('manual:'),
  linuxHits?.[0]?.id
)

// 7. 手册插件：静态手册打包 + docs 权限通道
await evaluate(ws, 'window.panel.openPlugin("com.launcher.handbook", undefined, { manualId: "linux-command" })')
// 等页面真正渲染：dev server 失效时主进程会先打开错误页、再回退到 dist，
// 固定 sleep 会在这个窗口期读到空 DOM（假失败）。
const hbPage = await (async () => {
  for (let i = 0; i < 14; i++) {
    const page = (await targets()).find((t) => isPluginPage(t, 'handbook'))
    if (page) {
      try {
        const probe = await connect(page.webSocketDebuggerUrl)
        await send(probe, 'Runtime.enable')
        if (await evaluate(probe, '!!document.querySelector(".side-title")')) return page
        probe.close()
      } catch {
        /* 页面正在切换，下一轮 */
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return null
})()
check('手册插件加载(独立进程)', !!hbPage, hbPage?.url ?? '未找到')
if (hbPage) {
  const hws = await connect(hbPage.webSocketDebuggerUrl)
  await send(hws, 'Runtime.enable')
  const landed = await evaluate(hws, 'document.querySelector(".side-title")?.textContent?.trim() ?? ""')
  check('搜索条目 intent 直达手册', landed.includes('Linux'), landed)
  // 插件会记住上次阅读位置/管理模式/搜索词，先归位到"手册列表"再断言，避免依赖历史状态
  for (let i = 0; i < 3; i++) {
    await evaluate(hws, `(() => {
      const done = Array.from(document.querySelectorAll('.ghost')).find((b) => b.textContent.includes('完成'))
      if (done) done.click()
      document.querySelectorAll('.side-back').forEach((b) => b.click())
      const input = document.querySelector('.search')
      if (input && input.value) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, '')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
      return true
    })()`)
    await new Promise((r) => setTimeout(r, 250))
    if (await evaluate(hws, 'document.querySelectorAll(".m-item").length') > 0) break
  }
  const manualCount = await evaluate(hws, 'document.querySelectorAll(".m-item").length')
  check('手册列表渲染(构建期打包的手册数)', manualCount >= 2, `手册 ${manualCount} 本`)
  // 打开第一本手册的第一章，确认 markdown 渲染出块
  await evaluate(hws, '(() => { document.querySelector(".m-item")?.click(); return true })()')
  await new Promise((r) => setTimeout(r, 400))
  await evaluate(hws, '(() => { document.querySelector(".ch-row")?.click(); return true })()')
  await new Promise((r) => setTimeout(r, 600))
  const blockCount = await evaluate(hws, 'document.querySelectorAll(".article > *").length')
  check('章节正文渲染(markdown 块)', blockCount > 3, `${blockCount} 个块`)
  const docsList = await evaluate(hws, 'window.appapi.docs.list().then(l => Array.isArray(l))')
  check('docs 通道可用(需 docs 权限)', docsList === true)
  // 插件视图矩形 = 窗口 - 顶栏(46) - 四周留白(8×2)，两边尺寸必须对得上
  const hbBounds = await evaluate(ws, 'window.panel.getWindowBounds()')
  const viewport = JSON.parse(await evaluate(hws, 'JSON.stringify({ w: innerWidth, h: innerHeight })'))
  check(
    '插件视图避让外框(工具条+边距)',
    Math.abs(viewport.w - (hbBounds.width - 16)) <= 2 && Math.abs(viewport.h - (hbBounds.height - 54)) <= 2,
    `视图 ${viewport.w}x${viewport.h} / 窗口 ${hbBounds.width}x${hbBounds.height}`
  )
  send(hws, 'Runtime.evaluate', { expression: 'window.appapi.exit()' }).catch(() => {})
  await new Promise((r) => setTimeout(r, 500))
}

// 6.5 网络能力 + 生命周期：临时探针插件（声明 net + hosts:[127.0.0.1]）由本地 HTTP 服务回话
const PROBE_ID = 'com.smoke.probe-net'
const PROBE_DIR = join(process.cwd(), 'plugins', 'probe-net')
const PROBE_URL_PREFIX = `plugin://${PROBE_ID}/`
rmSync(PROBE_DIR, { recursive: true, force: true }) // 上一轮被强杀时的残留

const server = createServer((req, res) => {
  if (req.url === '/redirect-out') {
    res.writeHead(302, { location: 'https://example.com/' })
    res.end()
    return
  }
  if (req.url === '/redirect-ok') {
    res.writeHead(302, { location: '/ok' })
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, path: req.url }))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const probePort = server.address().port

mkdirSync(PROBE_DIR, { recursive: true })
writeFileSync(
  join(PROBE_DIR, 'plugin.json'),
  JSON.stringify(
    {
      id: PROBE_ID,
      name: '冒烟探针',
      version: '0.0.0',
      type: 'web',
      entry: 'index.html',
      keywords: ['smoke-probe'],
      permissions: ['net'],
      hosts: ['127.0.0.1']
    },
    null,
    2
  )
)
// 探针页只做两件事：记录可见性事件、供 CDP 调用 appapi
writeFileSync(
  join(PROBE_DIR, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>probe</title><body>probe
<script>
  window.__life = { show: 0, hide: 0 }
  window.appapi.onShow(() => { window.__life.show++ })
  window.appapi.onHide(() => { window.__life.hide++ })
</script></body>`
)
// 强制重扫：借"停用/启用"这条已有链路的副作用（它内部会 scanPlugins），无需为冒烟加调试接口
await evaluate(ws, 'window.panel.setPluginDisabled("com.launcher.notepad", true)')
await evaluate(ws, 'window.panel.setPluginDisabled("com.launcher.notepad", false)')
const probeListed = await evaluate(ws, `window.panel.getPlugins().then(l => l.some(p => p.id === "${PROBE_ID}"))`)
check('临时探针插件可被扫描(无需重启)', probeListed === true)

let probeOk = false
try {
  await evaluate(ws, `window.panel.openPlugin("${PROBE_ID}")`)
  const probePage = await (async () => {
    for (let i = 0; i < 20; i++) {
      const t = (await targets()).find((x) => x.url.startsWith(PROBE_URL_PREFIX))
      if (t) return t
      await new Promise((r) => setTimeout(r, 300))
    }
    return null
  })()
  check('探针插件页加载', !!probePage, probePage?.url ?? '未找到')
  if (probePage) {
    probeOk = true
    const pws = await connect(probePage.webSocketDebuggerUrl)
    await send(pws, 'Runtime.enable')
    const call = (expr) => evaluate(pws, expr)

    const okRes = JSON.parse(
      await call(`window.appapi.net.request({ url: 'http://127.0.0.1:${probePort}/ok' })
        .then(r => JSON.stringify({ status: r.status, body: r.body }))
        .catch(e => JSON.stringify({ error: String(e.message || e) }))`)
    )
    check('net 请求成功(主进程转发)', okRes.status === 200 && okRes.body.includes('"ok":true'), JSON.stringify(okRes))

    const postRes = JSON.parse(
      await call(`window.appapi.net.request({ url: 'http://127.0.0.1:${probePort}/echo', method: 'post', headers: { 'x-probe': 'yes' } })
        .then(r => JSON.stringify({ status: r.status, path: JSON.parse(r.body).path }))
        .catch(e => JSON.stringify({ error: String(e.message || e) }))`)
    )
    check('net 方法大小写归一(POST)', postRes.status === 200 && postRes.path === '/echo', JSON.stringify(postRes))

    const outside = await call(`window.appapi.net.request({ url: 'http://127.0.0.2:${probePort}/ok' })
      .then(() => 'ALLOWED').catch(e => String(e.message || e))`)
    check('net 白名单外的域被拒', String(outside).includes('白名单'), String(outside).slice(0, 90))

    const scheme = await call(`window.appapi.net.request({ url: 'file:///etc/passwd' })
      .then(() => 'ALLOWED').catch(e => String(e.message || e))`)
    check('net 拒绝非 http(s)', String(scheme).includes('仅允许 http(s)'), String(scheme).slice(0, 90))

    const redirectOut = await call(`window.appapi.net.request({ url: 'http://127.0.0.1:${probePort}/redirect-out' })
      .then(() => 'ALLOWED').catch(e => String(e.message || e))`)
    check('net 重定向跨域被逐跳拦截', String(redirectOut).includes('白名单'), String(redirectOut).slice(0, 90))

    const redirectOk = JSON.parse(
      await call(`window.appapi.net.request({ url: 'http://127.0.0.1:${probePort}/redirect-ok' })
        .then(r => JSON.stringify({ status: r.status, url: r.url }))
        .catch(e => JSON.stringify({ error: String(e.message || e) }))`)
    )
    check('net 同域重定向自动跟随', redirectOk.status === 200 && String(redirectOk.url).endsWith('/ok'), JSON.stringify(redirectOk))

    // 功能门禁：探针没声明 features:["inline"]，回传内联结果必须被拒
    const inlineDenied = await call(`window.appapi.inline.set({ seq: 1, items: [] })
      .then(() => 'ALLOWED').catch(e => String(e.message || e))`)
    check('内联结果需 features 声明', String(inlineDenied).includes('功能声明'), String(inlineDenied).slice(0, 90))

    // 生命周期：加载即 show=1；退出面板 → hide=1；再进来 → show=2
    const life0 = JSON.parse(await call('JSON.stringify(window.__life)'))
    check('插件加载即收到 onShow', life0.show === 1 && life0.hide === 0, JSON.stringify(life0))
    await evaluate(ws, 'window.panel.exitPlugin()')
    await new Promise((r) => setTimeout(r, 600))
    const life1 = JSON.parse(await call('JSON.stringify(window.__life)'))
    check('退出插件页收到 onHide', life1.hide === 1, JSON.stringify(life1))
    await evaluate(ws, `window.panel.openPlugin("${PROBE_ID}")`)
    await new Promise((r) => setTimeout(r, 800))
    const life2 = JSON.parse(await call('JSON.stringify(window.__life)'))
    check('重新打开收到 onShow', life2.show === 2 && life2.hide === 1, JSON.stringify(life2))
    await evaluate(ws, 'window.panel.exitPlugin()')
    await new Promise((r) => setTimeout(r, 300))
    pws.close()
  }
} finally {
  server.close()
  rmSync(PROBE_DIR, { recursive: true, force: true })
  // 再次重扫，让探针从插件表消失（保持在 finally 里，断言失败也不留垃圾）
  await evaluate(ws, 'window.panel.setPluginDisabled("com.launcher.notepad", true)').catch(() => {})
  await evaluate(ws, 'window.panel.setPluginDisabled("com.launcher.notepad", false)').catch(() => {})
}
if (!probeOk) check('net/lifecycle 探针未运行', false, '探针插件未加载，后续断言跳过')

// 6.6 内联结果：声明 features:["inline"] 的计算器在后台接查询，输入算式直接出结果
const inlineProbe = async (q) =>
  JSON.parse(await evaluate(ws, `window.panel.inline(${JSON.stringify(q)}).then((r) => JSON.stringify(r))`))

/** 首次查询会顺手把插件视图拉起来（页面还在加载时本轮返回空），所以轮询几次 */
let inlineHit = null
for (let i = 0; i < 20; i++) {
  const hits = await inlineProbe('2+3')
  if (hits.length) {
    inlineHit = hits[0]
    break
  }
  await new Promise((r) => setTimeout(r, 300))
}
check(
  '内联结果(2+3 → 5)',
  inlineHit?.title === '5' && inlineHit?.pluginId === 'com.launcher.calculator',
  JSON.stringify(inlineHit)
)
check(
  '内联结果默认动作来自插件(copy)',
  inlineHit?.action?.type === 'copy' && inlineHit.action.text === '5',
  JSON.stringify(inlineHit?.action)
)
const inlineNone = await inlineProbe('hello')
check('非算式不产生内联结果', inlineNone.length === 0, JSON.stringify(inlineNone))
check(
  '内联插件在后台预热(未打开也加载)',
  (await targets()).some((t) => isPluginPage(t, 'calculator'))
)

// 面板里的真实链路：输入 → 防抖 140ms → 内联 120ms → 渲染 → 回车复制
await evaluate(ws, `(() => {
  const input = document.querySelector('.search')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, '7*8')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await new Promise((r) => setTimeout(r, 800))
const inlineRows = await evaluate(ws, `document.querySelectorAll('.hit-entry.inline').length`)
const inlineTitle = await evaluate(ws, `document.querySelector('.hit-entry.inline .hit-title')?.textContent ?? ''`)
check('面板渲染内联结果行', inlineRows >= 1 && inlineTitle === '56', `${inlineRows} 行 / ${inlineTitle}`)
await evaluate(
  ws,
  `document.querySelector('.search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`
)
await new Promise((r) => setTimeout(r, 400))
const toast = await evaluate(ws, `document.querySelector('.n-message')?.textContent ?? ''`)
check('回车执行内联动作(复制)', toast.includes('已复制') && toast.includes('56'), toast)
// 复位搜索框：后续断言依赖主页默认状态
await evaluate(ws, `(() => {
  const input = document.querySelector('.search')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, '')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await new Promise((r) => setTimeout(r, 300))

// 7. 窗口管理：置顶钉住
const pinOn = await evaluate(ws, 'window.panel.togglePinned()')
const pinOff = await evaluate(ws, 'window.panel.togglePinned()')
check('窗口置顶钉住切换', pinOn?.pinned === true && pinOff?.pinned === false, JSON.stringify(pinOn))

// 8. 窗口管理：自实现缩放（setWindowBounds）
const bounds0 = await evaluate(ws, 'window.panel.getWindowBounds()')
await evaluate(ws, `window.panel.setWindowBounds({ x: ${bounds0.x}, y: ${bounds0.y}, width: ${bounds0.width + 120}, height: ${bounds0.height} })`)
await new Promise((r) => setTimeout(r, 400))
const bounds1 = await evaluate(ws, 'window.panel.getWindowBounds()')
check(
  '窗口缩放(setWindowBounds)',
  // 缩放比例非整数（如 125%）时 Electron 会对 bounds 取整，允许 ±2 误差
  Math.abs(bounds1.width - (bounds0.width + 120)) <= 2,
  `${bounds0.width} -> ${bounds1.width}`
)
await evaluate(ws, `window.panel.setWindowBounds({ x: ${bounds0.x}, y: ${bounds0.y}, width: ${bounds0.width}, height: ${bounds0.height} })`)
check('缩放热区渲染(8 个)', await evaluate(ws, 'document.querySelectorAll(".rz").length') === 8)
check('置顶按钮渲染', await evaluate(ws, '!!document.querySelector(".search-row .icon-btn")'))

// 9. 插件分离为独立窗口（状态保留 + 任务栏可见）+ 退出即关窗
const det = await evaluate(ws, 'window.panel.detachPlugin("com.launcher.calculator")')
await new Promise((r) => setTimeout(r, 1200))
const afterDetach = await targets()
const calcStill = afterDetach.some((t) => isPluginPage(t, 'calculator'))
check('分离为独立窗口', det?.ok === true && calcStill, JSON.stringify(det))
const det2 = await evaluate(ws, 'window.panel.detachPlugin("com.launcher.calculator")')
check('重复分离=聚焦已有窗口', det2?.ok === true)

// 10. 未声明权限的插件调用被拒（calculator 无 clipboard 权限）
await evaluate(ws, 'window.panel.openPlugin("com.launcher.calculator")')
await new Promise((r) => setTimeout(r, 1500))
const list3 = await targets()
const calcPage = list3.find((t) => isPluginPage(t, 'calculator'))
if (calcPage) {
  const cws = await connect(calcPage.webSocketDebuggerUrl)
  await send(cws, 'Runtime.enable')
  const denied = await evaluate(cws, 'window.appapi.clipboard.readText().then(() => "leak").catch(e => String(e).includes("clipboard") ? "denied" : "other")')
  check('权限模型生效(未声明即拒绝)', denied === 'denied', String(denied))
  const docsDenied = await evaluate(cws, 'window.appapi.docs.list().then(() => "leak").catch(e => String(e).includes("docs") ? "denied" : "other")')
  check('docs 权限未声明即拒绝', docsDenied === 'denied', String(docsDenied))
  const netDenied = await evaluate(
    cws,
    'window.appapi.net.request({ url: "https://example.com/" }).then(() => "leak").catch(e => String(e).includes("net") ? "denied" : "other")'
  )
  check('net 权限未声明即拒绝', netDenied === 'denied', String(netDenied))
  // 已分离窗口内退出 → 窗口关闭、视图销毁
  send(cws, 'Runtime.evaluate', { expression: 'window.appapi.exit()' }).catch(() => {})
  await new Promise((r) => setTimeout(r, 1500))
  const afterExit = await targets()
  check('分离窗口内退出即关窗', !afterExit.some((t) => isPluginPage(t, 'calculator')))
} else {
  check('权限模型生效(未声明即拒绝)', false, 'calculator 页面未找到')
  check('分离窗口内退出即关窗', false, 'calculator 页面未找到')
}

// 11. 冷启动路径：视图已被销毁（上一段退出即关窗）后只敲一次，结果要自己补上来
await evaluate(ws, `(() => {
  const input = document.querySelector('.search')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, '8*8')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
let coldTitle = ''
for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 300))
  coldTitle = await evaluate(ws, `document.querySelector('.hit-entry.inline .hit-title')?.textContent ?? ''`)
  if (coldTitle === '64') break
}
check('插件页冷启动后单次输入自动补结果', coldTitle === '64', coldTitle || '(无)')
await evaluate(ws, `(() => {
  const input = document.querySelector('.search')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, '')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await new Promise((r) => setTimeout(r, 300))

// 12. 插件目录监听 + 视图 LRU + 存储配额：一次建 7 个临时探针，把常驻上限顶满
const LRU_IDS = Array.from({ length: 7 }, (_, i) => `com.smoke.lru${i + 1}`)
const LRU_DIRS = LRU_IDS.map((_, i) => join(process.cwd(), 'plugins', `lru-probe-${i + 1}`))
const probeUrl = (id) => `plugin://${id}/`
const probeTarget = async (id) => (await targets()).find((t) => t.url.startsWith(probeUrl(id)))

/** 轮询到条件成立或超时：插件目录监听、页面加载、落盘都是异步的，不能靠固定 sleep */
async function waitFor(fn, timeout = 8000, interval = 250) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) return null
    await new Promise((r) => setTimeout(r, interval))
  }
}

function writeLruProbe(index, name) {
  const dir = LRU_DIRS[index]
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify(
      {
        id: LRU_IDS[index],
        name,
        version: '0.0.0',
        type: 'web',
        entry: 'index.html',
        keywords: [`lru-${index + 1}`],
        permissions: ['storage']
      },
      null,
      2
    )
  )
  writeFileSync(
    join(dir, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>lru-${index + 1}</title><body>lru-${index + 1}
<script>
  window.appapi.onDestroy(() => {
    // 收尾窗口只有 400ms：这次 set 能落盘，说明 destroy 来得够早
    window.appapi.storage.set('destroyed-at', Date.now())
  })
</script></body>`
  )
}

for (const dir of LRU_DIRS) rmSync(dir, { recursive: true, force: true })
try {
  for (let i = 0; i < LRU_IDS.length; i++) writeLruProbe(i, `LRU 探针 ${i + 1}`)
  const registered = await waitFor(async () => {
    const ids = await evaluate(ws, 'window.panel.getPlugins().then((l) => l.map((p) => p.id))')
    return LRU_IDS.every((id) => ids.includes(id)) ? ids : null
  })
  check('插件目录监听(新目录免重启)', !!registered, registered ? `${LRU_IDS.length} 个探针已注册` : '超时未注册')

  // 改 plugin.json 也要免重启生效：改个名字，插件表应跟着变
  writeLruProbe(LRU_IDS.length - 1, 'LRU 探针 7 改名')
  const renamed = await waitFor(async () => {
    const name = await evaluate(ws, `window.panel.getPlugins().then((l) => l.find((p) => p.id === "${LRU_IDS[6]}")?.name ?? "")`)
    return name === 'LRU 探针 7 改名' ? name : null
  })
  check('plugin.json 改动免重启生效', renamed === 'LRU 探针 7 改名', String(renamed ?? '(未变)'))

  // 依次打开 7 个 → 超过常驻上限 5，最久未用的几个被回收
  let openedCount = 0
  for (const id of LRU_IDS) {
    await evaluate(ws, `window.panel.openPlugin("${id}")`)
    if (await waitFor(() => probeTarget(id), 6000)) openedCount++
  }
  check('探针插件页全部打开', openedCount === LRU_IDS.length, `${openedCount}/${LRU_IDS.length}`)

  // 宽限 400ms 之后才关页面；回收可能分几轮发生，轮询到 target 消失为准
  const oldestGone = await waitFor(
    async () => !(await targets()).some((t) => t.url.startsWith(probeUrl(LRU_IDS[0]))),
    6000
  )
  check('常驻上限外的旧视图被回收(最久未用先走)', oldestGone === true, `${LRU_IDS[0]} ${oldestGone ? '已关闭' : '仍在'}`)
  const aliveAfterEvict = await targets()
  check(
    '最近使用的视图仍然常驻',
    LRU_IDS.slice(-2).every((id) => aliveAfterEvict.some((t) => t.url.startsWith(probeUrl(id))))
  )

  // 重新打开被回收的那个：新页面，但要能读回 onDestroy 时写下的时间戳
  await evaluate(ws, `window.panel.openPlugin("${LRU_IDS[0]}")`)
  const revived = await waitFor(() => probeTarget(LRU_IDS[0]), 6000)
  const destroyedAt = revived
    ? await waitFor(async () => {
        try {
          const rws = await connect(revived.webSocketDebuggerUrl)
          await send(rws, 'Runtime.enable')
          const value = await evaluate(rws, `window.appapi.storage.get('destroyed-at')`)
          rws.close()
          return typeof value === 'number' ? value : null
        } catch {
          return null // 页面还没加载完，preload 未注入
        }
      })
    : null
  check('淘汰前收到 onDestroy 并完成落盘', typeof destroyedAt === 'number' && destroyedAt > 0, String(destroyedAt))

  // 13. 存储总量配额：单个值 2MB 上限挡不住"多存几个大键"，总量封顶后必须拒绝并说明原因
  const quotaLog = revived
    ? await (async () => {
        const rws = await connect(revived.webSocketDebuggerUrl)
        await send(rws, 'Runtime.enable')
        try {
          const raw = await evaluate(
            rws,
            `(async () => {
              const big = 'x'.repeat(1900000)
              const out = []
              for (let i = 0; i < 8; i++) {
                try {
                  await window.appapi.storage.set('big-' + i, big)
                  out.push('ok')
                } catch (e) {
                  out.push(String(e && e.message ? e.message : e))
                }
              }
              return JSON.stringify(out)
            })()`
          )
          return JSON.parse(raw)
        } finally {
          rws.close()
        }
      })()
    : []
  const accepted = quotaLog.filter((r) => r === 'ok').length
  const rejected = quotaLog.filter((r) => r !== 'ok')
  check(
    '存储总量配额生效(超限拒绝并说明原因)',
    accepted >= 1 && rejected.length >= 1 && String(rejected[0]).includes('配额'),
    `${accepted} 次成功 / 拒绝：${String(rejected[0] ?? '(无)').slice(0, 70)}`
  )
} finally {
  await evaluate(ws, 'window.panel.exitPlugin()').catch(() => {})
  await new Promise((r) => setTimeout(r, 400))
  // 先清数据再删目录：插件消失后 clearPluginData 会找不到记录
  for (const id of LRU_IDS) {
    await evaluate(ws, `window.panel.clearPluginData("${id}")`).catch(() => {})
  }
  for (const dir of LRU_DIRS) rmSync(dir, { recursive: true, force: true })
}

const unregistered = await waitFor(async () => {
  const ids = await evaluate(ws, 'window.panel.getPlugins().then((l) => l.map((p) => p.id))')
  return LRU_IDS.some((id) => ids.includes(id)) ? null : true
})
check('插件目录删除后自动下架(免重启)', unregistered === true)

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 冒烟结果: ${results.length - failed.length}/${results.length} 通过 ===`)
process.exit(failed.length ? 1 : 0)
