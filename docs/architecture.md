# QuickLauncher 架构说明

一个全局快捷键唤起的插件化桌面工具面板（类 uTools），Windows 优先。

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面框架 | Electron 38 + TypeScript |
| 构建 | electron-vite（main/preload/renderer 三端一体） |
| 主面板 UI | Vue 3 + Pinia + Naive UI |
| 插件 UI | Vue 3（每插件独立 vite 构建，产物为纯静态资源） |
| 包管理 | pnpm workspaces（根应用 + `plugins/*` 子包） |
| 打包 | electron-builder（NSIS 安装包） |

## 进程模型

```
┌─ 主进程（src/main）──────────────────────────────┐
│ index.ts        入口：单实例锁、装配、面板 IPC        │
│ config.ts       全局配置（userData/config.json）      │
│ hotkey.ts       全局快捷键注册/冲突回滚               │
│ tray.ts         托盘菜单（显示/自启/退出）             │
│ windows/panel      无边框透明主面板（失焦隐藏）         │
│ windows/pluginHost 每插件一个 WebContentsView 宿主      │
│ plugin/manager     扫描插件目录、校验 manifest、注册表   │
│ plugin/gateway     插件 API 网关（身份+权限+入参校验）  │
│ plugin/api/*       能力定义（defineApi，一能力一文件）    │
│ plugin/protocol    plugin:// 自定义协议（按 id 读插件目录）│
│ plugin/sessions    每插件独立 session（cookie/存储/缓存） │
│ plugin/callerRegistry  webContents→插件 身份映射        │
│ plugin/inline      内联结果调度（后台查询 + 120ms 超时） │
│ plugin/watcher     插件目录监听（manifest/dist 变更免重启）│
│ services/storage   按插件隔离的 JSON 存储               │
│ services/docs      按插件隔离的文档库（docs 权限）        │
│ services/searchIndex 搜索条目索引（运行时 + 落盘 + 静态） │
│ services/external  external 型插件拉起（spawn/shell）   │
├─ 主面板渲染进程（src/renderer）───────────────────┤
│ 搜索框 / 已固定网格 / 全部应用 / 设置（Vue3 + Pinia） │
├─ 插件渲染进程 × N（每插件独立 WebContentsView）─────┤
│ sandbox:true + contextIsolation:true                │
│ preload 注入受控 window.appapi                      │
└──────────────────────────────────────────────────┘
```

## 插件协议

插件 = 一个含 `plugin.json` 的目录。扫描位置：

- 开发模式：`<项目根>/plugins/`（子目录本身含 plugin.json，或其 `dist/` 内含）
- 打包后：`<resources>/plugins/builtin/`（由 `scripts/collect-plugins.mjs` 收集）

```jsonc
// plugin.json
{
  "id": "com.launcher.clipboard",   // 必填，反向域名，/[\w.-]+/
  "name": "剪贴板历史",              // 必填
  "type": "web",                     // 必填：web | external
  "entry": "index.html",             // web 型必填，相对插件目录
  "command": "notepad.exe",          // external 型必填（exe 路径/命令或 http(s) URL）
  "args": [],
  "keywords": ["clip", "剪贴板"],    // 搜索关键词
  "permissions": ["storage", "clipboard", "notify"]
}
```

图标：目录下 `icon.svg` / `icon.png` / `icon.ico` 任一，主进程转 dataURL 下发。

## 插件能力契约与注册表（v0.4.3）

以前加一个 API 要改四处（网关通道 + `PERMS` 表 + preload 暴露 + 每个插件的 `env.d.ts`），
漏一处就是"注册了通道忘挂权限"或"类型与实现各说一套"。v0.4.3 起改成**契约 + 注册表**：

| 层 | 位置 | 职责 |
|---|---|---|
| 契约 | `src/shared/pluginApi.ts` | `PluginApiTypes`（通道 → 入参/返回值）、`PLUGIN_PERMS`（通道 → 权限）、`PluginApiSurface`（`window.appapi` 形状）。纯类型与常量，不 import electron/node |
| 定义 | `src/main/plugin/api/*.ts` | 一能力一文件：`defineApi('plugin:xxx', { parse, handle })`，`parse` 负责把不可信 payload 校验并归一化为契约入参 |
| 校验 | `src/main/plugin/api/validate.ts` | 组合子：`str` / `optional` / `httpUrl` / `jsonValue` / `object`（白名单取字段，多余键丢弃）/ `int` / `oneOf` / `stringRecord` |
| 网关 | `src/main/plugin/gateway.ts` | 只做三件事：身份锚定 → 权限校验（查 `PLUGIN_PERMS`）→ 入参校验后交给 handler。**不出现任何具体通道名** |
| 桥 | `src/preload/plugin.ts` | `api: PluginApiSurface` 显式标注 + `invoke<C>` 泛型，少一个方法就编译不过 |
| 插件 | `src/shared/appapi.global.d.ts` | 把 `PluginApiSurface` 挂到全局 `window.appapi`，插件 `env.d.ts` 一行 `/// <reference path="../../../src/shared/appapi.global.d.ts" />` 即可 |

