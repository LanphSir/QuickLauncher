# CLAUDE.md — AI 开发规范

QuickLauncher：全局快捷键唤起的插件化桌面启动器（类 uTools），Windows 优先。
Electron 38 + TypeScript(strict) + Vue 3 + Pinia + electron-vite + pnpm workspaces。

> 给 AI 助手的工作守则。改动前先读完本文件；与本文件冲突的做法一律以本文件为准。

## 1. 常用命令

```bash
pnpm dev              # 开发模式（会先构建内置插件再启动 electron-vite dev）
pnpm dev:plugin <name> # 单个插件改走 vite dev server（HMR），改插件代码不用重构建/重启
pnpm typecheck        # 三端类型检查（tsconfig.json + tsconfig.web.json）
pnpm test             # 单元测试 268 项（纯逻辑：校验器/内联归一化/存储分片与配额/LRU 策略/监听计划/失焦判定/面板布局/快捷键计划与注册表/自定义应用模型/AI 的 SSE 与增量解析/地址与模型 id/会话转换/token 预算与截断/附件抽取与编码回退/摘要触发条件/manifest 新字段校验/tools.json 解析与参数校验/SKILL.md 解析/工具调用分片归并与名字合法化/工具确认与放行/mcp.json 解析与命令指纹）
pnpm build:plugins    # 仅构建内置插件（plugins/*/dist）
pnpm smoke            # CDP 功能冒烟 135 项（含 AI：mock 端点跑通配置→流式→停止→附件→多模态→插件工具授权→工具调用全链路/确认/危险工具/超时/崩溃→MCP 确认与调用/改参数失效/进程崩溃）（需先另起: npx electron . --remote-debugging-port=9222）
                      # 注意本机 shell 里若带 ELECTRON_RUN_AS_NODE=1，electron 会当 node 跑，启动前 unset
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
6. **自定义外部应用与插件同一张注册表**：`userData/shortcuts.json` 的条目在扫描时翻译成 `PluginRecord`（`source='shortcut'`，`type` 固定 `external`），不得为它单开启动/搜索/固定路径；配置只能由 `shortcuts.json` 一份承载。
7. **`<webview>` 必须有权限门禁**：插件宿主虽开 `webviewTag`，但 `will-attach-webview` 只放行声明了 `webview` 权限的插件，且强制 guest 沙箱（删 preload、禁 nodeIntegration）。不要绕过这道门禁。
8. **模型调用只有内置插件能发起**：`plugin:ai.chat.*` 等通道在 `define.ts` 标了 `internalOnly`，网关只放行 `source === 'builtin'`。模型调用花的是用户自己的钱，第三方插件即使声明了 `ai` 权限也调不通。第三方插件参与 AI 的唯一姿势是**被调用**：`plugin:ai.tool-call`（主→插件，宿主代发）→ 插件执行 → `plugin:ai.tool.reply`（插件→主，`internalOnly`）。工具调用的编排（选工具、限轮次、风险确认、审计）全在主进程 `main/ai/`，插件侧只负责执行单个 `handler`。
9. **密钥只在主进程**：AI 的 apiKey 走 `safeStorage` 密文（`main/ai/secrets.ts`），渲染层与插件页只能拿掩码；日志、审计、错误信息里一律脱敏。
10. **工具调用必须有闸门**：任何模型发起的工具调用都要经过 `main/ai/toolExec.ts` 的同一条流水（参数校验 → `needsConfirm` → `askConfirm` → 执行 → `writeAudit`）。`dangerous` 级工具每次都问，不给「本次会话不再询问」；确认超时按拒绝；任何失败都折成 `tool-result.error` 回给模型而不是抛出去。绕过这条流水直接 dispatch 是禁止的。
11. **MCP 命令必须用户逐条确认且与指纹绑定**：`ai/mcp.json` 里的命令默认一条都不执行；用户批准时把 `command+args+env+cwd` 的 sha256 一起存进 `config.aiMcpApprovals`，命令改了（指纹对不上）必须重新批准。执行一律 `spawn(cmd, args, {shell:false})`——**不许拼字符串走 shell**，也不许把整份 `process.env` 换成声明里的 env（`npx`/`node` 靠 PATH）。子进程必须在退出时收掉（Windows 用 `taskkill /T`），连续失败 3 次本会话停用。

## 3. 代码规范

- **TypeScript strict**，禁止 `any` 逃逸到公共接口（唯一例外：`src/main/plugin/api/define.ts` 的注册表类型擦除，对外由 `defineApi` 泛型 + `shared/pluginApi.ts` 契约约束）。
- **main/preload 是 CJS 产物**（根 package.json 无 `"type": "module"`，这是有意的：sandbox preload 只支持 CJS）。main/preload 源码里直接用 `__dirname` 定位 `out/` 内兄弟产物（如 `join(__dirname, '../preload/panel.js')`），不要用 import.meta。
- **渲染层一律 Vue 3 `<script setup lang="ts">`**；全局类型集中在 `src/renderer/src/env.d.ts`（`window.panel` / `window.appapi` 已声明，不要重复 declare）。
- **UI 图标统一用 `<AppIcon name="..." />`**（path 数据登记在 `components/icons.ts`），不要散落内联 SVG；新图标先在 `icons.ts` 登记。
- **颜色/圆角/阴影只用令牌**：`src/shared/theme.css` 是唯一来源（`--text-1…4`、`--line`、`--r-sm…xl`、`--shadow-1…3`、`--accent`、`--danger`、`--scrim`、`--mark`、`--on-accent`）。核心渲染层与插件页入口都先 `import` 它，组件里不再写字面量色值；要新语义色先加到 theme.css。
- **插件页另有一层公共骨架**：`src/shared/plugin-ui.css`（`.pl-page` / `.pl-head` / `.pl-btn` / `.pl-input` / `.pl-list` / `.pl-row` / `.pl-dialog` …）。插件页的结构与基础控件从这里取，别在各自的 App.vue 里重写一份 reset 和按钮；浮层用 `src/shared/ui/{PopMenu,ConfirmDialog}.vue`，不要再复制第三份。宿主那份（`src/renderer/src/components/`）走 OverlayHost 体系，两边不共用。
- **破坏性操作不进按钮行**：删除 / 卸载 / 清除数据一律收进 `···` 菜单（宿主用 `ContextMenu`，插件页用 `PopMenu`）或右键菜单，并走自绘 `ConfirmDialog`（默认焦点在「取消」）。新代码不再用 `window.confirm` 和 `NPopconfirm`。
- **AI 对话页的「过程」不能平铺**：推理、工具调用、过程中的碎话都归「过程」块（`answerStart()` 之前的一切），生成中展开、结束后收起成一行摘要；用户手动开合过的记在 `procOverride` 里并优先于默认值。别再把工具卡片直接铺进正文（`docs/ai-architecture.md` §5.1）。
- **流式输出不要无脑滚到底**：按 `stick`（离底 < 48px）判断要不要跟随，否则用户往上翻历史时会被一帧帧拽回去。
- **无边框窗口的每个顶层页面都要有拖动区**：主页靠 `.search-row` 的 `-webkit-app-region: drag`，设置页 / 全部应用页各自补头部 `drag` + 子元素 `no-drag`。新加一个铺满面板的页面时先想这件事。
- **UI 文案中文**，代码注释中文、只写"为什么"，不复述代码。日志前缀用模块名：`[plugin]`、`[config]`、`[storage]`、`[external]`。
- 命名：文件用 kebab 或与周边一致；插件 id 一律反向域名 `com.launcher.<name>`；IPC 通道前缀 `panel:*` / `plugin:*`。
- **不引入新的运行时依赖**除非确有必要；加依赖前先确认 electron 原生 API 覆盖不了。
  已批准的例外（v0.6 AI 线）：`ai` + `@ai-sdk/*`（流式与 tool-calling）、`ajv`（tools.json 的
  JSON Schema 校验）、`@modelcontextprotocol/sdk`（MCP client）、`unpdf`（PDF 抽文本，
  比 pdfjs 全家桶小一个量级；ESM-only，只能动态 `import()` 加载）。再要加别的先讨论。
  实测结论：v0.6.0/v0.6.1 都没用上 `ai`/`@ai-sdk/*`——SSE 与多模态请求自己写不到 200 行，
  引两个依赖反而多一层不可控。留着例外，但**别为了"当初说好可以"而用它**。
  `ajv` 在 v0.6.2 首次落地（`main/ai/toolsSpec.ts`）：插件写的 `parameters` 是开放形状的
  JSON Schema，手写校验只能覆盖一小撮。主进程产物里保持 `require("ajv")` 外部依赖形态，
  必须留在 `dependencies`（不能挪 devDependencies，否则打包缺模块）。

## 4. 插件开发（高频任务）

**创建/修改任何插件之前，先加载项目内 skill：`skills/quicklauncher-plugin-dev/SKILL.md`**，
里面有脚手架脚本、manifest 校验规则、appapi 完整参考、AI 接入与界面令牌规范、验证清单。要点速记：

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
- 想让插件被 AI 当工具调用 → manifest 声明 `permissions: ["ai"]` + `ai: { tools, skill }` 两个
  **插件目录内**的相对路径（v0.6.2 声明、v0.6.3 可被调用）；`features: ["ai"]` 这个名字虽然在
  `PLUGIN_FEATURES` 里，但代码里没有消费者，**别当成门禁**。第三方插件参与 AI 的唯一姿势是**被调用**：
  `plugin:ai.tool-call`（主→插件）→ 执行 → `plugin:ai.tool.reply`（`plugin:ai.*` 里唯一不标 internalOnly 的通道）；
  对话/确认/附件/会话那几组仍是 `internalOnly`，只有内置插件能调
- 插件的界面不另起一套：入口先 `import '../../../src/shared/theme.css'`（同时给 reset，漏了就是常驻滚动条）再 `import '../../../src/shared/plugin-ui.css`，
  颜色/圆角/阴影只用令牌；删除/清除这类操作收进 `···` 菜单 + 右键 + 自绘确认框，不进按钮行
- 想给插件配一个**建议启动键** → manifest 写 `hotkey`（accelerator，如 `Alt+Shift+V`）：只作设置页提示，**不会自动注册**；实际生效值在 `config.pluginHotkeys`
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
| 面板 blur 隐藏 | 别在 `panel.on('blur')` 里直接 `hidePanel()`：先过 `blurDecision()`（设置档位 / 置顶 / DevTools / 可见性令牌），延迟到期还要 `shouldHideAfterDelay()` 复检焦点。调试面板 UI 时 DevTools 打开着本就不会收 |
| 面板里开原生对话框（选文件/选目录）会先被失焦隐藏 | 一律走 `withPanelDialog()` 包一层（登记可见性 + 事后还焦点），别直接 `dialog.showOpenDialog` |
| 渲染层新增弹窗别自己画 backdrop | 必须走 `openOverlay()` / `OverlayHost`：否则不会被登记可见性（鼠标移出去一瞬面板连弹窗一起消失），也拿不到统一的 Esc / 点遮罩关闭 / 焦点困住与还原 |
| 靠 `watch(浮层栈长度)` 触发聚焦会漏 | 菜单→详情是同一 tick 内 pop+push，长度不变、watch 不跑；聚焦在 `openOverlay` 里 `nextTick` 调度。焦点还原目标也要向上追溯（`resolvePreviousFocus`），"详情→编辑"先开新层再关旧层 |
| `spawn` 起 `.bat` / `.cmd` 是 EINVAL、起 `.lnk` 是 ENOENT | 批处理必须经 `cmd` 解释，快捷方式交给 `shell.openPath`（`services/external.ts`）；spawn 的 `error` 事件是异步的，别指望同步 catch 到"启动失败" |
| Vue 模板里的 `<webview>` 被当作组件解析报错 | 插件 vite 配置需 `vue({ compilerOptions: { isCustomElement: (tag) => tag === 'webview' } })`，见 plugins/translator |
| zip 安装 | 只能用 `manager.ts` 的手工解包（防 zip-slip），不要换 `extractAll` |
| 插件 IPC 报 `An object could not be cloned` | contextBridge 传参即结构化克隆，Vue reactive/ref Proxy 不能直接传 appapi；插件侧先 `JSON.parse(JSON.stringify(...))`（见内置插件 `plain()`），preload 侧的 `plain()` 只是二次保险 |
| `-webkit-app-region` 吞掉缩放热区 | drag region 按**文档顺序**做 drag 加/no-drag 减，与 DOM 层叠无关——no-drag 元素必须在 drag 元素之后（见 PanelShell 模板中 `.rz` 的位置注释） |
| 插件页白屏、只显示骨架 HTML | manifest 放到插件根目录而不是 `public/`：扫描器命中源码目录，入口成了未被 vite 处理的 `index.html`。manifest/icon 一律进 `public/` |
| `fs.watch` 监听插件目录会刷屏 | 插件构建会整目录重写 JS/CSS，按文件名只认 `plugin.json` / `dist`，且事件必须合并（300ms）；见 `plugin/watcher.ts` |
| 插件页"怎么拉伸都有滚动条" | 插件是独立 HTML，没有宿主的全局样式：`body` 默认 8px margin 叠加 `.app{height:100vh}` 就多出 16px，垂直滚动条常驻；滚动条再占宽，`textarea` 的 content-box 让横向也溢出。插件入口必须先 `import '../../../src/shared/theme.css'`（含 reset）+ `plugin-ui.css`，容器高度用 `100%` |
| 设置页 / 全部应用页拖不动窗口 | 面板是无边框窗口，拖动区只在主页的 `.search-row` 上。每个铺满面板的页面都要给自己的头部加 `-webkit-app-region: drag`，并把里面的按钮标 `no-drag`，否则整页能点不能拖 |
| 「过程」摘要被截成「思考 1 段 · 调用 1 个…」 | 助手消息 `.body` 作为 flex 项默认按内容收缩，摘要的 `max-width: 100%` 会跟着最短的正文走。助手侧给 `flex: 1 1 auto`（用户气泡保持收缩），或给摘要行 `width: max-content` |
| 侧栏底部出现横向滚动条 | 块级元素写了 `width: calc(100% - 18px)` 又加 `margin-left: 27px`，加起来超过 100%。让宽度自动填充（`width: auto` + 左右 margin），滚动容器再补 `overflow-x: hidden`（手册侧栏的 `.kw` 踩过） |
| 插件 manifest 里的 `ai` 路径被当成"随便写个相对路径" | 一律过 `safeRelative()`：挡 `../`、绝对路径、盘符、URL。工具描述与 SKILL 正文都会进模型上下文，越界路径等于开了一条读任意文件的路 |
| `tools.json` 用 ajv 编译 schema 会抛异常 | 编译要逐个 try/catch 并**只丢该工具**（`toolsSpec.parseToolsSpec`）；一处 schema 写错不该让整个插件的工具全消失，更不该让插件加载失败 |
| AI 工具授权状态被缓存 | `grantedTools()` 每次现算，不要缓存结果：用户撤权后工具还在下发，是无法解释的行为。只缓存 `tools.json` / `SKILL.md` 的解析结果（按 mtime+size） |
| 重扫后已打开视图仍用旧 manifest | 只更新注册表不够，必须 `pluginHost.refreshPluginRecords()` 重新登记 `callerRegistry`（权限/名称变了）并按需换源，否则改了权限仍被拒 |
| 存储配额超限别返回 `false` | 插件会把 `false` 当"已存上"，静默丢数据；`pluginStorage.set` 返回 `{ok,message}`，API 层抛错让插件侧 catch 到原因 |
| 渲染层根容器 `height:100%` 失效 | naive-ui Provider 包裹 div 无高度会逐层塌缩；PanelShell 的 `.shell` 用 `100vh` 锚定窗口视口，勿改回 100% |
| 全局快捷键别各自维护状态 | 唤起键与插件键共用 `hotkey.ts` 的 owner 表，一律经 `syncHotkeys()` 差量同步；直接在别处调 `globalShortcut.register` 会和这张表打架（表现为"有时能按、有时不能"） |
| 改快捷键失败不能留下旧配置 | `panel:set-plugin-hotkey` 是先写配置再注册的，注册失败必须回滚并再同步一次；否则界面显示设上了、实际没生效 |
| 插件键冲突的提示要指认对方 | 全局键改成插件已用的键时，`register` 只会返回"可能被其他程序占用"——先过 `pluginHotkeyHolder()`，把话说到具体插件名上 |
| 自定义应用不要另开一套打开逻辑 | `shortcuts.json` 里的条目在 `scanPlugins()` 时注入注册表（`source='shortcut'`、type 固定 external），启动/搜索/固定/快捷键全部复用插件链路；新增能力时改公共路径，别在 shortcut 分支里复制一遍 |
| `app.getFileIcon` 是异步的 | 扫描是同步的，所以图标只能"先读缓存再异步补"（`shortcutIcons.ts` + `shortcut-icons.json`）。别在 `scanPlugins()` 里 await，会拖住启动 |
| 删自定义应用要清引用 | `pinnedIds` / `disabledPluginIds` / `pluginHotkeys` / `pluginOverrides` 都按 id 索引，`deleteShortcut()` 必须一起清；否则同 id 再新建会"继承"上次的固定位 |
| 自定义应用的启动命令只有一处可写 | 它存在 `shortcuts.json`，所以 `panel:save-plugin-override` 对 `source='shortcut'` 直接拒绝；两处都写必然打架 |
| 遮罩必须显式压在弹窗下面 | `.overlay-backdrop` 是 absolute、`.modal` 是静态定位，同级时遮罩会盖住整个弹窗（点哪都触发"点外面关闭"）。内容必须包在 `.overlay-content`（`position: relative; z-index: 1`）；别用 `z-index: -1` 压遮罩（点击会穿透到 layer，`click.self` 失效），也别给内容加 `transform`（右键菜单是 fixed 定位会跑偏） |
| 默认唤起键别用 `Alt+Space` | Windows 把它留给窗口系统菜单，`globalShortcut.register` 直接失败，"恢复默认"会报"可能被其他程序占用"。默认值走 `config.ts` 的 `DEFAULT_HOTKEY`，经 `panel:get-config` 的 `defaultHotkey` 下发，前端不要自己写一份 |
| 空快捷键 = 主动解绑，不是失败 | `registerHotkey('')` 要返回成功、`flush()` 遇空 accelerator 不 restore；旧逻辑报失败又把旧键接回去，用户看到"清了还生效"。托盘标签在空键时不要拼后缀 |
| 矮窗口里长表单别用整体滚动 | 面板默认 560 高，表单用「头部固定 + 中间 `overflow-y:auto` + 底部固定」三段式（见 `ShortcutEdit.vue`），否则"保存"会被滚出视口，或被 sticky 页脚压住字段 |
| `abort()` 后 fetch 的 body 可能"正常结束" | 不抛 `AbortError`，只catch异常会把"用户主动停止"记成完整回答。判停看 `controller.signal.aborted`；`DOMException` 在部分运行时不继承 `Error`，`instanceof` 同样不可靠 |
| `ai.chat.send` 不能 await 到流结束 | 同页面的 `await` 会一直挂到整段回答生成完，这期间"停止"根本发不出去（我的端到端就是这样发现的）。通道只返回"已受理"，结果全走 `plugin:ai.delta` 事件 |
| preload 的 `ai.onDelta` 只保留最后一个回调 | 插件 App 在 `onMounted` 注册，脚本/测试抢在前面注册会被覆盖（一个事件都收不到）。冒烟里先等 `.composer textarea` 出现再注册 |
| AI 密钥别进日志与配置 | 只经 `main/ai/secrets.ts`（safeStorage 密文）；配置只存 `apiKeyRef` + `sk-…a1b2` 掩码，IPC 与审计里一律脱敏 |
| CDP 截图前先让窗口可见 | 面板失焦会自动收起，`Page.captureScreenshot` 在隐藏窗口上会一直挂着（表现为脚本被 kill）。先起第二个实例触发 `second-instance → showPanel`（或 `Page.bringToFront`），再截图 |

## 6. Git 与迭代流程

- 分支：`main` 保持可运行；功能分支 `feat/<主题>`、修复 `fix/<主题>`。v0.6 AI 线在
  `feat/ai` 集成分支推进，每完成一个版本合回 `main` 一次，避免半成品挡住发布线。
- 提交信息：Conventional Commits + 中文描述，如 `feat(plugins): 插件市场本地列表`、`fix(panel): 失焦隐藏在 DevTools 打开时误触发`。
- **每完成一个功能迭代，必须更新 `docs/DEVLOG.md`**（模板在文件底部），并对照 `docs/ROADMAP.md` 勾选进度。
- 版本号语义化：主版本.功能.修复；发版走 `pnpm dist`，产物入 `release/`（已 gitignore）。
- 提交前自查：typecheck ✓ → 相关 smoke ✓ → DEVLOG ✓ → `.gitignore` 没把构建产物带进来。

## 7. 文档地图

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 进程模型、五层隔离、插件协议、数据目录 |
| [docs/ai-architecture.md](docs/ai-architecture.md) | AI 应用与插件 AI 协议（分层、tools.json、授权与安全、接缝清单） |
| [docs/DEVLOG.md](docs/DEVLOG.md) | 功能开发记录（每迭代一条） |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 迭代路线与验收标准 |
| [docs/plugin-dev-guide.md](docs/plugin-dev-guide.md) | 插件开发指南（人读版） |
| `skills/quicklauncher-plugin-dev/` | 插件开发 skill（AI 用版，含脚手架脚本与 appapi 参考） |
