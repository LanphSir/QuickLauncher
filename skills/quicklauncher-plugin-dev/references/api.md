# QuickLauncher 插件 API 参考

> 本文档描述 web 型插件在沙箱渲染进程中可用的全部能力（`window.appapi`），对应 v0.6.5。
> 通道、入参/返回值与权限的唯一来源是 `src/shared/pluginApi.ts`（`PluginApiTypes` /
> `PLUGIN_PERMS` / `PluginApiSurface`）；权限校验与入参校验发生在主进程网关
> （`src/main/plugin/gateway.ts`），调用方身份由 webContents.id 锚定，伪造 payload 无效。
> 插件侧类型请直接引用 `src/shared/appapi.global.d.ts`，不要手写接口。

## appapi 全量签名

```ts
interface PluginApi {
  info(): Promise<{ id: string; name: string; version?: string; permissions: string[] }>
  /** 打开插件时的面板搜索词 / 搜索条目透传的 intent；注册前到达的事件由 preload 缓冲 */
  onQuery(callback: (payload: { query?: string; intent?: Record<string, unknown> }) => void): void

  /** 可见性（无需权限，v0.4.6 起）：注册时若已可见，onShow 会立即回调一次 */
  onShow(callback: () => void): void
  onHide(callback: () => void): void
  /** 视图即将被回收（v0.4.8 起）：约 400ms 后页面关闭，草稿在这里落盘 */
  onDestroy(callback: () => void): void

  /**
   * 内联查询（需 manifest features:["inline"]，v0.4.7 起）
   * 面板每次输入推一次；必须在 120ms 内用 inline.set 回，超时这轮就作废。
   */
  onInlineQuery(callback: (payload: { seq: number; query: string }) => void): void

  storage: {
    get(key: string): Promise<unknown>          // 无此 key 返回 null
    // 值必须可结构化克隆；单值 ≤2MB、单插件总计 ≤8MB，超配额会 reject 并说明已用/上限
    set(key: string, value: unknown): Promise<boolean>
    remove(key: string): Promise<boolean>
    keys(): Promise<string[]>
  }

  clipboard: {
    readText(): Promise<string>
    writeText(text: string): Promise<boolean>
  }

  notify(title: string, body?: string): Promise<boolean>   // 系统通知，title 缺省用插件名

  shell: {
    openExternal(url: string): Promise<boolean> // 仅 http(s)，否则网关抛错
  }

  /** 文档库（需 docs 权限）：目录由主进程持有，插件只拿句柄与内容，拿不到路径 */
  docs: {
    list(): Promise<Array<{ id: string; title: string; size: number; updatedAt: number }>>
    import(): Promise<{ ok: boolean; added: number; skipped: number; message?: string }>  // 弹文件框，可多选
    read(id: string): Promise<{ ok: boolean; text?: string; message?: string }>           // UTF-8 优先，GBK 回退，<=4MB
    remove(id: string): Promise<{ ok: boolean; message?: string }>
    reveal(): Promise<{ ok: boolean; message?: string }>                                  // 打开文档目录
  }

  /** 搜索贡献（需 search 权限）：把插件内条目注册到主面板，全量覆盖 */
  search: {
    set(entries: Array<{
      id: string
      title: string
      subtitle?: string        // 仅展示，不参与匹配
      keywords?: string[]     // 子串 / 通配符 / re: 正则，与面板关键词同规则
      group?: string          // 结果来源标签，默认插件名
      weight?: number         // 小的靠前，默认 100
      intent?: Record<string, unknown>  // 回车打开时经 onQuery 回传
    }>): Promise<number>      // 返回实际收录条数（最多 300，单条关键词最多 40）
    clear(): Promise<boolean>
  }

  /**
   * HTTP 请求（需 net 权限 + manifest.hosts 白名单，v0.4.6 起）
   * 走主进程转发，不受插件页 CORS 限制；重定向逐跳校验，跨白名单直接拒绝。
   */
  net: {
    request(request: {
      url: string
      method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'   // 默认 GET
      headers?: Record<string, string>       // host/cookie/content-length 等受控头会被丢弃
      body?: string                          // ≤2MB
      timeoutMs?: number                     // 默认 15000，上限 60000
    }): Promise<{
      ok: boolean                            // 2xx
      status: number
      headers: Record<string, string>
      body: string                           // 按 UTF-8 解码，≤4MB（超出截断）
      truncated?: boolean
      url?: string                           // 跟随重定向后的最终地址
    }>
    // 4xx/5xx 不抛错；网络错误、超时、白名单外 reject
  }

  /**
   * 内联结果（需 manifest features:["inline"]，v0.4.7 起）
   * 面板每敲一次键推一次查询（防抖 140ms），插件必须在 120ms 内回。
   */
  inline: {
    set(reply: {
      seq: number                             // 原样带回 onInlineQuery 收到的 seq
      items: Array<{
        id: string
        title: string                         // 第一行大字（结果本身），≤120 字
        subtitle?: string                     // 第二行说明，≤160 字
        badge?: string                        // 1~2 字符徽标，缺省用插件图标
        action?: { type: 'copy'; text: string }         // 回车复制（面板不关）
               | { type: 'open'; intent?: Record<string, unknown> }   // 回车打开插件（缺省）
      }>                                      // 单插件只用前 2 条
    }): Promise<number>                        // 返回实际采纳条数
  }

  /**
   * AI 能力（需 ai 权限）。除 onToolCall / tools 外，**其余通道都是 internalOnly**：
   * 只有随应用发布的内置插件（source === 'builtin'）能调，第三方插件声明了 ai 权限也调不通。
   */
  ai: {
    /** 流式增量。可注册多个订阅者（互不顶掉），返回退订函数 */
    onDelta(callback: (event: AiStreamEvent) => void): () => void
    send(request: AiSendRequest): Promise<AiSendResult>   // 只回"已受理"，内容走 onDelta
    stop(sessionId: string): Promise<SimpleResult>
    models(): Promise<AiModelOption[]>

    /** 已授权给 AI 的插件工具（未授权时为空数组，不是全部声明） */
    tools(): Promise<AiToolEntry[]>
    /**
     * 接收一次工具调用（v0.6.3）：需 ai 权限 + manifest 声明 ai.tools。
     * 返回字符串或 { ok, result?, error? }；抛错等于失败，主进程折成错误文本回给模型。
     * 超过工具声明的 timeoutMs 后主进程不再等这个回执。
     */
    onToolCall(callback: (call: AiToolCallRequest) => unknown | Promise<unknown>): void
    /** 回答一次风险确认（internalOnly，AI 插件页专用） */
    confirmTool(requestId: string, allow: boolean, remember?: boolean): Promise<SimpleResult>

    /** 附件（internalOnly）：pick 走原生对话框，attach 收拖拽字节 */
    pick(): Promise<AiAttachResult[]>
    attach(request: AiAttachBytesRequest): Promise<AiAttachResult>

    /** 会话（internalOnly） */
    sessions: {
      list(): Promise<AiSessionMeta[]>
      get(id: string): Promise<AiSessionDetail | null>
      create(model?: string): Promise<AiSessionDetail>
      rename(id: string, title: string): Promise<SimpleResult>
      remove(id: string): Promise<SimpleResult>
    }
  }

  window: {
    hide(): Promise<boolean>                    // 隐藏整个面板（等同失焦）
    detach(): Promise<{ ok, message? }>         // 分离为独立窗口（状态保留、任务栏可见；此后 exit=关窗）
  }

  exit(): Promise<boolean>                      // 退出当前插件，回面板主页（视图缓存保留）
}
```