新增通道的完整成本：契约里加 1 条类型 + 权限表加 1 行 → `api/<域>.ts` 加 1 条 `defineApi` →
preload 加 1 个方法。网关、渲染层、插件类型都不用动。

入参上限（网关层拦截，超限直接 reject）：

| 通道 | 限制 |
|---|---|
| `storage.set` | key ≤ 200 字符且禁用 `__proto__`/`constructor`/`prototype`；value 序列化后 ≤ 2MB（主进程同步写盘，放任会卡 UI） |
| `clipboard.writeText` | ≤ 2MB |
| `notify` | title ≤ 120、body ≤ 2000 字符 |
| `shell.openExternal` | 仅 http(s)、≤ 2048 字符 |
| `docs.read/remove` | 句柄 ≤ 255 字符且不含路径分隔符（`services/docs` 再做 basename + 扩展名校验） |
| `search.set` | 透传给 `services/searchIndex.normalizeEntries` 校验裁剪（≤300 条等） |
| `net.request` | url ≤ 2048 且仅 http(s)；method 限 7 个动词；请求头 ≤ 32 条、键 ≤ 64 字符、值 ≤ 4096 字符（`host`/`cookie`/`content-length` 等受控头直接丢弃）；请求体 ≤ 2MB；超时 1~60s；响应体 ≤ 4MB（超限截断返回） |

## 网络能力（v0.4.6，`net` 权限 + `hosts`）

插件页的 origin 是 `plugin://<id>`，直接 `fetch` 三方 API 会被 CORS 拦；把 `webSecurity`
关掉是不可接受的。所以 HTTP 统一由主进程转发，授权分两层：

```
manifest: { "permissions": ["net"], "hosts": ["api.github.com", "*.example.com", "localhost:8080"] }
                ↓ 网关                      ↓ api/net.ts 逐跳校验
       有 net 权限才允许调用     目标 host 必须在 hosts 内（含每一跳重定向）
```

| 环节 | 做法 |
|---|---|
| 实现 | `net.request`（不是 `net.fetch`）：需要 `redirect` 事件才能逐跳裁定 —— `net.fetch` 的 `redirect: 'manual'` 在 Electron 里会直接以 "Redirect was cancelled" 失败 |
| 白名单 | 精确 host、`*.example.com`（含裸域）、可选端口；缺省/空 = 一个都不许 |
| 身份 | `credentials: 'omit'`，插件拿不到主面板与其他分区的 cookie |
| 响应 | 边读边计数，4MB 截断并标记 `truncated`；`status`/`headers`/`url`（跟随后的最终地址）一并返回 |
| 失败语义 | 网络错误/超时 reject；4xx/5xx 正常返回（`ok: false`），与 `fetch` 一致 |

## 生命周期事件（v0.4.6 起 `onShow` / `onHide`，v0.4.8 加 `onDestroy`）

视图退出后只从窗口摘掉、不销毁（保留状态），所以插件的 `onUnmounted` 永远不会触发——
以前剪贴板插件退出后仍在后台每 800ms 读一次剪贴板。v0.4.6 起主进程在**真正变化**时推
`plugin:lifecycle`（`{ state: 'show' | 'hide' | 'destroy' }`）：

| 触发 | 事件 |
|---|---|
| 打开插件 / 面板重新显示 / 分离窗口从隐藏恢复 | `show` |
| 返回主界面、换到别的插件、面板收起（Esc/失焦/快捷键） | `hide` |
| 分离为独立窗口 | 不推（一直可见，只是换了宿主窗口） |
| 视图被 LRU 淘汰（见下节） | `destroy`（约 400ms 后页面关闭） |

