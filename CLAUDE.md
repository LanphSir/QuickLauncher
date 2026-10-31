# CLAUDE.md — AI 开发规范

QuickLauncher：全局快捷键唤起的插件化桌面启动器（类 uTools），Windows 优先。
Electron 38 + TypeScript(strict) + Vue 3 + Pinia + electron-vite + pnpm workspaces。

> 给 AI 助手的工作守则。改动前先读完本文件；与本文件冲突的做法一律以本文件为准。

## 1. 常用命令

```bash
pnpm dev              # 开发模式（会先构建内置插件再启动 electron-vite dev）
pnpm typecheck        # 三端类型检查（tsconfig.json + tsconfig.web.json）
pnpm build:plugins    # 仅构建内置插件（plugins/*/dist）
pnpm smoke            # CDP 功能冒烟（需先另起: npx electron . --remote-debugging-port=9222）
pnpm dist             # 打包 Windows 安装包 → release/<version>/
node scripts/gen-icons.mjs   # 重新生成图标（应用/托盘）
```

验证基线：**任何提交前 `pnpm typecheck` 必须零错误**；改了插件系统/网关/插件本体，再跑 `pnpm smoke`。

## 2. 架构铁律（不可违反）

这套不变量是"插件互不干扰"的根基，任何改动都不得削弱：

1. **插件渲染进程永远不碰系统能力**：`sandbox: true` + `contextIsolation: true` + `nodeIntegration: false` 是插件宿主（`windows/pluginHost.ts`）的固定配置。插件只能通过 preload 暴露的 `window.appapi` 做事。
2. **新增插件 API 必须走网关**（`plugin/gateway.ts`）：在网关注册通道 + 在 `PERMS` 表声明所需权限 + 插件 manifest 显式声明该权限，三者缺一不可。禁止任何绕过网关的直连 IPC。
3. **调用方身份锚定**：网关通过 `callerRegistry`（webContents.id → 插件）识别调用方，不信任 payload 里自带的插件 id。
4. **数据强制命名空间**：插件存储只能落在 `userData/data/<pluginId>/`（`services/storage.ts`）。不允许给插件暴露任何路径能力。
5. **插件扫描只认固定目录**（`plugin/manager.ts` 的 `getPluginRoots()`）：builtin（dev 项目 `plugins/`、打包 `resources/plugins/builtin/`）+ installed（`userData/plugins/installed/`）。manifest 校验失败即跳过，id 冲突 builtin 优先。
6. **`<webview>` 必须有权限门禁**：插件宿主虽开 `webviewTag`，但 `will-attach-webview` 只放行声明了 `webview` 权限的插件，且强制 guest 沙箱（删 preload、禁 nodeIntegration）。不要绕过这道门禁。

## 3. 代码规范

- **TypeScript strict**，禁止 `any` 逃逸到公共接口（网关 payload 处理是当前唯一 `any` 例外，逐步收紧）。
- **main/preload 是 CJS 产物**（根 package.json 无 `"type": "module"`，这是有意的：sandbox preload 只支持 CJS）。main/preload 源码里直接用 `__dirname` 定位 `out/` 内兄弟产物（如 `join(__dirname, '../preload/panel.js')`），不要用 import.meta。
- **渲染层一律 Vue 3 `<script setup lang="ts">`**；全局类型集中在 `src/renderer/src/env.d.ts`（`window.panel` / `window.appapi` 已声明，不要重复 declare）。
- **UI 图标统一用 `<AppIcon name="..." />`**（path 数据登记在 `components/icons.ts`），不要散落内联 SVG；新图标先在 `icons.ts` 登记。
- **UI 文案中文**，代码注释中文、只写"为什么"，不复述代码。日志前缀用模块名：`[plugin]`、`[config]`、`[storage]`、`[external]`。
- 命名：文件用 kebab 或与周边一致；插件 id 一律反向域名 `com.launcher.<name>`；IPC 通道前缀 `panel:*` / `plugin:*`。
- **不引入新的运行时依赖**除非确有必要；加依赖前先确认 electron 原生 API 覆盖不了。

## 4. 插件开发（高频任务）

