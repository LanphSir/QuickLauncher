---
name: quicklauncher-plugin-dev
description: QuickLauncher（本仓库）插件开发全流程规范：创建新的内置 web 插件或 external 外部程序集成插件、修改/调试现有插件、使用 window.appapi、处理插件不被扫描/权限被拒/崩溃隔离等问题。只要用户要求"给启动器/面板加一个 XX 应用/功能/工具"、"集成 XX 外部程序"、动 plugins/ 目录或 plugin.json，即使没出现"插件"二字也必须使用本 skill。
---

# QuickLauncher 插件开发

本 skill 让你在 QuickLauncher 仓库里正确地开发插件：不破坏五层隔离架构、
通过 manifest 校验、正确声明权限、并完成构建注册。插件分两种：

- **web 型**：自设计的 HTML 页面应用（可与主面板同栈 Vue 3，也可纯 HTML/JS）
- **external 型**：零代码，一个 manifest 把任意 exe / 文件夹 / 网址接入面板

选型判断：需要界面和交互 → web 型；只是"拉起某个程序/网站" → external 型。

## 工作流

### 1. 脚手架

```bash
node .zcode/skills/quicklauncher-plugin-dev/scripts/scaffold.mjs <目录名> --name "显示名" [--keywords "a,b"] [--perms "storage,clipboard"] [--external "notepad.exe 或 https://..."]
```

脚本会生成完整骨架（web 型含 package.json / vite.config / index.html / public/plugin.json / icon.svg / src/App.vue），
并打印后续步骤。已有目录会被拒绝（加 `--force` 覆盖）。**写逻辑之前先跑它。**

### 2. 理解 manifest（校验失败 = 插件不被加载）

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✓ | 反向域名 `com.launcher.<name>`，正则 `/^[\w.-]+$/`，全库唯一 |
| `name` | ✓ | 面板显示名（中文） |
| `type` | ✓ | `web` 或 `external` |
| `entry` | web 型 | 入口 html，**相对插件目录**（构建后即相对 dist） |
| `command` | external 型 | exe 路径/命令（走 PATH）或 http(s) URL；`args` 数组可选 |
| `keywords` | 建议 | 面板搜索关键词（中英都放） |
| `permissions` | 建议 | 申请的 API 权限，见下方权限表 |
| `features` | 可选 | 功能形态声明（不是权限）：目前只有 `inline`，声明后才能回传内联结果 |
| `hosts` | `net` 权限必填 | 可访问的域白名单：`api.github.com`、`*.example.com`、`localhost:8080`；空 = 一个都不许 |
| `hotkey` | 可选 | 建议启动键（accelerator，如 `Alt+Shift+V`）：只在设置页作提示，**不自动注册**，用户点了才生效 |

图标：目录（或 dist）内 `icon.svg` / `icon.png` / `icon.ico` 任一，由主进程转 dataURL 下发。
扫描位置：`plugins/<name>/dist/plugin.json`（web 型）或 `plugins/<name>/plugin.json`（external 型）。

### 3. 使用插件 API

插件运行在沙箱渲染进程（无 Node 能力），一切系统能力通过 `window.appapi`，
且**必须**在 manifest `permissions` 里声明对应权限，否则网关拒绝（错误信息会提示补哪个权限）：

```ts
await appapi.storage.set('key', value)     // 权限 storage —— 按插件 id 强制隔离
await appapi.clipboard.writeText('hello')  // 权限 clipboard
await appapi.notify('标题', '内容')          // 权限 notify
await appapi.shell.openExternal(url)       // 权限 shell，仅 http(s)
await appapi.docs.list()                   // 权限 docs —— 插件自己的文档库（import/read/remove/reveal）
await appapi.search.set(entries)           // 权限 search —— 把插件内条目交给主面板搜索
await appapi.net.request({ url, method, headers, body })  // 权限 net + manifest hosts 白名单
await appapi.onShow(fn) / onHide(fn)       // 无需权限 —— 切走/收起时暂停轮询，回来时恢复
appapi.onDestroy(fn)                       // 视图即将被回收（LRU）—— 草稿落盘
// 存储：单值 2MB / 单插件 8MB，超限 reject；历史类数据自己截断
await appapi.inline.set({ seq, items })    // 需 manifest features:["inline"] —— 回传内联结果
await appapi.exit()                        // 无需权限 —— 退出插件返回面板
await appapi.window.hide()                 // 无需权限 —— 隐藏整个面板
```

**定时器必须跟可见性走**：插件退出后视图只被摘掉不销毁（保留状态），`onUnmounted` 不会触发。
轮询一律写成 `appapi.onShow(() => start())` + `appapi.onHide(stop)`，否则插件切走后仍在后台空转。
`onShow` 注册时若已可见会立即回调一次，启动逻辑不需要在 `onMounted` 里重写。

想让"用户在主面板搜关键词就能命中插件里的某条内容"（某本手册、某个章节），用搜索贡献：
`appapi.search.set([{ id, title, keywords, intent }])`，选中后 intent 经 `onQuery` 回传；
插件目录放 `search-index.json` 可让插件没打开过也能被搜到。详见 `references/api.md`。