preload 的初始态是 `show`，且 `onShow` 注册时若已可见会**立即回调一次**，
所以"启动轮询"可以直接写进 `onShow`，不必在 `onMounted` 里再写一遍。

### 常驻视图上限（LRU，v0.4.8）

每个 `WebContentsView` 都是一个独立渲染进程，不封顶的话"每个插件点一次"就能堆出几百 MB。
`viewCache` 按 LRU 保留最近 `MAX_RESIDENT_VIEWS = 5` 个，超出时淘汰最久未用的：

- 不淘汰：当前激活的、分离到独立窗口的、声明了 `features: ["inline"]` 的（它们靠常驻换"输入即得"）；
- 淘汰前先推 `destroy`，插件有 400ms 用最后一次 `storage.set` 落盘；
- 宽限期内又打开该插件 → 撤销淘汰，页面状态完整保留（不会变成"刚打开就白屏"）；
- 被淘汰的不是"卸载"，只是下次打开重新加载页面。

## 存储分片与写盘（v0.4.8）

`userData/data/<pluginId>/shards/<hash>-<slug>.json`：一个 key 一个文件、原子写（临时文件 + rename）。
写盘按插件防抖 250ms 合并，退出前统一 flush——插件在输入框里每敲一个字就 `set` 一次也不会把磁盘打满。
旧版的 `store.json` 在首次读取时自动迁移为分片，原文件改名为 `store.json.migrated`。

### 总量配额（v0.4.9）

单值上限 2MB 挡不住"多存几个大键"，所以另有**单插件总量上限 8MB**：

- 内存里按 key 记账分片字节数，写入前 O(1) 判断；覆盖已有键会先扣掉旧值（改小不该被旧体积拖累）；
- 超限时 `storage.set` **抛错**并给出「已用 x / 上限 y」，网关把错误原样送到插件侧 `catch`；
  返回 `false` 会让插件以为存上了，这种"静默失败"比报错难查得多；
- `QUICKLAUNCHER_PLUGIN_STORE_LIMIT_MB` 可改（`0` = 关闭配额），`pluginStorage.usage()` 可查当前占用。


## 内联结果（v0.4.7，`features: ["inline"]`）

目标：插件从"打开一个 App"变成"输入即得"——`2+3` 直接在搜索框下给出 `5`，回车复制。

```
manifest: { "features": ["inline"] }
   ↓ 面板每敲一次键（防抖 140ms）
panel:inline → plugin/inline → 后台 WebContentsView 发 plugin:inline-query { seq, query }
   ↓ 插件算完（必须 ≤120ms）
appapi.inline.set({ seq, items }) → 主进程按 seq 匹配 → 返回条目 → 面板渲染在第一段
```

| 设计点 | 做法 | 原因 |
|---|---|---|
| 后台视图 | 复用 `pluginHost.ensureEntry`，但**不挂到面板**上 | 同一份页面既能被内联唤醒，也能被用户正式打开，状态连续 |
| 超时 | 单次最多等 120ms，没回就当这次没有 | 搜索必须跟手，宁可少一条结果也不能卡输入 |
| 不排队 | 同一插件上一轮未回就地作废，只认最新 seq | 键击比插件快是常态，排队只会积累过期结果 |
| 页面未就绪 | 本次跳过，并挂一次 `did-finish-load` → `panel:inline-ready` → 面板用当前词**补查一次** | 否则首屏加载期间输入会"第一次没结果、再打一个字才有" |
| 上限 | 单插件 ≤2 条、总计 ≤4 条；标题 120 字、副标题 160 字、复制文本 ≤64KB | 内联区是"一眼可用"，不是列表 |
| 门禁 | `features` 是**功能**声明，不是权限；未声明调 `inline.set` 直接被网关拒 | 与 `permissions` 语义分开：前者是形态，后者是能力 |
| 动作 | `copy`（写剪贴板、面板不关）/ `open`（打开插件并透传 intent）；缺省 `open` | 复制是高频路径，关面板会打断连续取用 |

调试：`window.panel.inline('<query>')` 可在面板上下文直接取一次内联结果（冒烟脚本用的就是它）。

## 隔离机制（互不干扰）

