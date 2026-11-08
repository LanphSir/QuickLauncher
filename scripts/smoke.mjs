// 功能冒烟测试：通过 CDP 驱动真实运行的 QuickLauncher
// 用法: 先启动 npx electron . --remote-debugging-port=9222，再运行 node scripts/smoke.mjs
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
// AI 分组是 v0.6.0 加的：点进去要能看到 provider 列表卡片（而不是空白）
await evaluate(
  ws,
  `Array.from(document.querySelectorAll('.nav-item')).find((e) => e.textContent.includes('AI'))?.click()`
)
await new Promise((r) => setTimeout(r, 260))
const aiCard = await evaluate(ws, `!!document.querySelector('.settings-body .card h3')`)
await evaluate(ws, `document.querySelector('.settings-header .back')?.click()`)
await new Promise((r) => setTimeout(r, 360))
check(
  '设置页有分组侧栏且可切换(含 AI 组)',
  navCount === 5 && navActive.includes('快捷键') && appCard === true && aiCard === true,
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
      permissions: ['net', 'ai'],
      hosts: ['127.0.0.1'],
      // 故意指向一份「一半好一半坏」的 tools.json：验证坏工具只丢自己
      ai: { tools: 'ai/tools.json' }
    },
    null,
    2
  )
)
mkdirSync(join(PROBE_DIR, 'ai'), { recursive: true })
writeFileSync(
  join(PROBE_DIR, 'ai', 'tools.json'),
  JSON.stringify({
    version: 1,
    tools: [
      {
        name: 'probe_echo',
        title: '回显',
        description: '把参数原样返回，冒烟用',
        risk: 'read',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
      },
      // 缺 description：模型无从判断何时调用，必须被丢掉
      { name: 'probe_broken', title: '坏的', parameters: { type: 'object' } }
    ]
  })
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

// 坏工具只丢自己：probe 的 tools.json 里有一个缺 description 的工具
const probeAi = await evaluate(
  ws,
  `window.panel.aiTools().then(l => l.find(p => p.pluginId === "${PROBE_ID}") || null)`
)
check(
  '坏 tools.json 只丢坏工具、插件照常加载',
  probeAi?.tools?.length === 1 && (probeAi?.errors?.length ?? 0) >= 1 && probeAi.tools[0].name === 'probe_echo',
  `工具 ${probeAi?.tools?.length ?? 0} 个 / 错误 ${probeAi?.errors?.length ?? 0} 条`
)

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

// 10. 未声明权限的插件调用被拒（calculator 声明了 ai/storage/clipboard，没有 notify）
await evaluate(ws, 'window.panel.openPlugin("com.launcher.calculator")')
await new Promise((r) => setTimeout(r, 1500))
const list3 = await targets()
const calcPage = list3.find((t) => isPluginPage(t, 'calculator'))
if (calcPage) {
  const cws = await connect(calcPage.webSocketDebuggerUrl)
  await send(cws, 'Runtime.enable')
  // 计算器 v0.6.8 起声明了 clipboard（点结果即复制），所以这里改用一个它确实没声明的权限：
  // 断言的东西没变——没在 manifest 里写的权限，调了就得被网关挡下来
  const denied = await evaluate(cws, 'window.appapi.notify("a", "b").then(() => "leak").catch(e => String(e).includes("notify") ? "denied" : "other")')
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

// ---------- AI：provider 配置 / 流式对话 / 停止 ----------
// 用一个本地假端点验证全链路（不联网、不花钱）：配置 → 探活 → 打开 AI 插件 → 流式 → 停止 → 清理
const AI_MOCK_PORT = 8788
let aiMock = null
let aiProviderId = ''
/** 本次冒烟新建的会话：清理时只删它，绝不碰用户自己的对话 */
let aiSessionId = ''
/** 冒烟开始前用户是否已经授权过计算器：是的话结束时不替用户撤销 */
let calcGrantedBefore = true
/** 附件段另开的会话，同样只删自己的 */
const extraSessionIds = []
/** mock 端点收到的最后一次请求体：用来断言多模态 content、附件是否真的进了上下文 */
let lastChatBody = null
try {
  aiMock = createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock-chat' }, { id: 'mock-slow' }] }))
      return
    }
    if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          lastChatBody = JSON.parse(body)
        } catch {
          lastChatBody = null
        }
        const payload = lastChatBody ?? {}
        // 摘要走非流式：返回一次性 JSON，而不是 SSE
        if (lastChatBody?.stream === false) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              choices: [{ message: { content: '用户在用本地 mock 端点测试上下文与附件。' } }]
            })
          )
          return
        }
        const slow = String(body).includes('SLOW')

        const writeText = (pieces, delayMs = 15) => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
          let i = 0
          const timer = setInterval(() => {
            if (res.writableEnded) return clearInterval(timer)
            if (i < pieces.length) {
              res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: pieces[i++] } }] })}\n\n`)
              return
            }
            clearInterval(timer)
            res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } })}\n\n`)
            res.write('data: [DONE]\n\n')
            res.end()
          }, delayMs)
          res.on('close', () => clearInterval(timer))
        }

        // ---- v0.6.3 工具调用的假模型 ----
        // 真实模型的行为没法在 CI 里复现，这里按用户话里的标记决定调哪个工具，
        // 分支写在「有没有 tool 结果」上，跟真实模型的轮次语义一致。
        const messages = Array.isArray(payload.messages) ? payload.messages : []
        const toolNames = Array.isArray(payload.tools)
          ? payload.tools.map((t) => t.function?.name).filter(Boolean)
          : []
        const toolMsgs = messages.filter((m) => m.role === 'tool')
        const lastUser = [...messages].reverse().find((m) => m.role === 'user')
        const userText =
          typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '')

        const findTool = (needle) => toolNames.find((n) => n.includes(needle)) ?? null
        const callTool = (name, args) => {
          if (!name) {
            writeText(['（模型没有拿到这个工具）'])
            return
          }
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
          const frames = [
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: `call_mock_${Date.now().toString(36)}`,
                        type: 'function',
                        function: { name, arguments: '' }
                      }
                    ]
                  }
                }
              ]
            },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
          ]
          for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
        }

        if (toolMsgs.length) {
          const failed = toolMsgs.find((m) => String(m.content).startsWith('执行失败'))
          if (failed) {
            writeText([`工具没有成功：${String(failed.content).slice(0, 60)}`])
            return
          }
          const called = messages
            .filter((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))
            .flatMap((m) => m.tool_calls.map((t) => t.function?.name ?? ''))
          const lastCall = called[called.length - 1] ?? ''
          if (lastCall.includes('calculate')) {
            writeText(['计算结果是 5541。'])
            return
          }
          if (lastCall.includes('clipboard_read')) {
            const clip = String(toolMsgs[toolMsgs.length - 1].content ?? '').trim()
            callTool(findTool('launcher_open'), { target: 'com.launcher.translator', query: clip })
            return
          }
          if (lastCall.includes('_echo')) {
            // MCP 工具：把结果原样带回正文，断言里好认
            writeText([`MCP 说：${String(toolMsgs[toolMsgs.length - 1].content ?? '').trim()}`])
            return
          }
          writeText(['已经用翻译插件打开了剪贴板里的地址。'])
          return
        }

        if (toolNames.length) {
          if (userText.includes('DANGER')) return callTool(findTool('probe_wipe'), {})
          if (userText.includes('CLIP')) return callTool(findTool('clipboard_read'), {})
          if (userText.includes('CALC')) return callTool(findTool('calculate'), { expression: '123*45+6' })
          if (userText.includes('TIMEOUT')) return callTool(findTool('probe_slow'), {})
          if (userText.includes('BOOM')) return callTool(findTool('probe_boom'), {})
          // MCPCRASH 必须排在 MCP 前面：前者包含后者
          if (userText.includes('MCPCRASH')) return callTool(findTool('crash'), {})
          if (userText.includes('MCP')) return callTool(findTool('echo'), { text: '你好，MCP' })
        }

        writeText(
          slow ? Array.from({ length: 40 }, (_, i) => `片段${i} `) : ['你', '好', '，我是本地', ' mock 端点。'],
          slow ? 60 : 15
        )
      })
      return
    }
    res.writeHead(404).end('no')
  })
  await new Promise((r) => aiMock.listen(AI_MOCK_PORT, '127.0.0.1', r))

  const saved = await evaluate(
    ws,
    `window.panel.aiSaveProvider({ presetId: 'custom', name: '冒烟 Mock', baseURL: 'http://127.0.0.1:${AI_MOCK_PORT}/v1', models: ['mock-chat', 'mock-slow'], apiKey: 'sk-smoke-9999', visionModels: ['mock-chat'] })`
  )
  aiProviderId = saved?.settings?.providers?.find((p) => p.name === '冒烟 Mock')?.id ?? ''
  const view = saved?.settings?.providers?.find((p) => p.id === aiProviderId)
  check(
    'AI 保存 provider 且密钥只回显掩码',
    saved?.ok === true && view?.hasKey === true && view?.apiKeyHint === 'sk-…9999',
    `${aiProviderId} / ${view?.apiKeyHint ?? '(无)'}`
  )

  const probe = await evaluate(ws, `window.panel.aiTestProvider(${JSON.stringify(aiProviderId)})`)
  check('AI 探活 /models 通过', probe?.ok === true && Array.isArray(probe.models), probe?.message ?? '')

  await evaluate(ws, `window.panel.openPlugin('com.launcher.ai')`)
  const aiReady = await waitFor(async () => {
    return (await targets()).some((t) => t.url.startsWith('plugin://com.launcher.ai/')) ? true : null
  })
  check('AI 插件页可打开', aiReady === true)

  // 必须先等界面挂载完再注册：插件 App 在 onMounted 里也调 onDelta，
  // preload 只保留最后一个回调，抢在它前面注册会被覆盖（表现为收不到任何事件）
  const aiMounted = await waitFor(async () => {
    return (await evaluateIn('ai', "Boolean(document.querySelector('.composer textarea'))")) ? true : null
  })
  check('AI 界面挂载完成', aiMounted === true)

  const sent = await evaluateIn(
    'ai',
    `(async () => {
      window.__ai = []
      window.appapi.ai.onDelta((e) => window.__ai.push(e))
      // 显式指定 mock 模型：默认模型可能已被用户设成真实端点，
      // 不指定就会真的联网、真的花钱（而且断言会拿到真人回答）
      return window.appapi.ai.send({ text: '你好', model: ${JSON.stringify(`${aiProviderId}/mock-chat`)} })
    })()`
  )
  aiSessionId = sent?.sessionId ?? ''
  check('AI 消息受理', sent?.ok === true, sent?.message ?? '')

  const firstRun = await waitFor(async () => {
    const events = await evaluateIn('ai', 'window.__ai')
    return events.some((e) => e.type === 'done') ? events : null
  })
  const streamedText = (firstRun ?? [])
    .filter((e) => e.type === 'text')
    .map((e) => e.delta)
    .join('')
  check(
    'AI 流式回答拼接正确',
    streamedText === '你好，我是本地 mock 端点。',
    `${(firstRun ?? []).length} 个事件 / ${streamedText}`
  )

  const sessions = await evaluateIn('ai', 'window.appapi.ai.sessions.list()')
  const mine = (sessions ?? []).find((s) => s.id === aiSessionId)
  check(
    'AI 会话落库(两条消息 + 标题取首句)',
    mine?.messageCount === 2 && mine?.title === '你好',
    JSON.stringify(mine ?? {})
  )

  const slowSend = await evaluateIn(
    'ai',
    `(async () => {
      window.__ai2 = []
      window.appapi.ai.onDelta((e) => window.__ai2.push(e))
      return window.appapi.ai.send({ text: 'SLOW 停止', sessionId: ${JSON.stringify(aiSessionId)}, model: ${JSON.stringify(`${aiProviderId}/mock-slow`)} })
    })()`
  )
  await new Promise((r) => setTimeout(r, 300))
  const stoppedAt = Date.now()
  await evaluateIn('ai', 'window.appapi.ai.sessions.list().then((l) => window.appapi.ai.stop(l[0].id))')
  const stopDone = await waitFor(async () => {
    const events = await evaluateIn('ai', 'window.__ai2')
    return events.find((e) => e.type === 'done') ?? null
  }, 40, 50)
  check(
    'AI 停止生效且标记 stopped',
    slowSend?.ok === true && stopDone?.stopped === true && Date.now() - stoppedAt < 2000,
    `${Date.now() - stoppedAt}ms / ${JSON.stringify(stopDone ?? null).slice(0, 60)}`
  )

  const partial = await evaluateIn(
    'ai',
    `window.appapi.ai.sessions.get(${JSON.stringify(aiSessionId)}).then((d) => {
      const last = d.messages[d.messages.length - 1]
      return { stopped: last.stopped === true, text: (last.parts || []).map((p) => p.text).join('') }
    })`
  )
  check(
    'AI 停止后保留已生成内容且无半截状态',
    partial?.stopped === true && partial.text.length > 0 && !partial.text.includes('undefined'),
    `${partial?.text?.length ?? 0} 字`
  )

  // ---------- v0.6.1：附件抽取 / 多模态请求体 ----------
  const mockModel = `${aiProviderId}/mock-chat`
  // 1×1 透明 PNG：够小、是合法图片，能验证 nativeImage 缩略这条路
  const PNG_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

  const textAttach = await evaluateIn(
    'ai',
    `window.appapi.ai.attach({ name: 'build.log', data: btoa('line1 ok line2 error: boom') })`
  )
  check(
    'AI 附件：文本被抽取成正文',
    textAttach?.ok === true &&
      textAttach.part?.kind === 'text' &&
      String(textAttach.part?.text ?? '').includes('error: boom'),
    textAttach?.part ? `已读 ${textAttach.part.text?.length ?? 0} 字` : (textAttach?.message ?? '')
  )

  const badAttach = await evaluateIn(
    'ai',
    `window.appapi.ai.attach({ name: 'setup.exe', data: btoa('MZ') })`
  )
  check(
    'AI 附件：不支持的类型被拒并说明原因',
    badAttach?.ok === false && String(badAttach?.message ?? '').length > 0,
    badAttach?.message ?? ''
  )

  const imageAttach = await evaluateIn('ai', `window.appapi.ai.attach({ name: 'shot.png', data: '${PNG_1PX}' })`)
  check(
    'AI 附件：图片生成缩略图并可发送',
    imageAttach?.ok === true &&
      imageAttach.part?.kind === 'image' &&
      String(imageAttach.part?.preview ?? '').startsWith('data:image/jpeg'),
    imageAttach?.part ? `${imageAttach.part.size}B` : (imageAttach?.message ?? '')
  )

  const fileSession = await evaluateIn('ai', `window.appapi.ai.sessions.create(${JSON.stringify(mockModel)})`)
  extraSessionIds.push(fileSession.id)

  const fileSend = await evaluateIn(
    'ai',
    `(async () => {
      window.__ai3 = []
      window.appapi.ai.onDelta((e) => window.__ai3.push(e))
      return window.appapi.ai.send({
        sessionId: ${JSON.stringify(fileSession.id)},
        text: '看下这个日志',
        attachIds: [${JSON.stringify(textAttach?.attachId ?? '')}],
        model: ${JSON.stringify(mockModel)}
      })
    })()`
  )
  await waitFor(async () => {
    const events = await evaluateIn('ai', 'window.__ai3')
    return events.some((e) => e.type === 'done') ? true : null
  })

  const attachedMessage = await evaluateIn(
    'ai',
    `window.appapi.ai.sessions.get(${JSON.stringify(fileSession.id)}).then((d) => {
      const user = d.messages.find((m) => m.role === 'user')
      const file = (user?.parts || []).find((p) => p.type === 'file')
      return { hasFile: Boolean(file), name: file?.name ?? '', kind: file?.kind ?? '' }
    })`
  )
  const bodyText = JSON.stringify(lastChatBody ?? {})
  check(
    'AI 附件进入上下文（消息留档 + 请求体带上正文）',
    fileSend?.ok === true &&
      attachedMessage?.hasFile === true &&
      attachedMessage?.name === 'build.log' &&
      bodyText.includes('error: boom'),
    `${attachedMessage?.name ?? '(无)'} / 请求体${bodyText.includes('error: boom') ? '含' : '不含'}正文`
  )

  const imageSend = await evaluateIn(
    'ai',
    `(async () => {
      window.__ai4 = []
      window.appapi.ai.onDelta((e) => window.__ai4.push(e))
      return window.appapi.ai.send({
        sessionId: ${JSON.stringify(fileSession.id)},
        text: '看图',
        attachIds: [${JSON.stringify(imageAttach?.attachId ?? '')}],
        model: ${JSON.stringify(mockModel)}
      })
    })()`
  )
  await waitFor(async () => {
    const events = await evaluateIn('ai', 'window.__ai4')
    return events.some((e) => e.type === 'done') ? true : null
  })
  const lastMessage = (lastChatBody?.messages ?? []).slice(-1)[0]
  const parts = Array.isArray(lastMessage?.content) ? lastMessage.content : []
  check(
    'AI 图片走多模态 content 数组',
    imageSend?.ok === true &&
      parts.some((p) => p.type === 'image_url' && String(p.image_url?.url).startsWith('data:image/png;base64,')),
    `${parts.length} 个内容块`
  )

  // ---- 插件 AI 协议（v0.6.2）：能力识别 / 授权 / 徽标 / 撤销 ----
  const toolViews = await evaluate(ws, 'window.panel.aiTools()')
  const calcAi = (toolViews ?? []).find((p) => p.pluginId === 'com.launcher.calculator')
  calcGrantedBefore = calcAi?.granted === true
  check(
    '插件 AI 能力被识别(计算器：1 工具 + 技能)',
    calcAi?.tools?.length === 1 && calcAi?.tools[0].name === 'calculate' && calcAi?.skill?.name === '计算器',
    JSON.stringify(calcAi ?? {}).slice(0, 150)
  )
  check('AI 工具默认不授权', calcAi?.granted === false)
  check('工具声明零解析错误', (calcAi?.errors?.length ?? 0) === 0, (calcAi?.errors ?? []).join('; '))

  const toolsBefore = await evaluateIn('ai', 'window.appapi.ai.tools()')
  check(
    '未授权时工具不下发给模型',
    Array.isArray(toolsBefore) && toolsBefore.length === 0,
    `实际 ${toolsBefore?.length ?? '?'} 条`
  )

  await evaluate(ws, `window.panel.aiSetToolGrant('com.launcher.calculator', true)`)
  const toolsAfter = await evaluateIn('ai', 'window.appapi.ai.tools()')
  check(
    '授权后工具进入下发清单(全局名带插件 id)',
    toolsAfter?.length === 1 &&
      toolsAfter[0].fullName === 'plugin:com.launcher.calculator:calculate' &&
      toolsAfter[0].risk === 'read',
    JSON.stringify(toolsAfter?.[0] ?? {}).slice(0, 120)
  )

  // 徽标要在面板首页才看得到：退出插件 → 搜出计算器 → 查 DOM
  await evaluate(ws, 'window.panel.exitPlugin()')
  await new Promise((r) => setTimeout(r, 400))
  await evaluate(ws, `(() => {
    const input = document.querySelector('.search')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '计算')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  const badge = await waitFor(async () => {
    const found = await evaluate(ws, `(() => {
      const tile = Array.from(document.querySelectorAll('.tile')).find(
        (t) => (t.querySelector('.tile-label')?.textContent || '').includes('计算器')
      )
      const b = tile?.querySelector('.ai-badge')
      return b ? { title: b.getAttribute('title') || '' } : null
    })()`)
    return found ?? null
  })
  check('面板图标出 AI 徽标且说明能力', Boolean(badge?.title?.includes('工具')), badge?.title ?? '(未找到)')

  // 撤销后必须立刻不下发——授权状态不能有任何缓存滞后
  await evaluate(ws, `window.panel.aiSetToolGrant('com.launcher.calculator', false)`)
  await evaluate(ws, `window.panel.openPlugin('com.launcher.ai')`)
  const toolsRevoked = await evaluateIn('ai', 'window.appapi.ai.tools()')
  check(
    '撤销授权后立即停止下发',
    Array.isArray(toolsRevoked) && toolsRevoked.length === 0,
    `实际 ${toolsRevoked?.length ?? '?'} 条`
  )

  // 面板右键「用 AI 询问」：条目信息经 intent 带进 AI 页，界面上要能看到引用条
  await evaluate(
    ws,
    `window.panel.openPlugin('com.launcher.ai', undefined, { askAbout: { name: '冒烟应用', type: '本地程序', command: 'C:\\\\smoke.exe' } })`
  )
  const askChip = await waitFor(async () => {
    const text = await evaluateIn('ai', "document.querySelector('.ask-chip')?.textContent || ''")
    return text ? text : null
  })
  check(
    'AI 收到面板条目上下文（引用条可见）',
    String(askChip ?? '').includes('冒烟应用'),
    String(askChip ?? '(无)').slice(0, 40)
  )

  // ---------- v0.6.3：工具调用（内置 + 插件 + 确认 + 审计） ----------
  // 探针插件负责三种失败形态：超时、报错、需要高危确认
  const TOOL_PROBE_ID = 'com.smoke.probe-ai'
  const TOOL_PROBE_DIR = join(process.cwd(), 'plugins', 'probe-ai')
  rmSync(TOOL_PROBE_DIR, { recursive: true, force: true })
  mkdirSync(join(TOOL_PROBE_DIR, 'ai'), { recursive: true })
  writeFileSync(
    join(TOOL_PROBE_DIR, 'plugin.json'),
    JSON.stringify({
      id: TOOL_PROBE_ID,
      name: '工具探针',
      version: '0.0.0',
      type: 'web',
      entry: 'index.html',
      permissions: ['ai'],
      apiVersion: 2,
      ai: { tools: 'ai/tools.json', mcp: 'ai/mcp.json' }
    })
  )
  writeFileSync(
    join(TOOL_PROBE_DIR, 'ai', 'tools.json'),
    JSON.stringify({
      version: 1,
      tools: [
        {
          name: 'probe_wipe',
          title: '清空数据',
          description: '高危操作，用来验证每次都要确认',
          risk: 'dangerous',
          parameters: { type: 'object', properties: {} }
        },
        {
          name: 'probe_slow',
          title: '慢工具',
          description: '故意超过自己的超时时间，用来验证超时回执',
          risk: 'read',
          timeoutMs: 1000,
          parameters: { type: 'object', properties: {} }
        },
        {
          name: 'probe_boom',
          title: '会报错的工具',
          description: '执行时抛错，用来验证错误回给模型',
          risk: 'read',
          parameters: { type: 'object', properties: {} }
        }
      ]
    })
  )
  writeFileSync(
    join(TOOL_PROBE_DIR, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>probe-ai</title><body>probe-ai
<script>
  window.appapi.ai.onToolCall(async (call) => {
    if (call.name === 'probe_slow') {
      await new Promise((r) => setTimeout(r, 2500))
      return '慢工具有结果了'
    }
    if (call.name === 'probe_boom') throw new Error('探针故意报错')
    if (call.name === 'probe_wipe') return '不该执行到这里：高危工具必须经用户确认'
    return 'ok'
  })
</script></body>`
  )

  // MCP（v0.6.4）：冒充一个真实的 stdio server。
  // 命令用 process.execPath（跑冒烟的这个 node），路径写绝对路径——与插件作者
  // 写 `npx xxx` 的形态一致，都是「一条要执行的命令 + 一串参数」。
  //
  // 两个 server 各管一件事：
  //   mock —— 走完整流程（批准/调用/改参数/崩溃）；它的审批记录会被上一轮冒烟留在 config 里，
  //           所以不拿它断言「初始待确认」，否则第二次跑就变成 stale 了
  //   idle —— 永远不批准，专门用来断言「默认一条命令都不跑」与「argv 完整可见」
  const MOCK_MCP_SCRIPT = join(process.cwd(), 'scripts', 'mock-mcp-server.mjs')
  const writeMcpJson = (extraArgs = []) =>
    writeFileSync(
      join(TOOL_PROBE_DIR, 'ai', 'mcp.json'),
      JSON.stringify(
        {
          servers: [
            {
              name: 'mock',
              command: process.execPath,
              args: [MOCK_MCP_SCRIPT, ...extraArgs],
              env: { SMOKE_MCP: '1' },
              timeoutMs: 15000
            },
            {
              name: 'idle',
              command: process.execPath,
              args: [MOCK_MCP_SCRIPT, '--idle'],
              timeoutMs: 15000
            }
          ]
        },
        null,
        2
      )
    )
  writeMcpJson()
  await evaluate(ws, 'window.panel.setPluginDisabled("com.launcher.notepad", true)')
  await evaluate(ws, 'window.panel.setPluginDisabled("com.launcher.notepad", false)')
  const toolProbe = await waitFor(async () => {
    const list = await evaluate(ws, 'window.panel.aiTools()')
    const found = (list ?? []).find((p) => p.pluginId === TOOL_PROBE_ID)
    return found && found.tools.length === 3 ? found : null
  })
  check(
    '工具探针插件声明被识别（3 个工具）',
    toolProbe?.tools?.length === 3 && (toolProbe?.errors?.length ?? 0) === 0,
    JSON.stringify(toolProbe?.tools?.map((t) => `${t.name}:${t.risk}`) ?? [])
  )

  await evaluate(ws, `window.panel.aiSetToolGrant('com.launcher.calculator', true)`)
  await evaluate(ws, `window.panel.aiSetToolGrant(${JSON.stringify(TOOL_PROBE_ID)}, true)`)

  /** 发一条消息并等 done；返回本次全部事件 */
  async function toolTurn(text) {
    const sent = await evaluateIn(
      'ai',
      `(async () => {
        window.__toolEvents = []
        // 先退订上一轮：onDelta 支持多个订阅者，不退订的话每条增量
        // 会被每一轮的闭包各推一次，断言里全是重复事件
        if (window.__toolOff) window.__toolOff()
        window.__toolOff = window.appapi.ai.onDelta((e) => window.__toolEvents.push(e))
        return window.appapi.ai.send({ text: ${JSON.stringify(text)}, model: ${JSON.stringify(mockModel)} })
      })()`
    )
    if (sent?.sessionId) extraSessionIds.push(sent.sessionId)
    const events = await waitFor(async () => {
      const list = await evaluateIn('ai', 'window.__toolEvents')
      return list?.some((e) => e.type === 'done') ? list : null
    }, 15000, 120)
    return { sent, events: events ?? [] }
  }

  const pick = (events, type) => events.filter((e) => e.type === type)
  const doneOf = (events) => pick(events, 'done')[0] ?? null
  const textOfEvents = (events) => pick(events, 'text').map((e) => e.delta).join('')

  /** 等确认框出现，可选点按钮；返回框内信息用于断言 */
  async function confirmDialog(action) {
    return waitFor(async () => {
      return await evaluateIn(
        'ai',
        `(() => {
          const box = document.querySelector('.confirm-box')
          if (!box) return null
          const info = {
            title: document.querySelector('.confirm-title')?.textContent?.trim() || '',
            risk: document.querySelector('.confirm-sub .tool-risk')?.textContent?.trim() || '',
            warn: Boolean(document.querySelector('.confirm-warn')),
            remember: Boolean(document.querySelector('.confirm-remember'))
          }
          ${
            action
              ? `const btn = document.querySelector('.confirm-actions .${action === 'allow' ? 'send' : 'ghost'}'); if (!btn) return null; btn.click(); info.clicked = btn.textContent.trim()`
              : ''
          }
          return info
        })()`
      )
    }, 8000, 120)
  }

  // 1. 内置工具 + 插件工具：read 风险直接执行
  const calc = await toolTurn('CALC 帮我算一下 123*45+6')
  const calcCalls = pick(calc.events, 'tool-call')
  const calcResults = pick(calc.events, 'tool-result')
  check(
    '插件工具被调用并返回结果（read 不需确认）',
    calcCalls.length === 1 &&
      calcCalls[0].call.title.includes('计算') &&
      calcResults.length === 1 &&
      calcResults[0].result.ok === true &&
      String(calcResults[0].result.text).includes('5541'),
    `${calcCalls[0]?.call?.title ?? '(未调用)'} → ${String(calcResults[0]?.result?.text ?? '').slice(0, 40)}`
  )
  check(
    '工具结果回到模型后继续生成',
    doneOf(calc.events)?.error === undefined && textOfEvents(calc.events).includes('5541'),
    textOfEvents(calc.events).slice(0, 40)
  )

  const calcMessage = await evaluateIn(
    'ai',
    `window.appapi.ai.sessions.get(${JSON.stringify(calc.sent?.sessionId ?? '')}).then((d) => {
      const last = d.messages[d.messages.length - 1]
      const call = (last.parts || []).find((p) => p.type === 'tool_call')
      const result = (last.parts || []).find((p) => p.type === 'tool_result')
      return { role: last.role, call: call?.title ?? '', ok: result?.ok ?? null, text: result?.text ?? '' }
    })`
  )
  check(
    '工具调用与结果落进会话（切走再回来还在）',
    calcMessage?.role === 'assistant' && Boolean(calcMessage?.call) && calcMessage?.ok === true && calcMessage.text.includes('5541'),
    JSON.stringify(calcMessage ?? {}).slice(0, 90)
  )

  // 2. 验收链路：剪贴板 → 翻译插件（中间有一次 write 风险确认）
  await evaluateIn('ai', `window.appapi.clipboard.writeText('https://example.com/hello?q=1')`)
  const clipRun = (async () => toolTurn('CLIP 把剪贴板里的地址用翻译插件翻一下'))()
  const dialog = await confirmDialog('allow')
  const clip = await clipRun
  check(
    '写操作先弹确认（显示风险与参数）',
    dialog?.title?.includes('打开') === true && dialog?.risk === '会改动' && dialog?.remember === true,
    JSON.stringify(dialog ?? {}).slice(0, 100)
  )
  const clipCalls = pick(clip.events, 'tool-call')
  const clipResults = pick(clip.events, 'tool-result')
  check(
    '确认后链路跑通（读剪贴板 → 打开翻译插件）',
    clipCalls.length === 2 &&
      clipCalls[0].call.apiName === 'clipboard_read' &&
      clipCalls[1].call.apiName === 'launcher_open' &&
      clipResults.length === 2 &&
      clipResults.every((e) => e.result.ok === true) &&
      String(clipResults[0].result.text).includes('example.com'),
    `${clipCalls.map((c) => c.call.apiName).join(' → ')} / ${clipResults.map((r) => (r.result.ok ? 'ok' : r.result.error)).join(',')}`
  )
  check(
    '模型拿到结果后给出最终回答',
    doneOf(clip.events)?.error === undefined && textOfEvents(clip.events).includes('翻译插件'),
    textOfEvents(clip.events).slice(0, 40)
  )

  // 翻译插件真的收到了那段地址（query 透传到 webview 的 src 里）
  const translatorSrc = await waitFor(async () => {
    const target = (await targets()).find((t) => t.url.startsWith('plugin://com.launcher.translator/'))
    if (!target) return null
    const tws = await connect(target.webSocketDebuggerUrl)
    try {
      await send(tws, 'Runtime.enable')
      return await evaluate(tws, `document.querySelector('webview')?.getAttribute('src') || ''`)
    } finally {
      tws.close()
    }
  }, 8000, 250)
  check(
    '翻译插件带着地址被打开（query 生效）',
    String(translatorSrc ?? '').includes('example.com'),
    String(translatorSrc ?? '(无 webview)').slice(0, 80)
  )

  // 3. 拒绝：write 风险被用户否掉，模型收到失败原因
  const rejectRun = (async () => toolTurn('CLIP 拒绝 这次别打开'))()
  const denyDialog = await confirmDialog('deny')
  const rejected = await rejectRun
  const denyResult = pick(rejected.events, 'tool-result').find((e) => e.result.ok === false)
  check(
    '用户拒绝后工具不执行且失败原因回到模型',
    denyDialog?.clicked === '拒绝' &&
      Boolean(denyResult) &&
      String(denyResult.result.error).includes('拒绝') &&
      textOfEvents(rejected.events).includes('工具没有成功'),
    String(denyResult?.result?.error ?? '(无失败结果)').slice(0, 50)
  )

  // 4. dangerous：每次都问，且不给「不再询问」
  const dangerRun = (async () => toolTurn('DANGER 清空我的数据'))()
  const dangerDialog = await confirmDialog('deny')
  const danger = await dangerRun
  const dangerResult = pick(danger.events, 'tool-result')[0]
  check(
    'dangerous 工具必须确认且没有「不再询问」',
    dangerDialog?.risk === '高风险' && dangerDialog?.warn === true && dangerDialog?.remember === false,
    JSON.stringify(dangerDialog ?? {}).slice(0, 100)
  )
  check(
    'dangerous 未获准时不执行',
    dangerResult?.result.ok === false && String(dangerResult.result.error).includes('拒绝'),
    String(dangerResult?.result?.error ?? '(无)').slice(0, 50)
  )

  // 5. 插件超时 / 插件报错：两种失败都以 tool-result.error 回给模型
  const slow = await toolTurn('TIMEOUT 调一下慢工具')
  const slowResult = pick(slow.events, 'tool-result')[0]
  check(
    '插件超时按超时回给模型',
    slowResult?.result.ok === false && String(slowResult.result.error).includes('超时'),
    String(slowResult?.result?.error ?? '(无)').slice(0, 60)
  )

  const boom = await toolTurn('BOOM 调一下会报错的工具')
  const boomResult = pick(boom.events, 'tool-result')[0]
  check(
    '插件抛错按错误回给模型',
    boomResult?.result.ok === false && String(boomResult.result.error).includes('探针故意报错'),
    String(boomResult?.result?.error ?? '(无)').slice(0, 60)
  )

  // ---------- v0.6.4：MCP 接入（声明 → 确认 → 调用 → 改参数 → 崩溃） ----------
  const findMcpRow = async (server = 'mock') => {
    const list = await evaluate(ws, 'window.panel.aiMcpServers()')
    return (list ?? []).find((r) => r.pluginId === TOOL_PROBE_ID && r.server === server) ?? null
  }

  // 1. 声明被识别，但没有任何进程被启动（用从未批准过的 idle 保证可重复）
  const mcpPending = await waitFor(async () => {
    const row = await findMcpRow('idle')
    return row && row.state === 'pending' ? row : null
  })
  check(
    'MCP server 声明被识别且默认不启动',
    mcpPending?.state === 'pending' && mcpPending.running === false && mcpPending.toolCount === 0,
    `${mcpPending?.state ?? '(无)'} / running=${mcpPending?.running}`
  )
  check(
    '设置页能拿到完整 argv（确认的依据）',
    mcpPending?.command === process.execPath &&
      Array.isArray(mcpPending?.args) &&
      mcpPending.args[0] === MOCK_MCP_SCRIPT &&
      mcpPending.args[1] === '--idle' &&
      String(mcpPending?.commandLine).includes('mock-mcp-server.mjs'),
    String(mcpPending?.commandLine ?? '(无)').slice(-48)
  )
  const mcpEnvRow = await findMcpRow('mock')
  check(
    'env 只暴露键名（值里可能带 token）',
    (mcpEnvRow?.envKeys ?? []).join() === 'SMOKE_MCP' && !String(mcpEnvRow?.commandLine).includes('SMOKE_MCP=1'),
    (mcpEnvRow?.envKeys ?? []).join('、')
  )

  // 2. 允许 → 立刻建连并列出工具
  const mcpApprove = await evaluate(
    ws,
    `window.panel.aiMcpDecision(${JSON.stringify(TOOL_PROBE_ID)}, 'mock', true)`
  )
  const mcpReady = await waitFor(async () => {
    const row = await findMcpRow()
    return row && row.state === 'approved' && row.running && row.toolCount >= 2 ? row : null
  })
  check(
    '允许后建连并列出工具',
    mcpApprove?.ok === true && mcpReady?.toolCount === 2,
    `${mcpApprove?.ok ? 'ok' : mcpApprove?.message ?? '失败'} / ${mcpReady?.toolCount ?? 0} 个工具`
  )

  // 3. 对话里真的调到了 MCP 工具
  const mcpTurn = await toolTurn('MCP 用回声工具说一句话')
  const mcpCalls = pick(mcpTurn.events, 'tool-call')
  const mcpResults = pick(mcpTurn.events, 'tool-result')
  check(
    'MCP 工具被模型调用并返回结果',
    mcpCalls.length === 1 &&
      String(mcpCalls[0].call.apiName).endsWith('_echo') &&
      mcpResults.length === 1 &&
      mcpResults[0].result.ok === true &&
      String(mcpResults[0].result.text).includes('回声'),
    `${mcpCalls[0]?.call?.apiName ?? '(未调用)'} → ${String(mcpResults[0]?.result?.text ?? '').slice(0, 30)}`
  )
  check(
    'MCP 结果回到模型后继续生成',
    doneOf(mcpTurn.events)?.error === undefined && textOfEvents(mcpTurn.events).includes('回声'),
    textOfEvents(mcpTurn.events).slice(0, 40)
  )

  // 4. 改参数 → 指纹失效 → 回到待确认（这条是整个授权机制的核心）
  writeMcpJson(['--smoke-changed'])
  const mcpStale = await waitFor(async () => {
    const row = await findMcpRow()
    return row && row.state === 'stale' ? row : null
  })
  check(
    '命令改动后旧批准失效，回到待确认',
    mcpStale?.state === 'stale',
    `${mcpStale?.state ?? '(无)'} / ${String(mcpStale?.commandLine ?? '').slice(-30)}`
  )

  // 5. server 崩溃：工具报错回给模型，对话继续可用
  const reApprove = await evaluate(
    ws,
    `window.panel.aiMcpDecision(${JSON.stringify(TOOL_PROBE_ID)}, 'mock', true)`
  )
  await waitFor(async () => {
    const row = await findMcpRow()
    return row && row.state === 'approved' && row.running ? true : null
  })
  const crashRun = (async () => toolTurn('MCPCRASH 让服务崩掉'))()
  const crashDialog = await confirmDialog('allow')
  const crashed = await crashRun
  const crashResult = pick(crashed.events, 'tool-result')[0]
  check(
    'MCP 的高危工具同样要确认',
    reApprove?.ok === true && crashDialog?.risk === '高风险',
    JSON.stringify(crashDialog ?? {}).slice(0, 80)
  )
  check(
    'server 崩溃后工具以错误回给模型',
    crashResult?.result.ok === false,
    String(crashResult?.result?.error ?? '(无)').slice(0, 60)
  )
  const afterCrash = await toolTurn('你好，崩了之后还能聊吗')
  check(
    'server 崩溃后对话仍可用',
    doneOf(afterCrash.events)?.error === undefined && textOfEvents(afterCrash.events).length > 0,
    textOfEvents(afterCrash.events).slice(0, 30) || '(无正文)'
  )

  // 6. 审计：userData/ai/audit.jsonl 里有据可查
  const auditFile = (() => {
    const base = process.env.APPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Roaming')
    if (!existsSync(base)) return null
    for (const dir of readdirSync(base)) {
      const file = join(base, dir, 'ai', 'audit.jsonl')
      if (existsSync(file)) return file
    }
    return null
  })()
  let auditLines = []
  try {
    auditLines = auditFile
      ? readFileSync(auditFile, 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((entry) => extraSessionIds.includes(entry.sessionId))
      : []
  } catch {
    auditLines = []
  }
  const auditOpen = auditLines.find((e) => e.tool === 'launcher_open' && e.ok === true)
  const auditDeny = auditLines.find((e) => e.tool.endsWith('probe_wipe'))
  check(
    '审计日志记录了每一次工具调用',
    auditLines.length >= 6 && Boolean(auditOpen) && auditOpen.confirm === 'allowed',
    auditFile ? `${auditLines.length} 条 / ${String(auditOpen?.tool ?? '')}` : '未找到 audit.jsonl'
  )
  check(
    '审计里能查到被拒绝的高危调用',
    Boolean(auditDeny) && auditDeny.ok === false && auditDeny.risk === 'dangerous' && auditDeny.confirm === 'denied',
    JSON.stringify(auditDeny ?? {}).slice(0, 100)
  )
  const auditMcp = auditLines.find((e) => e.source === 'mcp' && e.ok === true)
  check(
    '审计区分工具来源（内置/插件/MCP）',
    Boolean(auditMcp) && String(auditMcp.tool).startsWith('mcp:'),
    auditMcp ? `${auditMcp.tool} / ${auditMcp.source}` : '未找到 source=mcp 的记录'
  )

  // 收回探针与授权，退出插件页（断言失败也不留垃圾）
  await evaluate(ws, `window.panel.aiMcpDecision(${JSON.stringify(TOOL_PROBE_ID)}, 'mock', false)`).catch(() => {})
  await evaluate(ws, `window.panel.aiSetToolGrant(${JSON.stringify(TOOL_PROBE_ID)}, false)`).catch(() => {})
  await evaluate(ws, 'window.panel.exitPlugin()').catch(() => {})
} finally {
  // 清理：先删 provider（连带密钥），再删本次冒烟建的会话，最后关假端点。
  // 注意只能删 aiSessionId —— 早期版本这里是"删除列出的所有会话"，
  // 一旦用户自己也用过 AI 插件，跑一次冒烟就会把他的对话全清掉。
  if (aiProviderId) {
    await evaluate(ws, `window.panel.aiDeleteProvider(${JSON.stringify(aiProviderId)})`).catch(() => {})
  }
  if (aiSessionId) {
    await evaluateIn('ai', `window.appapi.ai.sessions.remove(${JSON.stringify(aiSessionId)})`).catch(() => {})
  }
  // 只撤我们自己开的授权：用户本来就开着的不能被冒烟关掉
  if (!calcGrantedBefore) {
    await evaluate(ws, `window.panel.aiSetToolGrant('com.launcher.calculator', false)`).catch(() => {})
  }
  await evaluate(ws, `window.panel.aiSetToolGrant('com.smoke.probe-ai', false)`).catch(() => {})
  await evaluate(ws, `window.panel.aiMcpDecision('com.smoke.probe-ai', 'mock', false)`).catch(() => {})
  rmSync(join(process.cwd(), 'plugins', 'probe-ai'), { recursive: true, force: true })
  await evaluate(ws, 'window.panel.setPluginDisabled("com.launcher.notepad", true)').catch(() => {})
  await evaluate(ws, 'window.panel.setPluginDisabled("com.launcher.notepad", false)').catch(() => {})
  for (const id of extraSessionIds) {
    await evaluateIn('ai', `window.appapi.ai.sessions.remove(${JSON.stringify(id)})`).catch(() => {})
  }
  if (aiMock) await new Promise((r) => aiMock.close(r))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 冒烟结果: ${results.length - failed.length}/${results.length} 通过 ===`)
process.exit(failed.length ? 1 : 0)
