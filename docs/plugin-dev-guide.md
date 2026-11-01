# 插件开发指南

QuickLauncher 插件分两种：**web 型**（自设计的 HTML 页面应用）和 **external 型**（拉起任意外部程序）。

## 快速开始：最小 web 插件

```
my-plugin/
├─ plugin.json
├─ icon.svg          可选，支持 icon.svg / icon.png / icon.ico
└─ index.html        入口（可以是任何能产出静态页面的构建产物）
```

```jsonc
// plugin.json
{
  "id": "com.yourname.my-plugin",   // 全局唯一，建议反向域名
  "name": "我的插件",
  "version": "0.1.0",
  "description": "一句话说明",
  "type": "web",
  "entry": "index.html",
  "keywords": ["demo", "示例"],     // 面板搜索关键词
  "permissions": ["storage", "notify"],
  "hosts": ["api.example.com"],     // 仅 net 权限需要：可访问的域白名单
  "features": ["inline"],           // 可选：参与面板内联结果（v0.4.7 起，见对应章节）
  "hotkey": "Alt+Shift+V"           // 可选：建议启动键（v0.4.12 起，仅作设置页提示）
}
```

### 建议启动键 `hotkey`（v0.4.12 起）

manifest 里的 `hotkey` 是**建议值**，不会自动注册——设置页会在该插件的「插件快捷键」一行
显示成可点的小标签，用户点一下才真正生效（生效值存在用户配置 `pluginHotkeys` 里）。

之所以不自动注册：全局快捷键是稀缺资源，替用户默认占一个键很容易和别的程序撞车，
撞了之后要用户自己去设置里排查。给个建议、让用户点头更稳妥。

格式同 Electron accelerator，必须至少一个修饰键（`Alt+Shift+V`、`CommandOrControl+Shift+K`）。

### 关键词高级匹配（v0.2.0 起）

除普通子串匹配外，`keywords` 支持：

```jsonc
"keywords": [
  "翻译",                              // 子串：query 包含"翻译"即命中
  "calc*",                             // 通配符：* 任意串、? 单字符，与整个查询词匹配
  "re:^[a-zA-Z][a-zA-Z0-9@._\\- ]{1,120}$"  // 正则：re: 前缀，对整个查询词 test
]
```

- 典型场景：翻译类插件加 `re:^[a-zA-Z]...`，用户输入**任意英文**都会命中翻译应用
- 正则非法时静默跳过；请避免灾难性回溯模式（查询词很短，风险可控但仍是好习惯）

### 接收面板搜索词（v0.2.0 起）

打开插件时面板会把当前搜索词传给插件，用于"输入即动作"场景：

```ts
onMounted(() => {
  window.appapi.onQuery(({ query }) => {
    if (query) doSomethingWith(query)   // 如翻译插件直接翻译该词
  })
})
```

把目录放到项目 `plugins/` 下（或其构建产物放进 `my-plugin/dist/`），重启应用即可在面板搜索到。

### 安装到用户目录（不改项目源码）

两种方式把插件装进用户目录 `%APPDATA%/quick-launcher/plugins/installed/`：

1. **手动投放**：把含 `plugin.json` 的目录（或其 `dist/`）放进去即可——v0.4.9 起目录监听会自动重扫，
   不用重启（改 manifest、删目录同理）
2. **面板安装**：全部应用页 → "从目录安装" / "从 ZIP 安装"（zip 内支持根目录或 `dist/plugin.json`，安装时会做 manifest 校验、失败回滚；zip 解包过滤路径穿越与 node_modules）

安装后的插件可在 设置 → 插件管理 中停用/启用/卸载/打开目录；内置插件只能停用不能卸载。

## 插件 API（window.appapi）

所有调用经过主进程网关：先校验调用方身份，再校验 `plugin.json` 里声明的权限，未声明会直接 reject。