## 权限表

| 权限 | 覆盖 API |
|---|---|
| `storage` | `appapi.storage.*`（单值 2MB / 单插件 8MB 上限） |
| `clipboard` | `appapi.clipboard.*` |
| `notify` | `appapi.notify` |
| `shell` | `appapi.shell.openExternal` |
| `docs` | `appapi.docs.*`（文档库读写，v0.4.0 起） |
| `search` | `appapi.search.*`（把插件内条目注册给主面板搜索，v0.4.2 起） |
| `net` | `appapi.net.request`（v0.4.6 起）；**还必须在 manifest `hosts` 声明可访问的域，否则一律拒绝** |
| `webview` | 插件页 `<webview>` 嵌入第三方网页（主进程 will-attach-webview 校验，guest 强制沙箱） |
| `ai` | 允许被 AI 调用（v0.6.2 起）：还要 manifest 写 `ai.tools` 路径、用户在 设置 → AI → AI 工具 里授权 |
| （无需权限） | `info` / `onQuery` / `onShow` / `onHide` / `onDestroy` / `window.hide` / `window.detach` / `exit` |

`features` 是另一条轴（功能形态，不是权限）：加 `"features": ["inline"]` 后才能调
`appapi.inline.set`，否则网关报"缺少功能声明"。
`PLUGIN_FEATURES` 里还有个 `"ai"`，但**当前没有任何门禁读它**——别把它当成开关，
门槛是 `permissions: ["ai"]` + `ai.tools` + 用户授权。

