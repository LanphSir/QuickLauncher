# CLAUDE.md — AI 开发规范

QuickLauncher：全局快捷键唤起的插件化桌面启动器（类 uTools），Windows 优先。
Electron 38 + TypeScript(strict) + Vue 3 + Pinia + electron-vite + pnpm workspaces。

> 给 AI 助手的工作守则。改动前先读完本文件；与本文件冲突的做法一律以本文件为准。

## 1. 常用命令

```bash
pnpm dev              # 开发模式（会先构建内置插件再启动 electron-vite dev）
pnpm dev:plugin <name> # 单个插件改走 vite dev server（HMR），改插件代码不用重构建/重启
pnpm typecheck        # 三端类型检查（tsconfig.json + tsconfig.web.json）
pnpm test             # 单元测试（纯逻辑：校验器/内联归一化/存储分片与配额/LRU 策略/监听计划）
pnpm build:plugins    # 仅构建内置插件（plugins/*/dist）
pnpm smoke            # CDP 功能冒烟 63 项（需先另起: npx electron . --remote-debugging-port=9222）
pnpm dist             # 打包 Windows 安装包 → release/<version>/
node scripts/gen-icons.mjs   # 重新生成图标（应用/托盘）
```

验证基线：**任何提交前 `pnpm typecheck` + `pnpm test` 必须零错误**；改了插件系统/网关/插件本体，再跑 `pnpm smoke`。

## 2. 架构铁律（不可违反）

这套不变量是"插件互不干扰"的根基，任何改动都不得削弱：

1. **插件渲染进程永远不碰系统能力**：`sandbox: true` + `contextIsolation: true` + `nodeIntegration: false` 是插件宿主（`windows/pluginHost.ts`）的固定配置。插件只能通过 preload 暴露的 `window.appapi` 做事。
2. **新增插件 API 必须走契约 + 注册表**：① `src/shared/pluginApi.ts` 声明通道与入参/返回值类型 → ② 同文件 `PLUGIN_PERMS` 声明所需权限 → ③ `src/main/plugin/api/*.ts` 加一条 `defineApi`（含 payload 校验）→ ④ `preload/plugin.ts` 的 `api` 对象里暴露 → ⑤ 插件 manifest 声明该权限。网关（`plugin/gateway.ts`）只做身份/权限/入参校验，**不得再出现具体通道名**；禁止任何绕过网关的直连 IPC。
3. **调用方身份锚定**：网关通过 `callerRegistry`（webContents.id → 插件）识别调用方，不信任 payload 里自带的插件 id。
4. **数据强制命名空间**：插件存储只能落在 `userData/data/<pluginId>/`（`services/storage.ts`）。不允许给插件暴露任何路径能力。
5. **插件扫描只认固定目录**（`plugin/manager.ts` 的 `getPluginRoots()`）：builtin（dev 项目 `plugins/`、打包 `resources/plugins/builtin/`）+ installed（`userData/plugins/installed/`）。manifest 校验失败即跳过，id 冲突 builtin 优先。
6. **`<webview>` 必须有权限门禁**：插件宿主虽开 `webviewTag`，但 `will-attach-webview` 只放行声明了 `webview` 权限的插件，且强制 guest 沙箱（删 preload、禁 nodeIntegration）。不要绕过这道门禁。

## 3. 代码规范

- **TypeScript strict**，禁止 `any` 逃逸到公共接口（唯一例外：`src/main/plugin/api/define.ts` 的注册表类型擦除，对外由 `defineApi` 泛型 + `shared/pluginApi.ts` 契约约束）。
- **main/preload 是 CJS 产物**（根 package.json 无 `"type": "module"`，这是有意的：sandbox preload 只支持 CJS）。main/preload 源码里直接用 `__dirname` 定位 `out/` 内兄弟产物（如 `join(__dirname, '../preload/panel.js')`），不要用 import.meta。
- **渲染层一律 Vue 3 `<script setup lang="ts">`**；全局类型集中在 `src/renderer/src/env.d.ts`（`window.panel` / `window.appapi` 已声明，不要重复 declare）。
- **UI 图标统一用 `<AppIcon name="..." />`**（path 数据登记在 `components/icons.ts`），不要散落内联 SVG；新图标先在 `icons.ts` 登记。
- **UI 文案中文**，代码注释中文、只写"为什么"，不复述代码。日志前缀用模块名：`[plugin]`、`[config]`、`[storage]`、`[external]`。
- 命名：文件用 kebab 或与周边一致；插件 id 一律反向域名 `com.launcher.<name>`；IPC 通道前缀 `panel:*` / `plugin:*`。
- **不引入新的运行时依赖**除非确有必要；加依赖前先确认 electron 原生 API 覆盖不了。

## 4. 插件开发（高频任务）

**创建/修改任何插件之前，先加载项目内 skill：`.zcode/skills/quicklauncher-plugin-dev/SKILL.md`**，
里面有脚手架脚本、manifest 校验规则、appapi 完整参考和验证清单。要点速记：