1. **进程隔离**：每个 web 插件独立 `WebContentsView`（独立渲染进程），单个插件崩溃只影响自身（`render-process-gone` → 移除该实例 → 面板 toast，其余不受影响）。
2. **上下文隔离**：`sandbox: true` + `contextIsolation: true`，插件拿不到 Node/Electron 原生 API，只能通过 preload 暴露的 `window.appapi`。
3. **权限模型**：manifest `permissions` 声明，网关逐调用校验（storage/clipboard/notify/shell/docs/search/net），未声明直接拒绝；窗口控制（hide/exit/info）无需权限。权限表只有一份（`src/shared/pluginApi.ts` 的 `PLUGIN_PERMS`），网关从它取，不再手写第二份映射。`net` 还多一层 manifest `hosts` 域白名单（见"网络能力"）。
   **功能声明**（`features`）是另一条轴：`inline` 决定插件能否回传内联结果，网关按通道定义里的 `feature` 字段校验（见"内联结果"）。
4. **数据隔离**：存储强制命名空间 `userData/data/<pluginId>/`（分片文件），插件无法访问其他插件数据。
5. **来源隔离（v0.4.5）**：插件页走自定义协议 `plugin://<插件 id>/…`，每个插件一个真实 origin；同时每个插件一个独立 session（`persist:plugin:<id>`），cookie / localStorage / IndexedDB / 缓存互不可见，插件内嵌的 `<webview>` 也落在同一分区。
6. **加载隔离**：只从固定插件根目录扫描，manifest 校验失败即跳过，id 冲突先到先得。

## 插件协议与分区（v0.4.5）

```
plugin://com.launcher.handbook/index.html
└─ host = 插件 id（唯一寻址单元）      └─ 相对插件目录（rec.dir）的路径
```

| 环节 | 实现 | 说明 |
|---|---|---|
| scheme 特权 | `protocol.registerSchemesAsPrivileged` | `standard`（origin 完整）+ `secure`（安全上下文）+ `supportFetchAPI` + `corsEnabled` + `stream`；必须在 app ready 前调用 |
| 请求处理 | `plugin/protocol.ts` 的 `protocol.handle` | 按 host 找插件 → 解析到 `rec.dir` 内 → 交给 `net.fetch(file://…)` 读盘（MIME/Range/流式由 Chromium 处理） |
| 路径守卫 | 解析后必须仍在 `rec.dir` 内；拒绝 `.` 开头的路径段 | `..%2f..%2fpackage.json` → 403，`.git/config` → 403 |
| 跨插件 | session 级 `webRequest.onBeforeRequest` 取消非本插件 host 的 `plugin://` 请求 | 自定义协议的响应由主进程直接产生，Chromium 不做 CORS 校验，只能在会话层兜；handler 内另按 `referrer` 复核一次 |
| 分区 | `partition: persist:plugin:<id>` | `userData/Partitions/plugin%3A<id>/`；「清除插件数据」同时清该插件的分片目录与该分区存储 |
| 权限 | 分区级 `setPermissionRequestHandler` 默认拒绝 | 放行 `clipboard-sanitized-write` / `fullscreen` / `pointerLock`，其余（摄像头、定位、通知、串口…）拒绝，要弹通知走 `appapi.notify` |

由此带来的三个能力变化：

1. **同源 fetch 可用**：插件对自己目录里的 json/md 直接 `fetch('data/list.json')`，不必再靠构建期 `?raw` 打包（既有手册包仍是 `?raw`，离线更稳，不必改）。
2. **存储按插件天然隔离**：`localStorage` 的 origin 是 `plugin://<id>`，不再与别的插件共用一份。
3. **第三方站点登录态互不串**：翻译类插件内嵌网页拿到的 cookie 只在该插件的分区里。

> 迁移提示：0.4.5 之前插件页是 `file://`，那时写进 `localStorage` 的数据在新 origin 下读不到。
> 内置插件没有用浏览器存储（一律走 `appapi.storage`），第三方插件若用过需要自行迁移。

## 插件文档库（docs 权限，v0.4.0）

插件拿不到任何路径能力（铁律 4），但"让用户把自己的文档丢进来"是刚需。折中做法：
**主进程持有目录，插件只按文件句柄收发内容**。

| 通道 | 行为 |
|---|---|
| `plugin:docs.list` | 列出 `data/<pluginId>/docs/` 下的 md/markdown/txt |
| `plugin:docs.import` | 弹系统文件框（可多选），拷贝进该目录，重名自动 `-2` |
| `plugin:docs.read` | 读文本，UTF-8 优先、出现替换字符回退 GBK；上限 4MB |
| `plugin:docs.remove` | 删除（句柄必须是纯文件名，挡 `../` 与绝对路径） |
| `plugin:docs.reveal` | 在资源管理器打开目录；不把路径回传给插件 |