权限在 `plugin.json` 的 `permissions` 数组声明，例如 `"permissions": ["storage", "clipboard"]`。
`net` 还要配一个同级字段（支持精确域、`*.子域`、可选端口）：

```jsonc
{ "permissions": ["net"], "hosts": ["api.github.com", "*.example.com", "localhost:8080"] }
```

## ⚠ 跨桥传参限制（高频坑）

`window.appapi` 的所有调用经 contextBridge 跨世界传参，参数会被**结构化克隆**：
- Vue 的 `reactive`/`ref` Proxy **不能直接传**，报 `An object could not be cloned`
- 该错误在插件代码的 `await` 处抛出，后续代码全部不执行（极易误判成其他 bug）
- 正确姿势：存响应式状态前先 `JSON.parse(JSON.stringify(state))` 转纯数据
  （内置插件 clipboard/translator 中的 `plain()` 即此用途，写插件照抄即可）

## 生命周期与视图缓存

- 每个插件一个独立 `WebContentsView`（独立渲染进程），首次打开时创建并加载 `entry`。
- **退出插件（exit）不销毁页面**：视图进入缓存，再次打开恢复原状态（输入框内容、滚动位置都在）。
- 面板被再次唤起（快捷键/二次启动）时自动回到主页；插件视图仍在缓存。
- 面板窗口 resize 时插件视图自动跟随（v0.4.1 起视图四周让出 8px、顶部 46px 外框，不要自绘窗口控件；
  尺寸唯一来源是 `src/shared/pluginFrame.ts`）。
- 插件渲染进程崩溃：该实例被销毁并从缓存移除，主面板 toast 提示，其余插件不受影响。
- 视图按 LRU 保留最近 5 个（v0.4.8 起），被淘汰的插件会收到 `onDestroy`；页面的内存状态随之丢失，
  需要跨会话保留的东西一律写 `appapi.storage`。

**可见性事件（v0.4.6 起）**：因为退出不销毁，`onUnmounted` 永远不会触发——定时器/轮询必须
跟可见性走，否则插件切走后仍在后台空转（v0.4.6 之前的剪贴板插件就是每 800ms 读一次剪贴板）。

| 触发 | 事件 |
|---|---|
| 打开插件、面板重新显示、分离窗口从隐藏恢复 | `onShow` |
| 返回主界面、换到别的插件、面板收起（Esc/失焦/快捷键） | `onHide` |
| 分离为独立窗口 | 不触发（一直可见，只换宿主窗口） |
| 视图被 LRU 淘汰 | `onDestroy`（约 400ms 后关闭页面，可在此写最后一次存储） |

