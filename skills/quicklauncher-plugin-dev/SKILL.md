---
name: quicklauncher-plugin-dev
description: QuickLauncher（本仓库）插件开发全流程规范：创建新的内置 web 插件或 external 外部程序集成插件、修改/调试现有插件、使用 window.appapi、让插件被内置 AI 当工具调用（tools.json / SKILL.md / MCP）、按设计令牌写界面、处理插件不被扫描/权限被拒/崩溃隔离等问题。只要用户要求"给启动器/面板加一个 XX 应用/功能/工具"、"集成 XX 外部程序"、"让 AI 能用这个插件"、动 plugins/ 目录或 plugin.json，即使没出现"插件"二字也必须使用本 skill。
---

# QuickLauncher 插件开发

本 skill 让你在 QuickLauncher 仓库里正确地开发插件：不破坏五层隔离架构、
通过 manifest 校验、正确声明权限、按令牌写界面、并完成构建注册。插件分两种：

- **web 型**：自设计的 HTML 页面应用（可与主面板同栈 Vue 3，也可纯 HTML/JS）
- **external 型**：零代码，一个 manifest 把任意 exe / 文件夹 / 网址接入面板

选型判断：需要界面和交互 → web 型；只是"拉起某个程序/网站" → external 型。
external 型不能参与 `features`、不能声明 `ai`（没有页面接住工具调用），需要这些就得写 web 型。

## 工作流

### 1. 脚手架

在**项目根目录**执行：

```bash
node skills/quicklauncher-plugin-dev/scripts/scaffold.mjs <目录名> --name "显示名" \
  [--keywords "a,b"] [--perms "storage,clipboard"] [--ai] [--external "notepad.exe 或 https://..."]
```

生成 web 型骨架：`package.json` / `vite.config.ts` / `index.html` / `public/plugin.json` /
`public/icon.svg` / `src/{main.ts,App.vue,env.d.ts}`；`--ai` 额外补 `public/ai/{tools.json,SKILL.md}`
并在 manifest 里打开 `ai` 权限。已有目录会被拒绝（加 `--force` 覆盖）。**写逻辑之前先跑它。**

### 2. 理解 manifest（校验失败 = 插件不被加载）

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✓ | 反向域名 `com.launcher.<name>`，正则 `/^[\w.-]+$/`，全库唯一 |
| `name` | ✓ | 面板显示名（中文） |
| `type` | ✓ | `web` 或 `external` |
| `entry` | web 型 | 入口 html，**相对插件目录**（构建后即相对 dist） |
| `command` | external 型 | exe 路径/命令（走 PATH）或 http(s) URL；`args` 数组可选 |
| `keywords` | 建议 | 面板搜索关键词（中英都放） |
| `permissions` | 建议 | 申请的 API 权限，见第 3 节；要参与 AI 必须有 `"ai"` |
| `features` | 可选 | 功能形态声明（**不是权限**）：目前只有 `inline` 有实际门禁，声明后才能回传内联结果 |
| `hosts` | `net` 权限必填 | 可访问的域白名单：`api.github.com`、`*.example.com`、`localhost:8080`；空 = 一个都不许 |
| `apiVersion` | 可选 | 新插件写 `2`（`window` / `ai` 字段属于这一档）；缺省按 1 加载 |
| `window` | 可选 | 建议尺寸 `{width,height}`，夹到 420–2400 × 320–1800；用户手动改过窗口后以用户记忆为准 |
| `hotkey` | 可选 | 建议启动键（accelerator，如 `Alt+Shift+V`）：只在设置页作提示，**不自动注册**，用户点了才生效 |
| `ai` | 可选 | `{tools, skill, mcp}` 三个**插件目录内的相对路径**，详见第 5 节 |

图标：目录（或 dist）内 `icon.svg` / `icon.png` / `icon.ico` 任一，由主进程转 dataURL 下发。
扫描位置：`plugins/<name>/dist/plugin.json`（web 型）或 `plugins/<name>/plugin.json`（external 型）。