五个通道都映射到 `docs` 权限，未声明的插件调用即拒绝。

内置手册插件（`plugins/handbook`）只把这套 API 用于"用户导入的文档"；随插件发布的
手册正文走构建期打包（`.md` 经 vite `?raw` 进 bundle），保证离线可读且首屏零请求。
（v0.4.5 起插件页是 `plugin://`，运行时 `fetch('xx.md')` 已经可用，见"插件协议与分区"。）

## 搜索贡献（search 权限，v0.4.2）

面板搜索原本只认 manifest 关键词，粒度是「整个插件」。v0.4.2 起插件可把**内部条目**
注册给启动器，用户搜「linux」直接命中手册条目、回车直达对应章节。

| 通道 | 行为 |
|---|---|
| `plugin:search.set` | 全量替换该插件的条目（校验 + 裁剪：≤300 条、关键词 ≤40 个、文本 ≤120 字） |
| `plugin:search.clear` | 清空运行时与落盘条目 |

条目来源三级，优先级从高到低：

1. **运行时**：插件 `appapi.search.set()` 推送（能反映停用状态、用户改过的关键词）
2. **落盘**：`userData/search/<pluginId>.json`，重启后不依赖插件先启动
3. **静态**：插件目录下的 `search-index.json`（构建期生成），覆盖"装完还没打开过"的冷启动

检索在主进程做（`services/searchIndex.ts`），面板每次输入经 `panel:search` 查一次；
匹配规则放 `src/shared/search.ts`，与渲染层的插件关键词匹配共用一份实现。返回上限
8 条、单插件最多 4 条，避免手册类插件把其他结果挤掉。

打开路径：条目里的 `intent` 由面板随 `panel:open-plugin` 传给主进程，再经
`plugin:query` 送到插件（`appapi.onQuery` 的 `payload.intent`），插件据此定位内容。

## 插件宿主行为

- 进入插件：面板窗口 `contentView.addChildView(view)`，插件页**嵌在启动器提供的外框里**（顶部 46px 工具条 + 四周 8px 留白），不再铺满整窗；退出后视图**保留在缓存**，重进恢复原状态。
- 外框由面板渲染层画（`PluginFrame.vue`），提供"返回主界面 / 独立窗口 / 关闭"；`src/shared/pluginFrame.ts` 是主进程算视图矩形与渲染层排版的唯一尺寸来源，改尺寸只改这里。
- 进插件时面板自动伸展（默认 ≥980×720，上限工作区 94%，只放大不缩小）并**居中到屏幕**，退出时还原主页尺寸；插件页里调过的尺寸记进 `config.pluginBounds`，下次进插件沿用。
  - 主页贴在唤起位置（纵向 16% 处，像输入框"掉下来"），插件页是要连续看/操作的窗口，端在屏幕正中；
  - 尺寸与居中都是纯计算（`windows/panelLayout.ts`），单测覆盖"只放大不缩小""94% 封顶""多屏偏移"这些边界。
- 窗口 resize 时按 `pluginViewRect()` 同步视图 bounds；视图带白底与 10px 圆角，边缘留白同时是自实现缩放热区的作用带（视图贴着窗口边界时热区收不到指针事件）。
- 面板唤起（快捷键/二次启动）自动回到主页；Esc 在插件内 → `appapi.exit()`。

## 插件开发热更新（v0.4.4）

插件页的常规加载路径是 `plugin://<插件 id>/index.html`（v0.4.5 起，之前是 `file://`），
改代码必须重新构建——这是插件开发最慢的一环。v0.4.4 起增加一条**只在本机开发期
生效**旁路：插件入口换成 vite dev server，页面拿到 HMR。

```
pnpm dev:plugin handbook      # 起 plugins/handbook 的 vite dev server
        ↓ 解析 vite 输出的真实端口（先剥 ANSI 颜色码，URL 会被颜色码打断）
.dev-plugins.json             # { "com.launcher.handbook": "http://localhost:5173/", "_updatedAt": ... }
        ↓ 主进程轮询文件原文变化（watchFile）
scanPlugins() → rec.devUrl    # 打包版 readDevServers() 直接返回 {}，绝不生效
        ↓
pluginEntryUrl() = devUrl + "?__plugin=<id>"   # 标记便于调试与冒烟识别
reloadPluginViews()           # 已缓存的视图换源重载，不重启应用
```

