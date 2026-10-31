// 功能冒烟测试：通过 CDP 驱动真实运行的 QuickLauncher
// 用法: 先启动 npx electron . --remote-debugging-port=9222，再运行 node scripts/smoke.mjs
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

const list = await targets()
// 只能用主面板页面：插件页（plugins/*/dist/index.html）同样含 index.html，且没有 window.panel
const page =
  list.find((t) => t.type === 'page' && t.url.includes('out/renderer/index.html')) ??
  list.find((t) => t.type === 'page' && t.url.includes('localhost') && !t.url.includes('/plugins/'))
if (!page) {
  console.error('未找到主面板页面，targets:', list.map((t) => `${t.type}:${t.url}`).join('\n'))
  process.exit(1)
}

const ws = await connect(page.webSocketDebuggerUrl)
await send(ws, 'Runtime.enable')

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

// 3. 配置读取（快捷键可能被用户改过，只验证格式合法：至少一个修饰键 + 主键）
const cfg = await evaluate(ws, 'window.panel.getConfig().then(c => c.hotkey)')
check(
  '全局配置读取(快捷键格式合法)',
  typeof cfg === 'string' && /^[A-Za-z0-9]+(\+[A-Za-z0-9]+)+$/.test(cfg),
  String(cfg)
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

// 4. 打开 web 插件 → 出现独立插件进程页面
const homeBounds = await evaluate(ws, 'window.panel.getWindowBounds()')
await evaluate(ws, 'window.panel.openPlugin("com.launcher.clipboard")')
await new Promise((r) => setTimeout(r, 2000))
const list2 = await targets()
const pluginPage = list2.find((t) => t.url.includes('plugins/clipboard/dist/index.html'))
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

// 6. 手册插件：静态手册打包 + docs 权限通道
await evaluate(ws, 'window.panel.openPlugin("com.launcher.handbook")')
await new Promise((r) => setTimeout(r, 2500))
const listHb = await targets()
const hbPage = listHb.find((t) => t.url.includes('plugins/handbook/dist/index.html'))
check('手册插件加载(独立进程)', !!hbPage, hbPage?.url ?? '未找到')
if (hbPage) {
  const hws = await connect(hbPage.webSocketDebuggerUrl)
  await send(hws, 'Runtime.enable')
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
const calcStill = afterDetach.some((t) => t.url.includes('plugins/calculator/dist/index.html'))
check('分离为独立窗口', det?.ok === true && calcStill, JSON.stringify(det))
const det2 = await evaluate(ws, 'window.panel.detachPlugin("com.launcher.calculator")')
check('重复分离=聚焦已有窗口', det2?.ok === true)

// 10. 未声明权限的插件调用被拒（calculator 无 clipboard 权限）
await evaluate(ws, 'window.panel.openPlugin("com.launcher.calculator")')
await new Promise((r) => setTimeout(r, 1500))
const list3 = await targets()
const calcPage = list3.find((t) => t.url.includes('plugins/calculator/dist/index.html'))
if (calcPage) {
  const cws = await connect(calcPage.webSocketDebuggerUrl)
  await send(cws, 'Runtime.enable')
  const denied = await evaluate(cws, 'window.appapi.clipboard.readText().then(() => "leak").catch(e => String(e).includes("clipboard") ? "denied" : "other")')
  check('权限模型生效(未声明即拒绝)', denied === 'denied', String(denied))
  const docsDenied = await evaluate(cws, 'window.appapi.docs.list().then(() => "leak").catch(e => String(e).includes("docs") ? "denied" : "other")')
  check('docs 权限未声明即拒绝', docsDenied === 'denied', String(docsDenied))
  // 已分离窗口内退出 → 窗口关闭、视图销毁
  send(cws, 'Runtime.evaluate', { expression: 'window.appapi.exit()' }).catch(() => {})
  await new Promise((r) => setTimeout(r, 1500))
  const afterExit = await targets()
  check('分离窗口内退出即关窗', !afterExit.some((t) => t.url.includes('plugins/calculator/dist/index.html')))
} else {
  check('权限模型生效(未声明即拒绝)', false, 'calculator 页面未找到')
  check('分离窗口内退出即关窗', false, 'calculator 页面未找到')
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 冒烟结果: ${results.length - failed.length}/${results.length} 通过 ===`)
process.exit(failed.length ? 1 : 0)