```ts
let timer: ReturnType<typeof setInterval> | undefined
const start = () => { if (!timer) timer = setInterval(poll, 800) }
const stop = () => { if (timer) { clearInterval(timer); timer = undefined } }
appapi.onShow(() => { void poll(); start() })  // 注册时已可见 → 立即回调
appapi.onHide(stop)
onUnmounted(stop)
```

## 数据隔离

storage 落盘在 `%APPDATA%/quick-launcher/data/<pluginId>/store.json`，
插件 id 是主进程根据调用方 webContents 确定的，插件无法读写其他插件的数据，也无法感知路径。

文档库同理：`%APPDATA%/quick-launcher/data/<pluginId>/docs/`，只能通过 `appapi.docs.*` 按
文件句柄访问，路径由主进程解析（句柄必须是纯文件名，`../` 与绝对路径会被拒）。

搜索条目落盘在 `%APPDATA%/quick-launcher/search/<pluginId>.json`，主进程写、主进程读，
插件只通过 `appapi.search.*` 提交数组，拿不到文件。

## 界面基线（v0.6.5 起）

插件页和主面板是同一块面板里的两块，视觉只认一份令牌：`src/shared/theme.css`。

```ts
// src/main.ts 第一行
import '../../../src/shared/theme.css'
```

这行同时提供 reset：漏掉它，`body` 默认 8px margin + 容器 `height: 100vh` 会让文档多出 16px，
表现为**滚动条常驻、怎么拉伸都在**。容器高度用 `100%`。

| 类别 | 令牌 |
|---|---|
| 文本四档 | `--text-1`（正文）/ `--text-2`（次要）/ `--text-3`（弱化）/ `--text-4`（占位） |
| 边框 | `--line` / `--line-strong` / `--line-soft` |
| 背景 | `--bg` / `--bg-soft` / `--bg-hover` / `--bg-active` |
| 主色 | `--accent` / `--accent-strong` / `--accent-hover` / `--accent-soft` / `--accent-line` |
| 语义色 | `--danger*` / `--warn*` / `--ok*` |
| 圆角 | `--r-xs`(6) / `--r-sm`(8) / `--r-md`(10) / `--r-lg`(14) / `--r-xl`(18) |
| 阴影 | `--shadow-1`（贴近）/ `--shadow-2`（浮层）/ `--shadow-3`（模态） |

组件里不写字面量色值；要新的语义色先加到 `theme.css`。全局 `:focus-visible` 已画焦点环，
输入框自己画焦点态时用 `box-shadow: none` 覆盖，别叠两层。

破坏性操作（删除 / 清除数据 / 卸载）不要放进按钮行：收进 `···` 菜单 + 右键菜单，
并走自绘确认框（默认焦点在「取消」）。插件页现成实现见 `plugins/ai/src/components/`
的 `PopMenu.vue` / `ConfirmDialog.vue`（宿主那份在 `src/renderer/src/components/`，
跨构建不能复用，抄结构即可）。不要用 `window.confirm`，插件页也不要引 naive-ui。

## AI 工具回执（`ai.onToolCall`，v0.6.3 起）

链路：模型发 `tool_calls` → 主进程校验参数与风险 → 必要时弹确认 → 插件页执行 →
回执折成 `tool-result` 回给模型。一轮最多 4 个工具轮次 / 8 次调用；结果超 4000 字截断。

```ts
appapi.ai.onToolCall(async (call) => {
  // call: { callId, name, args }  name 是插件内短名，args 已过 schema 校验
  if (call.name !== 'calculate') return { ok: false, error: `没有这个工具：${call.name}` }
  return `计算结果：${evaluate(String(call.args.expression ?? ''))}`
})
```

