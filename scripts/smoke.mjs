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
const page = list.find(
  (t) => t.type === 'page' && (t.url.includes('localhost') || t.url.includes('index.html'))
)
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
  ['com.launcher.clipboard', 'com.launcher.calculator', 'com.launcher.notepad', 'com.launcher.translator'].every((id) => ids.includes(id)),
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
await evaluate(ws, 'window.panel.openPlugin("com.launcher.clipboard")')
await new Promise((r) => setTimeout(r, 2000))
const list2 = await targets()
const pluginPage = list2.find((t) => t.url.includes('plugins/clipboard/dist/index.html'))
check('web 插件视图加载(独立进程)', !!pluginPage, pluginPage?.url ?? '未找到')

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
  send(pws, 'Runtime.evaluate', { expression: 'window.appapi.exit()' }).catch(() => {})
}

// 6. 未声明权限的插件调用被拒（calculator 无 clipboard 权限）
await evaluate(ws, 'window.panel.openPlugin("com.launcher.calculator")')
await new Promise((r) => setTimeout(r, 1500))
const list3 = await targets()
const calcPage = list3.find((t) => t.url.includes('plugins/calculator/dist/index.html'))
if (calcPage) {
  const cws = await connect(calcPage.webSocketDebuggerUrl)
  await send(cws, 'Runtime.enable')
  const denied = await evaluate(cws, 'window.appapi.clipboard.readText().then(() => "leak").catch(e => String(e).includes("clipboard") ? "denied" : "other")')
  check('权限模型生效(未声明即拒绝)', denied === 'denied', String(denied))
  send(cws, 'Runtime.evaluate', { expression: 'window.appapi.exit()' }).catch(() => {})
} else {
  check('权限模型生效(未声明即拒绝)', false, 'calculator 页面未找到')
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 冒烟结果: ${results.length - failed.length}/${results.length} 通过 ===`)
process.exit(failed.length ? 1 : 0)