- manifest/icon 放 `public/`（web 型），构建产物进 `dist/`；vite 必须 `base: './'`（相对路径加载资源）
- 插件页约定：监听 Esc → `appapi.exit()`；图标 `icon.svg`/`png`/`ico` 任一
- 插件页外框由启动器提供（`PluginFrame.vue`：返回主界面 / 独立窗口 / 关闭，顶栏 46px + 四周 8px 留白），插件**不要自绘窗口级控件**；外框尺寸的唯一来源是 `src/shared/pluginFrame.ts`，主进程算视图矩形与渲染层排版都读它
- 需要读用户自己的文档（笔记/手册/速查）→ 用 `appapi.docs.*`（`docs` 权限，主进程代管目录）；随插件发布的离线内容可 `fetch('xx.md')`（插件页 origin 是 `plugin://<id>`，同源可读，见 `plugin/protocol.ts`），或用 vite `?raw` 构建期打包。跨插件 `plugin://` 地址一律被拦
- 要调三方 HTTP API → `appapi.net.request`：`net` 权限 + manifest `hosts` 白名单，主进程转发并逐跳校验重定向，插件页直接 `fetch` 跨域会被 CORS 拦
- 插件退出是"视图缓存"不是销毁：`onUnmounted` 不会触发，定时器/轮询必须 `onShow` 启、`onHide` 停（否则切走后仍在后台空转）
- 要让插件**内部条目**（章节/笔记/历史）被主面板搜到 → `appapi.search.set()`（`search` 权限，全量覆盖），条目带 `intent`，选中后经 `onQuery` 回传；插件目录放构建期 `search-index.json` 可让"没打开过也能搜"。检索在主进程，插件只提交数组
- 要让插件**输入即得**（`2+3 → 5`、汇率换算）→ manifest 声明 `features: ["inline"]`（功能声明，不是权限），`onInlineQuery` 里收到 `{ seq, query }`，用 `appapi.inline.set({ seq, items })` 回 ≤2 条、**120ms 内**返回；动作 `copy`（面板不关）或 `open`（缺省）。参考 `plugins/calculator/`
- 内联插件视图会被后台拉起但**不挂到面板**（`pluginHost.warmPluginContents`）：不要在这里做重活，慢数据自己缓存；页面未加载完时面板会在 `did-finish-load` 后自动补查一次
- 改插件后：日常用 `pnpm dev:plugin <name>`（vite dev server + HMR，启动器自动切入口、改代码即时生效，manifest 改动仍需 `pnpm build:plugins` 并重开插件）；没起 dev server 时一律 `pnpm build:plugins`
- external 型插件 = 目录里一个 `plugin.json` + 图标，零代码
- 加一个 API 的落点：`src/shared/pluginApi.ts`（契约：通道类型 + 权限）→ `src/main/plugin/api/<域>.ts`（`defineApi` + 入参校验）→ `src/preload/plugin.ts`（桥方法）。插件的 `window.appapi` 类型统一从 `src/shared/appapi.global.d.ts` 引用，**不要在各插件里手写一份 appapi 接口**

## 5. 已知坑（踩过的）