**共同原则：坏一项只丢一项**。`hosts` / `features` / `hotkey` / `window` / `ai` 写错不会让插件
整体消失，只在控制台 `[plugin] <目录>: 原因` 和设置页里告警；id / name / type / entry 写错才整插件跳过。

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
appapi.ai.onToolCall(fn)                   // 权限 ai + manifest 声明 ai.tools —— 接住模型发起的调用
await appapi.exit()                        // 无需权限 —— 退出插件返回面板
await appapi.window.hide()                 // 无需权限 —— 隐藏整个面板
```

**定时器必须跟可见性走**：插件退出后视图只被摘掉不销毁（保留状态），`onUnmounted` 不会触发。
轮询一律写成 `appapi.onShow(() => start())` + `appapi.onHide(stop)`，否则插件切走后仍在后台空转。
`onShow` 注册时若已可见会立即回调一次，启动逻辑不需要在 `onMounted` 里重写。

想让"用户在主面板搜关键词就能命中插件里的某条内容"（某本手册、某个章节），用搜索贡献：
`appapi.search.set([{ id, title, keywords, intent }])`，选中后 intent 经 `onQuery` 回传；
插件目录放 `search-index.json` 可让插件没打开过也能被搜到。

想让"输入即得"（`2+3` 直接出 `5`、单位换算），在 manifest 加 `"features": ["inline"]`，
用 `appapi.onInlineQuery(({ seq, query }) => ...)` 接查询、`appapi.inline.set({ seq, items })`
回 ≤2 条结果（**120ms 内**，动作 `copy` 或 `open`）。参考 `plugins/calculator/`。

**跨桥传参陷阱**：所有 `appapi.*` 入参都会被结构化克隆，Vue 的 `reactive`/`ref` Proxy
**不能直接传**（报 `An object could not be cloned`，错误抛在 `await` 处、后续代码全不执行）。
存之前先 `JSON.parse(JSON.stringify(state))`——内置插件里的 `plain()` 就是干这个的。

完整签名、生命周期（视图缓存/恢复状态）、示例代码见 `references/api.md`。
**约定**：插件页自己监听 `keydown`，Esc 调 `appapi.exit()` 返回面板——所有内置插件都遵守。

**插件页外框**：启动器在插件外面套了顶栏 46px + 四周 8px 留白的外框（尺寸唯一来源
`src/shared/pluginFrame.ts`），已提供"返回主界面 / 独立窗口 / 关闭"。所以插件**不要自绘
关闭、返回主界面这类窗口级控件**，自己的"返回"只用于内部层级；关键按钮也别贴内容区最边缘
（留白那一圈是缩放热区的作用带）。布局用 `height: 100%` 自适应即可，进插件时面板会自动伸展。

### 4. 界面：两份 CSS + 共享浮层，破坏性操作进菜单（v0.6.6 起）

插件页和主面板是**同一块面板里的两块**，圆角、颜色、滚动条差一点就能看出"不是一家做的"。
基线只有一份，入口按这个顺序 import（顺序不能反）：

```ts
// src/main.ts 第一行
import '../../../src/shared/theme.css'      // 值：颜色/圆角/阴影/reset/滚动条
import '../../../src/shared/plugin-ui.css'  // 形：页头/按钮/输入/列表/空态/对话框
```

- **第一行不能省**。它同时提供 reset：漏掉它，`body` 默认 8px margin 叠上容器 `height: 100vh`
  就多出 16px，表现为"怎么拉伸都有滚动条"（v0.6.5 踩过）。
- **结构别自己写**：`.pl-page`（满高三段式）、`.pl-head` / `.pl-title`、`.pl-btn`（`.primary` /
  `.danger`）、`.pl-icon-btn` / `.pl-dots`、`.pl-input` / `.pl-search`、`.pl-list` / `.pl-row`
  （`.tile` 卡片行 / `.active`）、`.pl-empty` / `.pl-tip` / `.pl-hint`、`.pl-mask` / `.pl-dialog` /
  `.pl-actions`。完整清单见 `docs/plugin-dev-guide.md` 的「界面基线」。
- **不写字面量色值**：`--text-1…4`、`--line` / `--line-strong`、`--bg*`、`--accent*`、
  `--danger*`、`--r-xs…xl`、`--shadow-1…3`、`--scrim`（遮罩）、`--mark`（命中高亮）、
  `--on-accent`（主色底上的文字）。要新的语义色先加到 `theme.css`，不要就地发明。
- **浮层用共享组件，不要复制**：`src/shared/ui/{PopMenu.vue,ConfirmDialog.vue,menu.ts}`。
  宿主从 v0.6.9 起用的也是这同一份（多传 `managed`，Esc 与外部点击交给 OverlayHost），
  插件侧直接挂就行——独立构建照样能跨目录 import `.vue`。
- **破坏性操作不进按钮行**：删除/清空/卸载一律收进 `···` 或右键菜单，并过一遍 `ConfirmDialog`
  （默认焦点在「取消」）。参考 `plugins/clipboard/`（行删除 + 清空）、`plugins/translator/`（引擎删除）。
- **不用 `window.confirm`**，也别在插件页引 naive-ui：体积、风格、主题覆盖都不对，得不偿失。
- `···` 的可见性分两档：密行列表（会话项、剪贴板那种）默认隐形、hover/选中才出；
  行高足够的列表页可常驻 35% 透明。全部隐形等于入口不可发现。
- 全局 `:focus-visible` 已经画了焦点环；输入框/编辑器自己画焦点态时记得 `box-shadow: none` 覆盖掉，别叠两层。

### 5. 让 AI 能用你的插件（v0.6.2 声明，v0.6.3 可被调用，v0.6.4 可接 MCP）

插件可以把自己的能力声明成「工具」让内置 AI 助手调用，也可以写 `SKILL.md` 教模型
「什么时候该用、怎么用」。三者都可选，不声明照样能跑。

链路：模型发 `tool_calls` → 主进程校验参数与风险 → 必要时弹确认框 → 插件页 `onToolCall` 执行
→ 回执折成 `tool-result` 交回模型。一轮最多 4 个工具轮次 / 8 次调用。

```
my-plugin/
├─ plugin.json
└─ ai/
   ├─ tools.json    工具声明（模型能调用什么）
   ├─ mcp.json      MCP server 声明（要执行的命令，可选）
   └─ SKILL.md      技能说明（怎么用，按需读取）