```ts
// 信息
await appapi.info()                        // { id, name, version, permissions }

// 面板搜索词 / 搜索条目意图（无需权限；onQuery 注册前的到达事件会被 preload 缓冲补发）
appapi.onQuery(({ query, intent }) => {
  // query：打开插件时的搜索词，可能为 undefined
  // intent：从搜索条目打开时透传的结构（插件自定义，见"搜索贡献"一节）
})

// 存储（按插件 id 强制隔离，key-value，值需可 JSON 序列化）
await appapi.storage.set('todos', [1, 2])
await appapi.storage.get('todos')          // 未声明 storage 权限会被拒绝
await appapi.storage.keys()
await appapi.storage.remove('todos')
// 上限：单值 2MB、单插件总计 8MB。超了 set 会 reject 并说明已用/上限，
// 所以历史记录类数据要自己截断（保留最近 N 条），别等被拒才发现。

// ⚠ 注意：跨 contextBridge 传参会做结构化克隆，Vue 的 reactive/ref Proxy 不能直接传
//（报 `An object could not be cloned`，发生在 await 处，后续代码全部不执行）。
// 存响应式状态前先转纯数据：storage.set('k', JSON.parse(JSON.stringify(state)))
//（内置插件 clipboard/translator 里的 plain() 就是这个用途）

// 剪贴板（需要 clipboard 权限）
await appapi.clipboard.readText()
await appapi.clipboard.writeText('hello')

// 系统通知（需要 notify 权限）
await appapi.notify('标题', '内容')

// 打开外部链接（需要 shell 权限，仅 http/https）
await appapi.shell.openExternal('https://example.com')

// 文档库（需要 docs 权限，v0.4.0 起）：文件落在 userData/data/<pluginId>/docs/，由主进程代管
await appapi.docs.list()                   // [{ id, title, size, updatedAt }]，id 即文件名
await appapi.docs.import()                 // 弹系统文件框（可多选 .md/.markdown/.txt），拷进自己的文档目录
await appapi.docs.read(id)                 // { ok, text }  文本内容（UTF-8 / GBK 自动识别，单文件上限 4MB）
await appapi.docs.remove(id)               // 删除
await appapi.docs.reveal()                 // 在资源管理器打开文档目录（方便直接拖文件进去）

// HTTP 请求（需要 net 权限 + manifest hosts 白名单，v0.4.6 起）
const res = await appapi.net.request({
  url: 'https://api.example.com/v1/items',
  method: 'POST',                          // 默认 GET；大小写不敏感
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ q: 'hello' }),
  timeoutMs: 10000                         // 默认 15000，上限 60000
})
// res = { ok, status, headers, body, truncated?, url }
// 4xx/5xx 不抛错（ok=false）；网络错误/超时/白名单外会 reject

// 可见性（无需权限，v0.4.6 起）
appapi.onShow(() => startPolling())        // 注册时若已可见会立即回调一次
appapi.onHide(() => stopPolling())         // 切走/面板收起时暂停轮询、动画、视频
// 视图即将被回收（v0.4.8 起）：约 400ms 后页面关闭，草稿请在这里落盘
appapi.onDestroy(() => void appapi.storage.set('draft', draft.value))

// 窗口控制（无需权限）
await appapi.window.hide()                 // 隐藏整个面板（等同 Esc）
await appapi.exit()                        // 退出当前插件，返回面板主页
await appapi.window.detach()               // 把当前插件分离为独立窗口：
                                           // 状态保留、任务栏可见；此后 exit=关闭该窗口
```

约定俗成的交互：**Esc 键调用 `appapi.exit()` 返回面板**，插件页自己监听 keydown 实现。

### 调用 HTTP API（`net` 权限 + `hosts`，v0.4.6 起）

插件页跑在 `plugin://` 下，直接 `fetch` 三方 API 会被 CORS 拦，所以请求走主进程转发。
授权是**两层**，缺一不可：

```jsonc
// plugin.json
{
  "permissions": ["net"],
  "hosts": ["api.github.com", "*.example.com", "localhost:8080"]
}
```

- `hosts` 支持精确域名、通配子域（`*.example.com` 同时匹配裸域 `example.com`）、可选端口（写了端口就只认该端口）
- `hosts` 缺省或为空 = 一个域都不许（不会因为声明了 `net` 就放开）
- **重定向逐跳校验**：`https://api.x.com` 返回 302 到 `https://evil.com` 会被直接拒绝，不会被带走
- 请求不带任何 cookie（`credentials: 'omit'`），插件读不到主面板或其他插件的登录态
- `host` / `cookie` / `content-length` 这类头由主进程接管，插件传了会被丢弃
- 响应体超过 4MB 截断并返回 `truncated: true`；正文按 UTF-8 解码，二进制内容请改用 `<img>`/`<webview>` 加载