边界与兜底：

| 情况 | 行为 |
|---|---|
| 改了 `.vue` / `.ts` / 样式 | vite HMR 即时生效，页面状态保留 |
| 改了 `plugin.json`（manifest） | 不在 vite HMR 范围（HMR 只换页面模块）。构建产物或插件目录里的 manifest 被写入后由目录监听自动重扫（v0.4.9），不必重启；已打开的页面仍跑旧代码，重开即生效 |
| 没构建过 `dist/plugin.json` | 扫描器看不到插件，脚本启动时就会提示 |
| 停止 dev server（Ctrl+C） | 脚本清理登记项 → 主进程重扫 → 视图自动切回构建产物（`plugin://<id>/index.html`） |
| dev server 被强杀（登记项残留） | 加载失败时 `did-fail-load` 回退到构建产物并打 warn，不把用户卡在错误页 |
| 同端口重启 dev server | 脚本更新 `_updatedAt`，主进程按**文件原文**判断变化（比映射可靠），视图自动切回 dev |
| 打包版 | `app.isPackaged` 时既不读也不监听该文件 |

`?__plugin=<id>` 标记同时解决了一个测试问题：冒烟脚本原本靠 `plugins/<name>/dist/index.html`
识别插件页，开了 dev server 后会全部找不到——现在按标记识别，两种来源都能跑。

## 插件目录监听（v0.4.9）

`pnpm dev` 之外的常见场景是"把插件目录丢进 `plugins/` 或 `plugins/installed/`"，
以前必须重启应用。现在 `plugin/watcher.ts` 盯着：

| 监听对象 | 过滤 | 用途 |
|---|---|---|
| 每个插件根目录 | 事件全部收 | 新插件目录出现 / 卸载后空目录消失 |
| 每个插件目录 | 只看 `plugin.json`、`dist` | manifest 改动、构建出 dist 的那一刻 |
| 每个插件目录的 `dist` | 只看 `plugin.json` | 构建完成的判定点 |

事件 300ms 合并（一次保存往往触发 change + rename 两条，构建更是几十条），
随后走与 dev server 监听同一条链路：`scanPlugins()` → `refreshPluginRecords()` → 刷托盘 → 通知面板。

`refreshPluginRecords()` 是这一步的关键：它把已打开视图的 `rec` 换成新记录、重新登记
`callerRegistry`（权限与名称都可能变了），入口 URL 变了就换源重载，插件目录被删掉的视图直接销毁。
只重扫不刷新的话，注册表是新的、页面还在用旧 manifest —— 改了权限却仍被拒，看起来像"没生效"。

打包版只监听用户安装目录：内置插件躺在安装目录里不会变，少两个句柄也少两条噪声事件。

## 数据与配置

```
<userData>/                       %APPDATA%/quick-launcher/
├─ config.json                    全局配置（hotkey/autostart/pinnedIds）
├─ data/<pluginId>/shards/*.json  各插件独立数据（一 key 一片）
├─ data/<pluginId>/docs/          各插件文档库（documents API，手动拖文件也可）
├─ search/<pluginId>.json         插件推送的搜索条目（重启后仍可搜）
```

## 构建

```bash
pnpm dev          # 构建内置插件后启动开发模式
pnpm build        # electron-vite 构建 main/preload/renderer
pnpm build:plugins
pnpm dist         # 插件收集 → 构建 → electron-builder 出 Windows 安装包（release/<version>/）
node scripts/gen-icons.mjs   # 重新生成 build/icon.ico 与托盘图标
```

## 已知边界（后续路线）

- 插件市场（在线列表/下载/安装）未实现；`plugins/installed/` 目录已预留（在 `getPluginRoots()` 加一行即可）
- 内联插件一旦被唤醒就常驻一个渲染进程（受 LRU 保护，属于"用内存换输入即得"的有意取舍）；
  非内联视图已按 LRU 封顶 5 个，见「常驻视图上限」
- 目录监听用的是 `fs.watch`，某些网络盘/容器文件系统上事件可能不送达；这种情况下插件的
  安装/卸载仍会显式重扫，只是"手改文件"需要重启一次
- 内联结果单次只有 120ms 预算：需要网络/重计算的结果应自己缓存（如汇率先拉一次再本地换算）
- 开机自启仅在打包版生效（`applyAutostart` 判断 `app.isPackaged`）