| 事实 | 说明 |
|---|---|
| 回执是 `plugin:ai.tool.reply` | 全项目 `plugin:ai.*` 里**唯一**不标 internalOnly 的通道——第三方插件正是被调用的那方 |
| 名字是短名 | 全局名 `plugin:<插件 id>:<name>` 只给模型看，执行时主进程按 callId 反查插件，不接受模型自己拼 |
| 超时 | 工具声明的 `timeoutMs`（1000–60000，缺省 8000）；到期主进程不再等 |
| 确认 | `write`/`dangerous` 由主进程弹卡片，**插件不要再弹一次**；`dangerous` 无「本次会话不再询问」 |
| 授权 | 设置 → AI → AI 工具 按插件开开关，撤销立即生效（每次下发现算，不缓存） |
| 预热 | 插件页未加载时宿主会懒建一次；页面加载完之前调用收不到 |

`ai/tools.json`、`ai/SKILL.md`、`ai/mcp.json` 的字段与限制见 `docs/plugin-dev-guide.md`
的「让 AI 能用你的插件」一节；MCP 命令的确认与指纹绑定见同文「接一个现成的 MCP server」。

## 搜索贡献（让插件内的条目被主面板搜到）

manifest 关键词只覆盖"整个插件"。要让插件内部条目（章节、笔记、历史记录）可直达：

1. 声明 `"permissions": ["search"]`
2. 启动/数据变化后 `appapi.search.set(entries)`（全量覆盖，不推送自然消失）
3. 条目里带 `intent`；用户回车时主进程把该条目的 intent 通过 `onQuery` 回传，插件据此定位
4. 想让插件"没打开也能搜到"，把构建期生成的同构数组放 `search-index.json` 到插件目录，
   主进程扫描时读取；运行时 `set()` 会整体覆盖静态索引

范例：`plugins/handbook`（手册级 weight 0 + 章节级 weight 10，构建期产出静态索引）。
详细字段与限制见 `docs/plugin-dev-guide.md` 的"搜索贡献"一节。

## 内联结果（`features: ["inline"]`，v0.4.7 起）

与搜索贡献的区别：搜索贡献是"内容能被搜到"，内联是"算出来直接给"——用户不用打开插件。

```jsonc
{ "features": ["inline"] }        // 功能声明，不是 permissions
```

```ts
appapi.onInlineQuery(async ({ seq, query }) => {
  const value = tryCompute(query)              // 算不出就回空，别抛错
  if (!value) return void appapi.inline.set({ seq, items: [] })
  await appapi.inline.set({
    seq,
    items: [{ id: query, title: value, subtitle: query + ' =', badge: '=', action: { type: 'copy', text: value } }]
  })
})
```

- **120ms 预算**：超时这轮就作废，面板不会等；慢数据自己缓存（汇率先拉一次再本地换算）
- **单插件 ≤2 条、总计 ≤4 条**；标题 120 字、副标题 160 字、复制文本 ≤64KB
- **seq 必须原样带回**：主进程靠它丢弃过期响应（键击比插件快是常态）
- **页面不用提前打开**：第一次输入时主进程会在后台拉起视图，加载完若有搜索词会自动补查一次
- 动作：`copy`（写剪贴板、面板不关）或 `open`（打开插件并透传 intent）；不写按 `open`

范例：`plugins/calculator`（`2+3` → `5`，回车复制）。

## 本地文档类插件（自己目录可 fetch，用户文档走 docs）

插件页 origin 是 `plugin://<插件 id>`（v0.4.5 起；更早是 `file://`），所以
**自己目录里的文件可以直接 `fetch('data/list.json')`**（同源、无 CORS 问题）；
跨插件的 `plugin://` 地址会被 session 层拦截，路径越界返回 403。

随插件发布离线内容的两种做法：