```

```jsonc
{
  "apiVersion": 2,
  "permissions": ["ai"],                                  // 缺这行 = 一律拒绝执行
  "ai": { "tools": "ai/tools.json", "skill": "ai/SKILL.md", "mcp": "ai/mcp.json" }
}
```

- 三个路径都必须**在插件目录内**且文件存在；`../`、绝对路径、URL 会被 `safeRelative()` 拒掉。
- ⚠ `features: ["ai"]` **不是门禁**：`PLUGIN_FEATURES` 里有这个名字，但代码里没有消费点。
  真正的门槛是 `permissions: ["ai"]` + `ai.tools` 路径 + 用户在设置页授权。写了不生效，别当成必需。
- `external` 型不支持 `ai` 段（没有页面能回执，发下去只会超时）。

`ai/tools.json` 的字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 插件内唯一，小写字母开头、只含 `a-z0-9_`、≤48 字符 |
| `description` | 是 | **模型靠它决定要不要调用**。写清场景与返回什么，别写「执行操作」 |
| `title` | 否 | 界面显示名，缺省用 `name` |
| `risk` | 否 | `read` 自动放行 / `write` 每次确认（可记住）/ `dangerous` 每次确认且不可记住。**漏写按 `write`** |
| `timeoutMs` | 否 | 单次超时，1000–60000，缺省 8000 |
| `parameters` | 否 | JSON Schema（ajv 校验）；缺省为无参数 |

单插件最多 32 个工具、description ≤500 字；模型看到的名字是 `plugin:<插件 id>:<name>`。
**坏一项只丢一项**：某个工具名非法或 schema 编译不过，只少这一个，其余照常用。

接住调用（`permissions` 含 `ai` 且声明了 `ai.tools` 才有事件）：

```ts
window.appapi.ai.onToolCall(async (call) => {
  // call.name 是插件内短名（不是全局名）；call.args 已过 schema 校验
  if (call.name !== 'calculate') return { ok: false, error: `没有这个工具：${call.name}` }
  try {
    return `计算结果：${evaluate(String(call.args.expression ?? ''))}`  // 返回字符串最省事
  } catch (err) {
    return { ok: false, error: `算不出来：${(err as Error).message}` }
  }
})
```

- **返回字符串**，模型直接读；返回对象会被 `JSON.stringify`，可读性差。单条结果超 4000 字截断。
- **不要在回调里等用户操作**：超时（`timeoutMs`，缺省 8 秒）后主进程直接放弃。需要用户点头的场景
  把 `risk` 标成 `write`/`dangerous`，由主进程弹确认框，**插件里不要再弹自己的确认框**（等于两层）。
- 失败别 throw 到外面也行，主进程都会折成「执行失败：…」回给模型；throw 只是拿不到自定义措辞。
- 页面要先加载完才收得到调用：宿主会懒建一次、空闲回收、崩溃后下次重建，插件不用常驻。

`ai/SKILL.md` 只解析 front-matter 的 `name` / `description`（不引 YAML 解析器），正文等模型
需要时再按需读取（`load_skill`）——所以十几个插件都声明技能也只占几百 token。

`ai/mcp.json` 接现成 MCP server（v0.6.4）：`{servers:[{name,command,args,env,cwd,timeoutMs}]}`。
命令**默认一条都不执行**，用户在 设置 → AI → MCP 服务 里看完整 argv 逐条批准，批准绑定到
`command+args+env+cwd` 的指纹——改任何一个字符都要重新确认。执行 `spawn(shell:false)`，
只支持 stdio 与 `tools/*`；风险等级由 server 自己的 `annotations` 推断。

**授权**：工具默认全部关闭，用户在 设置 → AI → AI 工具 里按插件开开关，撤销立即生效。
`plugin:ai.chat.*`、`ai.confirmTool` 是 `internalOnly`（只有内置插件能调），第三方插件参与 AI 的
唯一姿势是**被调用**：`plugin:ai.tool-call`（主→插件）→ 执行 → `plugin:ai.tool.reply`。

### 6. 构建与调试

- vite 配置必须 `base: './'`（插件页用相对路径加载资源，dev 与打包后通用），manifest 和 icon 放 `public/`
- 构建进 `dist/`：`pnpm build:plugins`（首次必须构建，扫描器要看到 `dist/plugin.json`）
- 新插件目录是 workspace 子包（`packages: [".", "plugins/*"]` 已覆盖）；依赖没装上时先 `pnpm install`
- 开发期热更新：`pnpm dev:plugin <name>` 给单个插件起 vite dev server，主进程自动把入口切过去
  （`.dev-plugins.json` 登记，包装后不生效），改代码即时 HMR；改 manifest 仍需重新构建并重开插件
- external 型无需构建，目录里直接放 `plugin.json` + icon

### 7. 验证清单（完成前逐条过）

1. `pnpm typecheck` 零错误
2. `pnpm build:plugins` 成功，`plugins/<name>/dist/plugin.json` 存在
3. 启动应用，控制台出现 `[plugin] 已加载 N 个插件` 且 N 包含你的
4. 面板搜索 `keywords` 能命中；回车进入插件；Esc 返回
5. 若用了权限 API：故意删掉一个权限声明，确认网关拒绝（证明走的是网关）——测完恢复
6. 若声明了 AI 工具：设置 → AI → AI 工具 里能看到工具数与风险等级，再真问一句触发调用
7. 若改了插件系统本体（gateway / host / manager / inline）：跑 `pnpm smoke`
   —— 需先另起：`unset ELECTRON_RUN_AS_NODE && npx electron . --remote-debugging-port=9222`

## 铁律（违反 = 破坏互不干扰架构）

1. 不给插件宿主开 `nodeIntegration` / 关 `sandbox` / 关 `contextIsolation`
2. 插件需要的任何新系统能力：`src/shared/pluginApi.ts` 声明通道 + 权限（`PLUGIN_PERMS`）→ `src/main/plugin/api/<域>.ts` 加一条 `defineApi`（带 payload 校验）→ `src/preload/plugin.ts` 暴露 → manifest 声明。网关 `gateway.ts` 只做身份/权限/入参校验，**不要把具体能力的实现塞进网关**
3. 不在插件间提供任何直接通信/共享存储
4. 插件代码不 `eval` 用户不可信输入（计算器插件有现成的表达式解析器可抄）
5. 界面一律走 `theme.css` 令牌 + `plugin-ui.css` 骨架；破坏性操作进 `···` / 右键菜单 + 共享 `ConfirmDialog`，不进按钮行
6. AI 工具的 `risk` 如实声明；确认只在主进程那一处弹，插件不自己再弹一次
7. `ai/tools.json` 与 `ai/SKILL.md` 会进模型上下文，**只写插件自己目录内的东西**，别把它们当成读取任意文件的通道

## 常见坑

| 现象 | 原因/解法 |
|---|---|
| 面板搜不到插件 | manifest 校验失败（看主进程控制台 `[plugin] 跳过 ...`）：常见是缺 entry、entry 文件不存在、id 含非法字符 |
| 页面白屏、资源 404 | vite 忘了 `base: './'`，或用绝对路径引用了资源 |
| 插件页"怎么拉伸都有滚动条" | 入口没 `import '../../../src/shared/theme.css'`（缺 reset，body 8px margin 撑出文档溢出）；容器高度用 `100%` 而不是 `100vh` |
| 侧栏底部冒出横向滚动条 | 元素写了 `width: calc(100% - 18px)` 又加 `margin-left: 27px`，加起来超 100%。改 `width: auto` + 左右 margin，滚动容器补 `overflow-x: hidden` |
| 菜单/确认框点了 Esc 把插件退了 | 用 `src/shared/ui` 里的共享组件（在捕获阶段拦 Esc），别自己写 `keydown` 处理 |
| 调用 API 报"缺少权限" | manifest `permissions` 没声明，加上后**重新 build** |
| 改了插件没变化 | 没起 `pnpm dev:plugin <name>` 时需先 `pnpm build:plugins`；旧视图有缓存，Esc 重进即可。起了 dev server 仍不更新 → 看 `.dev-plugins.json` 是否登记、vite 是否还在跑 |
| 插件页白屏、只显示骨架 HTML | manifest 放在了插件根目录而不是 `public/`——扫描器会命中源码目录，入口变成未被 vite 处理的 `index.html`（scaffold 已修正，老目录手动挪一下） |
| `fetch('xx.md')` 拿不到本地文件 | 路径写错（相对入口 html）；跨插件读 `plugin://别的插件/…` 会被拦，路径越界返回 403。离线内容仍推荐 vite `?raw` 打进 bundle（见 `plugins/handbook/scripts/build-manuals.mjs`） |
| 图标不显示 | icon 不在插件目录/dist 根部，或扩展名不在 svg/png/ico 列表 |
| 插件里 `fetch('https://api.xxx.com')` 报 CORS | 插件页 origin 是 `plugin://<id>`，跨域被拦。改用 `appapi.net.request`（`net` 权限 + manifest `hosts` 声明该域） |
| `net.request` 报"不在 manifest.hosts 白名单内" | `hosts` 没写或写法不对（不要带 `https://` 与路径）；`*.example.com` 只放宽子域，不放开别的域 |
| 插件退出后还在跑定时器/读剪贴板 | 视图是缓存不是销毁，`onUnmounted` 不触发。用 `onHide` 停、`onShow` 启 |
| `onToolCall` 一直没被调用 | ① `permissions` 缺 `ai` ② `ai.tools` 路径写错/文件不存在 ③ 设置 → AI → AI 工具 里没给这个插件开开关 ④ 插件页还没加载完 |
| 工具调用一直超时 | 回调里在等用户操作，或干了超过 `timeoutMs` 的活。需要确认就交给 `risk`，活太慢就先返回阶段性结果 |
| 设置页显示识别到 0 个工具 | `tools.json` 是"坏一项丢一项"：name 非法、缺 description、schema 编译不过都会丢，设置页会列出原因 |
| 返回的工具结果模型读不懂 | 返回了对象（被 JSON.stringify 成一行）。直接返回字符串 |
| 改了 `ai/mcp.json` 里的命令没生效 | 指纹变了，状态回到"需重新确认"，去设置页再点一次允许 |
| dev 与打包版配置串了 | 两者共用 `%APPDATA%/quick-launcher`，必要时清掉 |