| 坑 | 处理 |
|---|---|
| pnpm 10 默认拦截 postinstall，Electron 二进制装不上 | 已在 `pnpm-workspace.yaml` 配 `onlyBuiltDependencies: [electron, esbuild]`，重装后需 `pnpm rebuild electron` |
| Electron/NSIS 二进制下载慢 | 项目 `.npmrc` 已配 npmmirror 镜像，勿删 |
| `pnpm` 报 `Cannot find module ...\corepack\pnpm\<v>\bin\pnpm.cjs` | PATH 里的 pnpm shim 指向别的 nvm 版本留下的旧 corepack，与新版 pnpm 的 `bin/pnpm.mjs` 布局不兼容。修法：`npm i -g pnpm@10` 装到 `E:\npm-global`，再把 shim（`~/.workbuddy/binaries/node/versions/<v>/pnpm{,.CMD,.ps1}`）里的 corepack 路径改成 `pnpm/bin/pnpm.cjs`；版本锁 10.x 以匹配 lockfileVersion 9.0 |
| 渲染层 `<img>` 加载本地 file:// 图标会被 http origin 拦截 | 插件图标一律由主进程读文件转 dataURL 下发（`manager.ts` 的 `iconToDataUrl`），保持该做法 |
| `protocol.handle` 只作用于 defaultSession | 插件各有独立分区，必须在对应 `session.fromPartition(...)` 上再注册一次（`plugin/protocol.ts` 的 `installOnSession`） |
| 自定义协议的响应不做 CORS 校验 | 插件 `fetch('plugin://别的插件/…')` 不会被 Chromium 拦，只能在 session 层 `webRequest.onBeforeRequest` 取消（`plugin/sessions.ts`）；handler 内另按 `referrer` 复核 |
| `net.fetch` 的 `redirect: 'manual'` 在 Electron 直接失败 | 会以 `Redirect was cancelled` 结束，拿不到 302 响应。要逐跳裁定重定向只能用 `net.request` 的 `redirect` 事件；且在该事件里 `abort()` 不会触发 `error`，必须自己 reject（`plugin/api/net.ts`） |
| 未挂到窗口的 `WebContentsView` 也能正常加载并执行 JS | 内联结果就靠这一点在后台跑（`pluginHost.warmPluginContents`）；但页面不可见时定时器会被节流，靠 `backgroundThrottling` 默认值即可，别把它关掉 |
| 首次输入时内联插件页可能还在加载 | 主进程在 `did-finish-load` 后发 `panel:inline-ready`，面板用当前词补查一次（`plugin/inline.ts` + `PanelShell.vue`），否则表现为"第一次没结果、再打一个字才有" |
| dev 与打包版 userData 同为 `%APPDATA%/quick-launcher` | 联调时配置会互相影响，注意清理或区分 |
| `WebContents` 用 `.id` 属性，没有 `getId()` | 类型定义如此 |
| 开机自启 | 仅 `app.isPackaged` 时调用 `setLoginItemSettings`，避免开发期写用户登录项 |
| 面板 blur 隐藏 | DevTools 打开时不隐藏（`panel.ts` 已处理），调试面板 UI 不要关这个分支 |
| 面板里开原生对话框（选文件/选目录）会先被失焦隐藏 | 一律走 `withPanelDialog()` 包一层（挡 blur + 事后还焦点），别直接 `dialog.showOpenDialog` |
| `spawn` 起 `.bat` / `.cmd` 是 EINVAL、起 `.lnk` 是 ENOENT | 批处理必须经 `cmd` 解释，快捷方式交给 `shell.openPath`（`services/external.ts`）；spawn 的 `error` 事件是异步的，别指望同步 catch 到"启动失败" |
| Vue 模板里的 `<webview>` 被当作组件解析报错 | 插件 vite 配置需 `vue({ compilerOptions: { isCustomElement: (tag) => tag === 'webview' } })`，见 plugins/translator |
| zip 安装 | 只能用 `manager.ts` 的手工解包（防 zip-slip），不要换 `extractAll` |
| 插件 IPC 报 `An object could not be cloned` | contextBridge 传参即结构化克隆，Vue reactive/ref Proxy 不能直接传 appapi；插件侧先 `JSON.parse(JSON.stringify(...))`（见内置插件 `plain()`），preload 侧的 `plain()` 只是二次保险 |
| `-webkit-app-region` 吞掉缩放热区 | drag region 按**文档顺序**做 drag 加/no-drag 减，与 DOM 层叠无关——no-drag 元素必须在 drag 元素之后（见 PanelShell 模板中 `.rz` 的位置注释） |
| 插件页白屏、只显示骨架 HTML | manifest 放到插件根目录而不是 `public/`：扫描器命中源码目录，入口成了未被 vite 处理的 `index.html`。manifest/icon 一律进 `public/` |
| `fs.watch` 监听插件目录会刷屏 | 插件构建会整目录重写 JS/CSS，按文件名只认 `plugin.json` / `dist`，且事件必须合并（300ms）；见 `plugin/watcher.ts` |
| 重扫后已打开视图仍用旧 manifest | 只更新注册表不够，必须 `pluginHost.refreshPluginRecords()` 重新登记 `callerRegistry`（权限/名称变了）并按需换源，否则改了权限仍被拒 |
| 存储配额超限别返回 `false` | 插件会把 `false` 当"已存上"，静默丢数据；`pluginStorage.set` 返回 `{ok,message}`，API 层抛错让插件侧 catch 到原因 |
| 渲染层根容器 `height:100%` 失效 | naive-ui Provider 包裹 div 无高度会逐层塌缩；PanelShell 的 `.shell` 用 `100vh` 锚定窗口视口，勿改回 100% |

## 6. Git 与迭代流程

- 分支：`main` 保持可运行；功能分支 `feat/<主题>`、修复 `fix/<主题>`。
- 提交信息：Conventional Commits + 中文描述，如 `feat(plugins): 插件市场本地列表`、`fix(panel): 失焦隐藏在 DevTools 打开时误触发`。
- **每完成一个功能迭代，必须更新 `docs/DEVLOG.md`**（模板在文件底部），并对照 `docs/ROADMAP.md` 勾选进度。
- 版本号语义化：主版本.功能.修复；发版走 `pnpm dist`，产物入 `release/`（已 gitignore）。
- 提交前自查：typecheck ✓ → 相关 smoke ✓ → DEVLOG ✓ → `.gitignore` 没把构建产物带进来。

## 7. 文档地图

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 进程模型、五层隔离、插件协议、数据目录 |
| [docs/DEVLOG.md](docs/DEVLOG.md) | 功能开发记录（每迭代一条） |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 迭代路线与验收标准 |
| [docs/plugin-dev-guide.md](docs/plugin-dev-guide.md) | 插件开发指南（人读版） |
| `.zcode/skills/quicklauncher-plugin-dev/` | 插件开发 skill（AI 用版，含脚手架脚本） |