### 可见性：切换时暂停后台工作（v0.4.6 起）

插件退出后**视图只被摘掉、不被销毁**（为了重进时保留状态），所以 `onUnmounted` 不会触发。
任何定时器/轮询/动画都应该跟着可见性走：

```ts
let timer: ReturnType<typeof setInterval> | undefined
const start = () => { if (!timer) timer = setInterval(poll, 800) }
const stop = () => { if (timer) { clearInterval(timer); timer = undefined } }

appapi.onShow(() => { void poll(); start() })   // 注册时已可见 → 立即启动
appapi.onHide(stop)                             // 返回主界面/换插件/收起面板 → 停
onUnmounted(stop)                               // 页面真被销毁时也停
```

参考 `plugins/clipboard/`：v0.4.6 之前它退出后仍在后台每 800ms 读一次剪贴板。

### 插件页外框（v0.4.1 起）

插件页不是裸窗口：启动器会在外面套一层外框——顶部 46px 工具条（返回主界面 / 插件名 / 独立窗口 / 关闭）+ 四周 8px 留白，
插件内容区 = 面板尺寸 − 46 − 左右各 8 − 底部 8。由此有两条约定：

- **不要自己画窗口级控件**（关闭、返回主界面、最小化）：外框已统一提供，重复画会变成两套入口。
  插件自己的"返回"只用于内部层级（如 章节 → 手册列表）。
- **关键控件别贴内容区最边缘**：留白那一圈是缩放热区的作用带，贴边的按钮容易被拖拽/缩放手势抢走点击。
- 布局用 `height: 100%` / `100vh` 即可，进插件时面板会自动伸展到适合阅读的尺寸，退出时还原主页尺寸。

## 权限一览

| 权限 | 控制的 API |
|---|---|
| `storage` | `appapi.storage.*`（单值 2MB / 单插件 8MB） |
| `clipboard` | `appapi.clipboard.*` |
| `notify` | `appapi.notify` |
| `shell` | `appapi.shell.openExternal` |
| `docs` | `appapi.docs.*`（插件自己的文档库目录，路径不出主进程） |
| `search` | `appapi.search.*`（把插件内的条目注册给主面板搜索，v0.4.2 起） |
| `net` | `appapi.net.request`（v0.4.6 起；**还要在 manifest `hosts` 里声明可访问的域**） |
| `webview` | 在插件页使用 `<webview>` 嵌入第三方网页（v0.2.1 起） |

`window.hide` / `exit` / `info` / `onQuery` / `onShow` / `onHide` / `onDestroy` 不需要权限。

另外 `manifest.features` 是**功能声明**（不是权限）：目前只有 `inline`，决定插件能否接收
内联查询、回传搜索结果（见"内联结果"）。

### 嵌入第三方网页（webview）

声明 `webview` 权限后，插件页可直接使用 Electron 的 `<webview>` 标签内嵌任意网站
（官方翻译页、文档站等）。它不受 X-Frame-Options 限制（独立 guest 进程），
主进程会在 `will-attach-webview` 里校验权限并强制 guest 沙箱。
Vue 插件需在 vite 配置声明自定义元素：

```ts
vue({ compilerOptions: { isCustomElement: (tag) => tag === 'webview' } })
```

参考 `plugins/translator/`（多翻译引擎 + `{q}` URL 模板 + 懒创建 webview 保留状态）。

## 搜索贡献：让插件里的内容被主面板直接搜到（v0.4.2 起）

manifest 的 `keywords` 只能让「整个插件」被搜到。插件内部的东西（某本手册、某个章节、
某条笔记）要让用户一敲关键词就能直达，用搜索贡献协议：

```jsonc
// plugin.json
{ "permissions": ["search"] }
```

```ts
// 全量覆盖语义：每次推送都替换本插件的全部条目
await appapi.search.set([
  {
    id: 'manual:linux',                 // 插件内唯一，用于去重
    title: 'Linux 命令手册',             // 结果第一行
    subtitle: '35 章',                   // 第二行（仅展示，不参与匹配）
    keywords: ['linux', '命令', 'shell'], // 参与匹配的关键词
    group: '程序员手册',                 // 结果里的来源标签，默认插件名
    weight: 0,                          // 小的靠前（手册级 0、章节级 10）
    intent: { manualId: 'linux' }        // 回车打开插件时透传
  }
])
```