想让"输入即得"（`2+3` 直接出 `5`、单位换算），在 manifest 加 `"features": ["inline"]`，
用 `appapi.onInlineQuery(({ seq, query }) => ...)` 接查询、`appapi.inline.set({ seq, items })`
回 ≤2 条结果（**120ms 内**，动作 `copy` 或 `open`）。参考 `plugins/calculator/`。

完整签名、生命周期（视图缓存/恢复状态）、示例代码见 `references/api.md`。
**约定**：插件页自己监听 `keydown`，Esc 调 `appapi.exit()` 返回面板——所有内置插件都遵守。

**插件页外框（v0.4.1 起）**：启动器在插件外面套了顶栏 46px + 四周 8px 留白的外框，
已提供"返回主界面 / 独立窗口 / 关闭"。所以插件**不要自绘关闭、返回主界面这类窗口级控件**，
自己的"返回"只用于内部层级；关键按钮也别贴内容区最边缘（留白那一圈是缩放热区的作用带）。
布局用 `height: 100%` 自适应即可，进插件时面板会自动伸展。

### 4. 构建与注册

- vite 配置必须 `base: './'`（插件页用相对路径加载资源，dev 与打包后通用），manifest 和 icon 放 `public/`
- 构建进 `dist/`：`pnpm build:plugins`（首次必须构建，扫描器要看到 `dist/plugin.json`）
- 开发期热更新：`pnpm dev:plugin <name>` 给单个插件起 vite dev server，主进程自动把入口切过去
  （`.dev-plugins.json` 登记，包装后不生效），改代码即时 HMR；改 manifest 仍需重新构建并重开插件
- external 型无需构建，目录里直接放 `plugin.json` + icon

### 5. 验证清单（完成前逐条过）

1. `pnpm typecheck` 零错误
2. `pnpm build:plugins` 成功，`plugins/<name>/dist/plugin.json` 存在
3. 启动应用，控制台出现 `[plugin] 已加载 N 个插件` 且 N 包含你的
4. 面板搜索 `keywords` 能命中；回车进入插件；Esc 返回
5. 若用了权限 API：故意删掉一个权限声明，确认网关拒绝（证明走的是网关）——测完恢复
6. 若改了插件系统本体（gateway/host/manager）：跑 `pnpm smoke`

## 铁律（违反 = 破坏互不干扰架构）

1. 不给插件宿主开 `nodeIntegration` / 关 `sandbox` / 关 `contextIsolation`
2. 插件需要的任何新系统能力：`src/shared/pluginApi.ts` 声明通道 + 权限（`PLUGIN_PERMS`）→ `src/main/plugin/api/<域>.ts` 加一条 `defineApi`（带 payload 校验）→ `src/preload/plugin.ts` 暴露 → manifest 声明。网关 `gateway.ts` 只做身份/权限/入参校验，**不要把具体能力的实现塞进网关**
3. 不在插件间提供任何直接通信/共享存储
4. 插件代码不 `eval` 用户不可信输入（计算器插件有现成的表达式解析器可抄）

## 常见坑

| 现象 | 原因/解法 |
|---|---|
| 面板搜不到插件 | manifest 校验失败（看主进程控制台 `[plugin] 跳过 ...`）：常见是缺 entry、entry 文件不存在、id 含非法字符 |
| 页面白屏、资源 404 | vite 忘了 `base: './'`，或用绝对路径引用了资源 |
| 调用 API 报"缺少权限" | manifest `permissions` 没声明，加上后**重新 build** |
| 改了插件没变化 | 没起 `pnpm dev:plugin <name>` 时需先 `pnpm build:plugins`；旧视图有缓存，Esc 重进即可。起了 dev server 仍不更新 → 看 `.dev-plugins.json` 是否登记、vite 是否还在跑 |
| 插件页白屏、只显示骨架 HTML | manifest 放在了插件根目录而不是 `public/`——扫描器会命中源码目录，入口变成未被 vite 处理的 `index.html`（scaffold 已修正，老目录手动挪一下） |
| `fetch('xx.md')` 拿不到本地文件 | 路径写错（相对入口 html）；跨插件读 `plugin://别的插件/…` 会被拦，路径越界返回 403。离线内容仍推荐 vite `?raw` 打进 bundle（见 `plugins/handbook/scripts/build-manuals.mjs`） |
| 图标不显示 | icon 不在插件目录/dist 根部，或扩展名不在 svg/png/ico 列表 |
| 插件里 `fetch('https://api.xxx.com')` 报 CORS | 插件页 origin 是 `plugin://<id>`，跨域被拦。改用 `appapi.net.request`（`net` 权限 + manifest `hosts` 声明该域） |
| `net.request` 报"不在 manifest.hosts 白名单内" | `hosts` 没写或写法不对（不要带 `https://` 与路径）；`*.example.com` 只放宽子域，不放开别的域 |
| 插件退出后还在跑定时器/读剪贴板 | 视图是缓存不是销毁，`onUnmounted` 不触发。用 `onHide` 停、`onShow` 启 |
| dev 与打包版配置串了 | 两者共用 `%APPDATA%/quick-launcher`，必要时清掉 |