| 做法 | 说明 |
|---|---|
| `fetch('manual.md')` | 运行时按需读，适合大文件/按章加载；注意打包时文件要真在 `dist/` 里（放 `public/`） |
| vite `?raw` 构建期打包 | 首屏零请求、单文件发布；`plugins/handbook` 的 `scripts/build-manuals.mjs` 是现成范例（扫 `manuals/*/manual.json` → 生成 `src/data/manuals.generated.ts`） |

用户自己导入的文档走 `appapi.docs.*`（文件在主进程的插件命名空间里）。

## 关键词高级匹配（manifest.keywords）

- 普通字符串：查询词**包含**该关键词即命中（不区分大小写）
- 通配符：含 `*` / `?` 时与**整个查询词**匹配（`*` 任意串、`?` 单字符）
- 正则：`re:` 前缀，其余部分作为正则对整个查询词 `test`，如 `re:^[a-zA-Z][a-zA-Z0-9@._\- ]{1,120}$`
  让用户输入任意英文都命中（翻译插件即此用法）；非法正则静默跳过

## 范例：接收搜索词 + 翻译（节选自 plugins/translator）

```ts
onMounted(() => {
  // 打开插件时自动翻译面板输入的英文
  window.appapi.onQuery(({ query }) => {
    if (query?.trim()) { input.value = query.trim(); void translate() }
  })
})
```

## 范例：Esc 退出 + 轮询剪贴板（节选自 plugins/clipboard）

```ts
import { onMounted, onUnmounted, ref } from 'vue'

const items = ref<string[]>([])
let last = ''

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  const saved = await window.appapi.storage.get('history')   // 声明了 storage
  if (Array.isArray(saved)) items.value = saved as string[]
  last = await window.appapi.clipboard.readText()            // 声明了 clipboard
  setInterval(async () => {
    const text = await window.appapi.clipboard.readText()
    if (text && text !== last) { last = text; items.value = [text, ...items.value].slice(0, 100) }
  }, 800)
})

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') void window.appapi.exit()
}
```

> 上面这段少了可见性处理，只为展示 API 用法。真实插件必须换成
> `onShow` 起、`onHide` 停——否则切走后还在每 800ms 读剪贴板。

## manifest 完整字段

```jsonc
{
  "id": "com.launcher.example",        // 必填，/^[\w.-]+$/，全库唯一
  "name": "示例",                       // 必填，面板显示名
  "version": "0.1.0",                  // 可选
  "description": "一句话说明",           // 可选，悬浮提示
  "type": "web",                       // 必填：web | external
  "entry": "index.html",               // web 型必填，相对插件目录（构建后即相对 dist）
  "command": "notepad.exe",            // external 型必填；http(s) 则走默认浏览器
  "args": ["--new-window"],            // external 型可选
  "keywords": ["example", "示例"],      // 建议提供，面板搜索
  "permissions": ["storage"],          // 建议显式声明（即使为空数组）
  "features": ["inline"],              // 可选：功能形态（inline 有门禁，ai 目前没有）
  "hosts": ["api.example.com"],        // net 权限必填
  "hotkey": "Alt+Shift+V",             // 可选：建议启动键，不自动注册
  "apiVersion": 2,                     // 可选：认识 v0.6 的 window / ai 字段
  "window": { "width": 1040, "height": 740 },                    // 可选：建议尺寸
  "ai": { "tools": "ai/tools.json", "skill": "ai/SKILL.md", "mcp": "ai/mcp.json" }  // 可选
}
```

校验规则（`src/main/plugin/manager.ts` + `manifestAi.ts`）：
- `id` / `type` / `name` / `entry`（web）/ `command`（external）任一缺失或非法 → 打印
  `[plugin] 跳过 <dir>: 原因` 并忽略该插件；id 与已有插件冲突 → 后扫到的跳过
- `hosts` / `features` / `hotkey` / `window` / `ai` 是"坏一项只丢一项"，插件照常加载
- `apiVersion` 缺省按 1；高于 2 时按 2 处理