- 匹配规则与面板关键词一致（子串 / 通配符 / `re:`），**只匹配 `title` 与 `keywords`**；
- 单插件最多 300 条、每条最多 40 个关键词，超出的会被主进程裁掉；
- 主面板最多返回 8 条，单插件最多占 4 条，避免一个插件刷屏；
- 条目落盘在 `userData/search/<pluginId>.json`，**重启后无需插件先启动也能搜到**；
- 插件停了、手册停用了就重新 `set()` 一次（不推的条目自然消失），完全停用插件则
  主进程按 manifest 的 `disabled` 过滤。

打开时怎么接：面板选中条目后调用 `openPlugin(id, query, intent)`，插件侧照旧用
`appapi.onQuery` 收：

```ts
appapi.onQuery(({ query, intent }) => {
  if (intent?.manualId) openManual(intent.manualId, intent.chapterId)
  else if (query) runSearch(query)
})
```

**冷启动兜底**：插件没被打开过时还没推送过条目。想让"装完就能搜"，在插件目录放一份
构建期生成的 `search-index.json`（与 `search.set()` 的数组同构），主进程扫描时会读它；
插件一旦推送运行时条目，就整体覆盖静态索引。参考 `plugins/handbook/scripts/build-manuals.mjs`。

## 内联结果：输入即得（v0.4.7 起）

搜索贡献解决的是"内容能被搜到"，内联结果解决的是"算出来直接给"。声明后，面板**每敲一次键**
（防抖 140ms）就把查询推给插件，插件回一两行结果，直接显示在搜索结果最上方——不用打开插件。

```jsonc
// plugin.json
{ "features": ["inline"] }   // 注意：features 不是 permissions
```

```ts
appapi.onInlineQuery(async ({ seq, query }) => {
  const value = tryCompute(query)          // 算不出就算了，别抛错
  if (!value) return void appapi.inline.set({ seq, items: [] })
  await appapi.inline.set({
    seq,                                    // 必须原样带回，主进程靠它丢弃过期响应
    items: [
      {
        id: 'calc:' + query,
        title: value,                       // 第一行大字（结果本身）
        subtitle: query + ' =',             // 第二行（原始表达式）
        badge: '=',                         // 1~2 字符徽标，缺省用插件图标
        action: { type: 'copy', text: value }   // 回车复制；缺省是 open
      }
    ]
  })
})
```

| 约束 | 值 | 说明 |
|---|---|---|
| 响应时间 | ≤120ms | 超时这轮就当没结果；慢活儿请在插件里缓存（例如汇率先拉一次） |
| 条数 | 单插件 ≤2，总计 ≤4 | 内联区是"一眼可用"，不是列表 |
| 文本 | 标题 ≤120、副标题 ≤160、复制文本 ≤64KB | 超长截断/丢弃，不会撑爆界面 |
| 动作 | `copy` / `open` | `copy` 面板不关（连续取用）；`open` 打开插件并透传 `intent` |
| 门禁 | `features: ["inline"]` | 没声明就调 `inline.set` 会被网关拒绝（不是权限问题） |

**页面不用提前打开**：声明后插件视图会在第一次输入时被后台拉起（不影响主面板），
页面加载完若正好有搜索词，面板会自动补查一次——所以第一次输入也能看到结果。

参考 `plugins/calculator/`：输入 `2+3` 出 `5`，回车复制。

## 本地文档类插件（手册 / 笔记 / 速查）

插件页走 `plugin://<插件 id>/`（v0.4.5 起；更早是 `file://`），**自己目录里的文件可以直接
`fetch('data/list.json')` 读**（同源，不受 CORS 限制），但仍拿不到任何路径能力、也读不到别的插件。
"读本地文档"有两种正交做法，`plugins/handbook/` 两个都用了：

| 数据来源 | 做法 | 适用 |
|---|---|---|
| 随插件发布的文档 | 构建期用 vite 的 `?raw` 把 md 打进 bundle（`manual.json` → 生成 `src/data/manuals.generated.ts`） | 内置手册、离线速查 |
| 用户自己的文档 | `appapi.docs.import()` / `docs.list()` / `docs.read()`，文件由主进程收在自己命名空间 | 导入笔记、私有资料 |

> 什么时候用 `fetch` 而不是 `?raw`：数据量大、按需加载、或本身就是 json 配置时用 `fetch`；
> 想要首屏零请求、单文件发布、避免运行时 404 时用 `?raw`。