**创建/修改任何插件之前，先加载项目内 skill：`.zcode/skills/quicklauncher-plugin-dev/SKILL.md`**，
里面有脚手架脚本、manifest 校验规则、appapi 完整参考和验证清单。要点速记：

- manifest/icon 放 `public/`（web 型），构建产物进 `dist/`；vite 必须 `base: './'`（file:// 加载）
- 插件页约定：监听 Esc → `appapi.exit()`；图标 `icon.svg`/`png`/`ico` 任一
- 插件页外框由启动器提供（`PluginFrame.vue`：返回主界面 / 独立窗口 / 关闭，顶栏 46px + 四周 8px 留白），插件**不要自绘窗口级控件**；外框尺寸的唯一来源是 `src/shared/pluginFrame.ts`，主进程算视图矩形与渲染层排版都读它
- 需要读用户自己的文档（笔记/手册/速查）→ 用 `appapi.docs.*`（`docs` 权限，主进程代管目录）；随插件发布的离线内容用 vite `?raw` 构建期打包，**不要运行时 fetch 本地文件**（`file://` 下被 CORS 拦）
- 改插件后必须 `pnpm build:plugins`（dev 不会热更新插件）
- external 型插件 = 目录里一个 `plugin.json` + 图标，零代码

## 5. 已知坑（踩过的）

| 坑 | 处理 |
|---|---|
| pnpm 10 默认拦截 postinstall，Electron 二进制装不上 | 已在 `pnpm-workspace.yaml` 配 `onlyBuiltDependencies: [electron, esbuild]`，重装后需 `pnpm rebuild electron` |
| Electron/NSIS 二进制下载慢 | 项目 `.npmrc` 已配 npmmirror 镜像，勿删 |
| `pnpm` 报 `Cannot find module ...\corepack\pnpm\<v>\bin\pnpm.cjs` | PATH 里的 pnpm shim 指向别的 nvm 版本留下的旧 corepack，与新版 pnpm 的 `bin/pnpm.mjs` 布局不兼容。修法：`npm i -g pnpm@10` 装到 `E:\npm-global`，再把 shim（`~/.workbuddy/binaries/node/versions/<v>/pnpm{,.CMD,.ps1}`）里的 corepack 路径改成 `pnpm/bin/pnpm.cjs`；版本锁 10.x 以匹配 lockfileVersion 9.0 |
| 渲染层 `<img>` 加载本地 file:// 图标会被 http origin 拦截 | 插件图标一律由主进程读文件转 dataURL 下发（`manager.ts` 的 `iconToDataUrl`），保持该做法 |
| dev 与打包版 userData 同为 `%APPDATA%/quick-launcher` | 联调时配置会互相影响，注意清理或区分 |
| `WebContents` 用 `.id` 属性，没有 `getId()` | 类型定义如此 |
| 开机自启 | 仅 `app.isPackaged` 时调用 `setLoginItemSettings`，避免开发期写用户登录项 |
| 面板 blur 隐藏 | DevTools 打开时不隐藏（`panel.ts` 已处理），调试面板 UI 不要关这个分支 |
| Vue 模板里的 `<webview>` 被当作组件解析报错 | 插件 vite 配置需 `vue({ compilerOptions: { isCustomElement: (tag) => tag === 'webview' } })`，见 plugins/translator |
| zip 安装 | 只能用 `manager.ts` 的手工解包（防 zip-slip），不要换 `extractAll` |
| 插件 IPC 报 `An object could not be cloned` | contextBridge 传参即结构化克隆，Vue reactive/ref Proxy 不能直接传 appapi；插件侧先 `JSON.parse(JSON.stringify(...))`（见内置插件 `plain()`），preload 侧的 `plain()` 只是二次保险 |
| `-webkit-app-region` 吞掉缩放热区 | drag region 按**文档顺序**做 drag 加/no-drag 减，与 DOM 层叠无关——no-drag 元素必须在 drag 元素之后（见 PanelShell 模板中 `.rz` 的位置注释） |
| 插件页白屏、只显示骨架 HTML | manifest 放到插件根目录而不是 `public/`：扫描器命中源码目录，入口成了未被 vite 处理的 `index.html`。manifest/icon 一律进 `public/` |
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