手册包格式（加一本手册 = 建目录 + `manual.json` + md，然后 `pnpm build:plugins`）：

```jsonc
// manuals/<name>/manual.json
{
  "id": "typescript",
  "title": "TypeScript 手册",
  "description": "一句话说明",
  "keywords": ["ts", "类型"],
  "order": 10,                       // 列表排序，小的在前
  "source": "https://...",           // 可选，界面里展示来源
  "license": "MIT",                   // 可选
  "chapters": [
    { "file": "basics.md", "title": "基础" }   // 省略 chapters 则按文件名排序自动收录
  ]
}
```

## external 型插件：集成外部程序

不需要写任何代码，一个 manifest 即可：

```jsonc
{
  "id": "com.launcher.vscode",
  "name": "VS Code",
  "type": "external",
  "command": "C:/Users/you/AppData/Local/Programs/Microsoft VS Code/Code.exe",
  "args": ["--new-window"],
  "keywords": ["code", "编辑器"],
  "permissions": []
}
```

- `command` 为 http(s) 链接时用默认浏览器打开；否则作为命令拉起（走 PATH 解析，`detached` 启动，不随启动器退出）。
- 面板中回车/点击后：外部程序启动，面板自动隐藏。
- 支持的 `command` 形态（面板「应用详情 → 编辑」里可以直接点**浏览…**从文件对话框挑，不用手打路径）：

  | 形态 | 行为 |
  |---|---|
  | `.exe` / `.com` / PATH 里的命令名（如 `notepad`） | 直接 `spawn`，参数按数组传，路径带空格不用加引号 |
  | `.bat` / `.cmd` | 经 `cmd` 解释启动（直接 spawn 会 EINVAL） |
  | `.lnk` | 交给系统 ShellExecute 打开；**启动参数不会生效**，需要参数请直接选目标程序 |
  | `http(s)://…` | 默认浏览器打开 |

  用户覆盖的 `command`/`args` 存在全局 `config.pluginOverrides` 里，插件文件不被修改，清空即恢复 manifest 默认值。

## 用 Vue 3 开发（与内置插件一致）

参考 `plugins/clipboard/` 与 `plugins/calculator/`：

- `vite.config.ts` 里 `base: './'`（插件页用相对路径加载资源，dev server 与打包后都能跑）
- manifest 和图标放 `public/`，构建后自动进入 `dist/`
- 构建产物 `dist/plugin.json` 会被扫描器识别

## 调试建议

- **热更新**：`pnpm dev:plugin <插件名>`（如 `pnpm dev:plugin handbook`）给单个插件起 vite dev server，
  启动器会自动把该插件入口切到 dev server，改 `.vue`/`.ts`/样式即时生效、页面状态保留。
  改了 `plugin.json` 走的是另一条路：构建出新的 `dist/plugin.json` 后由目录监听自动重扫（v0.4.9），
  不用重启应用，但已打开的页面仍跑旧代码，重开插件即生效；插件必须已构建过一次（要有 `dist/plugin.json`）。
  停止脚本（Ctrl+C）后视图会自动切回构建产物。
- 插件页是普通 Chromium 页面：开发期可以在插件入口代码里临时加 `console.log`，用 `pnpm dev` 启动后通过插件页的上下文查看（后续版本可加 remote debugging 端口）
- 插件崩溃不影响主程序：可在插件里调用 `process.crash?.()` 验证隔离
- 权限被拒会在控制台看到网关的错误信息，检查 `plugin.json` 的 `permissions`

## 安全须知

- 插件运行在沙箱渲染进程，没有 Node 能力；所有系统能力都必须走 `appapi` 并在 manifest 声明
- 插件页 origin 是 `plugin://<插件 id>`，且每个插件一个独立 session：cookie、`localStorage`、
  IndexedDB、缓存都不与其他插件共享（内嵌的 `<webview>` 也在同一分区）。因此
  **跨插件读文件会被拦**（`fetch('plugin://别的插件/…')` 直接失败），路径越界返回 403
- 摄像头 / 麦克风 / 定位 / 通知 / 串口等浏览器权限默认拒绝；要弹系统通知请用 `appapi.notify`
- 安装来路不明的插件 = 信任该插件申请的全部权限（后续市场版本会做权限确认弹窗）
