# 迭代路线（ROADMAP）

> 版本语义：`主版本.功能.修复`。每个迭代开工前在此补充/细化验收标准；
> 完成后在 [DEVLOG.md](DEVLOG.md) 记录并勾选。

## v0.1.0 — MVP ✅（已完成，见 DEVLOG）

壳 + 插件系统（五层隔离）+ 3 个示例插件 + 打包。

## v0.2.x — 插件本地管理 + 市场雏形

- [x] v0.2.0 **体验优化**（已交付：图标库/托盘菜单/关键词通配与正则/右键配置/全部应用管理页/查询透传）
- [x] v0.2.1 **本地插件安装**（已交付：installed 扫描根、目录投放/目录/ZIP 安装、防 zip-slip、设置页列表/停用/卸载/打开目录）
  - 验收：✅ 手动放入目录重启即生效；✅ 面板可列出/禁用/卸载（端到端验证 7/7）
- [x] v0.2.2 **翻译插件修复与增强**（已交付：引擎排序、弹窗遮罩、自定义源直添、修复 contextBridge 传 Proxy 静默失败）
- [ ] v0.2.3 **权限确认**：安装/更新插件时弹窗列出其 `permissions`，用户确认后放行（配合"权限不申请、只声明"的现状升级）
- [x] v0.2.4 **插件详情页**（v0.2.0 已交付：右键"应用详情"弹窗展示版本/类型/目录/命令/关键词/权限，支持清除插件数据）
- [ ] v0.2.5 **插件市场本地版**：内置市场清单文件（JSON，含插件元数据 + 下载地址），下载 zip → 校验（manifest + 来源）→ 解压安装
  - 验收：面板内"市场"区可浏览、安装、打开已装插件；断网时列表可缓存

## v0.3.x — 内置应用扩充 + 体验

- [x] v0.3.0 **窗口管理**（已交付：面板拖动/8 向缩放+位置尺寸持久化、置顶钉住、插件分离独立窗口（WebContentsView 重挂载，状态保留+任务栏可见）、`appapi.window.detach()`）
- [x] v0.3.1 **翻译**（v0.2.1 已重做：webview 内嵌官方翻译页（Google/DeepL/必应/百度）+ 自定义添加翻译源 + `re:` 正则命中英文输入；不再依赖第三方翻译 API）
- [ ] v0.3.2 **截图文字识别 OCR**（系统截图 → 识别；涉及新 API：screen capture，走网关 + 权限）
- [ ] v0.3.3 **拼音搜索**：关键词支持拼音/首字母匹配（纯主面板侧实现）。※ 通配符与 `re:` 正则关键词已于 v0.2.0 完成，见 `src/renderer/src/utils/match.ts`
- [ ] v0.3.4 **主题**：深色模式跟随系统；设置页补充
- [ ] v0.3.5 **面板细节**：搜索支持文件/图片粘贴（uTools 式"粘贴即动作"）；窗口尺寸记忆

## v0.4.x — 本地文档与检索

- [x] v0.4.0 **本地程序员手册**（已交付：手册包协议 `manual.json` + 构建期打包、手册启用开关、全文搜索、自定义文档导入（走网关，`docs` 权限）、TypeScript / Linux 命令两套中文手册）
  - 验收：✅ 面板搜"手册/命令"命中；✅ 停用某手册后不再出现在列表与搜索；✅ 导入本地 md 后即时可读；✅ typecheck 零错误 + 插件构建通过
- [x] v0.4.1 **插件页外框**（已交付：进插件自动伸展窗口（默认 980×720，只放大不缩小）、外框工具条（返回主界面 / 独立窗口 / 关闭）、四周 8px 留白让缩放热区与边缘控件可用、退出还原主页尺寸）
  - 验收：✅ 主页 772×579 → 插件页 980×720 且视图随之适配；✅ 插件页可继续拉伸，视图跟随；✅ 点外框"主界面"回到主页并还原尺寸；✅ 手册插件顶栏按钮不再贴窗口边缘

- [x] v0.4.2 **搜索贡献协议 + 手册匹配词**（已交付：`search` 权限与 `appapi.search.set/clear`、条目三级索引（运行时 / 落盘 / 插件目录静态 `search-index.json`）、面板"文档与内容"分组直达 `intent`、手册管理页按本编辑匹配词）
  - 验收：✅ 面板搜 linux 只命中《Linux 命令手册》，回车直达该手册；✅ 自填"运维"后搜运维命中；✅ 停用该手册后条目消失；✅ 清空运行时索引后搜 grep 仍能靠静态索引命中；✅ smoke 30/30

- [x] v0.4.3 **插件能力契约 + 注册表网关**（已交付：`shared/pluginApi.ts` 契约（通道类型/权限表/appapi 形状）、`plugin/api/*` 一能力一文件、网关只做身份+权限+入参校验、五个内置插件删除重复 appapi 声明、入参上限硬化）
  - 验收：✅ typecheck 零错误；✅ 三端构建通过；✅ smoke 30/30（含权限拒绝、docs、storage、搜索 intent）

- [x] v0.4.4 **插件开发热更新**（已交付：`pnpm dev:plugin <name>` 起 vite dev server、`.dev-plugins.json` 登记、主进程自动换源/重载、dev server 失效回退构建产物；冒烟兼容 dev 入口并可从任意状态重跑）
  - 验收：✅ 改 `.vue` 2s 内 HMR 生效且页面状态保留；✅ 启停 dev server 时已打开的视图自动换源；✅ dev 地址失效时回退 dist；✅ smoke 30/30

- [x] v0.4.5 **插件专属协议 + 独立分区**（已交付：`plugin://<id>/…` 自定义协议替换 `file://`、每插件 `persist:plugin:<id>` 分区、跨插件读取在 session 层拦截、路径越界/隐藏文件守卫、权限默认拒绝、清数据同时清浏览器存储）
  - 验收：✅ 插件页 origin 为 `plugin://<id>`；✅ 同源 fetch 本地 json 可用、跨插件 fetch 被拦、`..%2f` 越界 403；✅ 各插件 localStorage 互不可见且重进保留；✅ 清数据后 localStorage 为空；✅ 翻译插件 webview 正常挂载；✅ dev 热更新失效时回退 `plugin://`；✅ smoke 35/35

- [x] v0.4.6 **网络能力 + 可见性事件**（已交付：`appapi.net.request`（`net` 权限 + manifest `hosts` 白名单 + 重定向逐跳校验 + 4MB 截断）、`appapi.onShow/onHide` 生命周期、剪贴板插件改为按可见性轮询、`validate.ts` 补 `int`/`oneOf`/`stringRecord`）
  - 验收：✅ 临时探针插件经主进程转发 GET/POST 成功；✅ 白名单外域与 `file://` 被拒；✅ 跨域 302 被拦、同域 302 自动跟随；✅ 未声明 `net` 即拒绝；✅ `show=1 → hide=1 → show=2` 计数正确；✅ smoke 47/47

- [x] v0.4.7 **内联结果面板**（已交付：manifest `features: ["inline"]` + `appapi.onInlineQuery` / `appapi.inline.set`（原名 `result.set`，落定时改成语义更准的 `inline`）、后台视图调度（120ms 超时 / 不排队 / 就绪补查）、面板首段渲染与回车动作（copy/open）、计算器接入）
  - 验收：✅ 输入 `2+3` 面板首行出「5」；✅ 回车复制并 toast，面板不关；✅ 非算式不产生条目；✅ 未声明 `features` 即拒绝；✅ 视图被销毁后单次输入也能自动补结果；✅ smoke 55/55

- [x] v0.4.8 **常驻成本收敛**（已交付：视图 LRU（上限 5，保护激活/分离/内联）+ `onDestroy` 收尾事件（400ms 宽限、宽限内重开撤销淘汰）、存储按 key 分片 + 原子写 + 250ms 写盘合并 + 旧 `store.json` 自动迁移、`PanelShell` 拆为 `useSearch`/`useKeyboardNav`/`useWindowResize`、vitest 单测 44 项 + GitHub Actions CI）
  - 验收：✅ 上限=1 时打开第二个插件，首个插件收到 `destroy` 并在宽限内落盘（重开读到时间戳）；✅ 旧 `store.json` 迁移后分片含原值；✅ typecheck 零错误；✅ `pnpm test` 44/44；✅ build 通过；✅ smoke 55/55

- [x] v0.4.9 **技术债收尾**（已交付：插件目录监听（`plugin/watcher.ts`，`plugin.json`/`dist` 变更 300ms 合并重扫）、重扫后刷新已打开视图的 manifest 与身份锚定、存储总量配额 8MB（环境变量可改，超限抛错说明原因）、LRU/监听/配额三条链路进冒烟（临时探针，无需环境变量与人工步骤））
  - 验收：✅ 新建/修改/删除插件目录均免重启生效；✅ 依次打开 7 个插件后最久未用的被回收、最近两个仍常驻、重开读到 `destroyed-at`；✅ 1.9MB × 8 连续写入在第 5 次被拒并提示已用/上限；✅ `pnpm test` 58/58；✅ smoke 63/63
- [x] v0.4.10 **细节优化**（已交付：插件页窗口居中到屏幕中心（尺寸/居中逻辑抽为 `panelLayout.ts` 纯函数）、外部程序型启动命令支持「浏览…」选文件并补齐 `.bat`/`.cmd`/`.lnk` 的拉起方式、原生对话框期间屏蔽失焦自动收起）
  - 验收：✅ 打开插件后窗口中心与工作区中心偏移 0px（smoke 断言）；✅ 选 `.bat`/`.lnk` 不再"点了没反应"；✅ 文件对话框打开时面板保持可见，选完焦点回到面板；✅ `pnpm test` 67/67；✅ smoke 64/64

- [x] v0.4.11 **浮层统一与失焦策略**（已交付：`windows/panelVisibility.ts` 纯函数判定失焦是否收起（立即/延迟 160ms/不收起，可设置）、可见性令牌（渲染层浮层 + 原生对话框共用）、`useOverlay` + `OverlayHost` 统一遮罩/层级/Esc/点击关闭/焦点困住与还原，三个浮层改为纯内容组件）
  - 验收：✅ 右键菜单→应用详情只留一层且焦点进浮层；✅ Tab 连续 8 次不出浮层；✅ Esc 只关栈顶、不会连面板一起隐藏；✅ 失焦策略可配置、脏值被拒；✅ `pnpm test` 80/80；✅ smoke 70/70
  - 遗留：真失焦（点桌面）无法自动化验证，交互效果需人工确认

- [x] v0.4.12 **插件快捷启动键**（已交付：`hotkey.ts` 从单键重构为 owner → 绑定表并被 `syncHotkeys()` 差量同步（幂等、每项独立成败、失败回滚原键）、`plugin/hotkeyPlan.ts` 纯函数判定该不该注册（停用/残留/占唤起键/两插件同键/非法格式）、`config.pluginHotkeys` + `panel:set-plugin-hotkey`（静态冲突预检 + 注册失败回滚）、`getPlugins` 下发 `hotkey`/`hotkeyError`/`hotkeySuggestion`、设置页新增「插件快捷键」卡片与 `HotkeyInput` 组件、manifest 新增建议值 `hotkey`（不自动注册））
  - 验收：✅ 设置插件键后 `getPlugins` 回读一致且无错误；✅ 两个插件抢同一个键被拒并指名占用者；✅ 插件键不能占用唤起键；✅ 单键（无修饰键）被拒；✅ 可清除；✅ `pnpm test` 93/93；✅ smoke 76/76（连续两轮）
  - 遗留：真按下插件键触发打开无法自动化（CDP 注入不到系统级热键），需人工确认

- [x] v0.4.13 **自定义外部应用**（已交付：`userData/shortcuts.json`（schemaVersion + 逐条容错解析）存用户自建应用，`scanPlugins()` 注入注册表（`source='shortcut'`，type 固定 external，启动/搜索/固定/快捷键全复用）；图标四级回退（用户图 → `app.getFileIcon` → favicon 2s/64KB → 分类图标+渐变）配磁盘缓存与并发 4 异步补齐；开始菜单/桌面 `.lnk`/`.url` 扫描导入（分组、去重、默认不勾选）；设置页「外部应用」卡片 + `ShortcutEdit` 表单 + `ShortcutImport` 面板；编辑入口按来源分流，删除时清理 pin/快捷键/停用引用）
  - 验收：✅ 保存后立即进插件表且带系统提取的图标；✅ external 直接拉起；✅ 名称为空/无权限目录等非法输入被拒并给原因；✅ 候选扫描（本机 182 个）与批量导入、删除即下架；✅ `pnpm test` 113/113；✅ smoke 83/83（连续两轮）
  - 遗留：`.lnk` 参数透传与注册表 App Paths 有意不做（见 architecture「已知边界」）

- [x] v0.4.14 **遮罩层级修复 + 设置分组侧栏 + 快捷键解绑**（已交付：`OverlayHost` 把遮罩 `z-index:0`、内容包 `.overlay-content`（`z-index:1`）解决"遮罩盖住弹窗、点哪都关闭"；设置页改左侧分组（快捷键/面板/应用/关于）+ 右侧滚动，带插件数徽标与切组回顶；`hotkey:''` 表示主动解绑（`registerHotkey('')` 成功、`flush` 不 restore、托盘不显示空后缀），设置页加清除按钮与无键警告；默认键改 `CommandOrControl+Shift+Space` 并由 `defaultHotkey` 下发；快捷键回调改为稳定转发函数）
  - 验收：✅ 弹窗内部 `elementFromPoint` 命中内容而非遮罩；✅ 侧栏 4 组可切换、默认快捷键组；✅ 清除唤起键后配置读回空串、显示警告、「恢复默认」可恢复；✅ `pnpm test` 123/123；✅ smoke 86/86（连续两轮）

## v0.5.x — 发布能力

- [ ] v0.5.1 **自动更新**（electron-updater + 更新源配置）
- [ ] v0.5.2 **代码签名**（证书接入，消除 SmartScreen 提示）
- [ ] v0.5.3 **安装器打磨**：自定义安装界面、安装后自启选项
- [ ] v0.5.4 **崩溃/性能看板**：本地日志文件（`userData/logs/`），插件崩溃记录

## v0.6.x — 内置 AI 应用与插件 AI 协议

> 2026-11-02 开工，设计见 [ai-architecture.md](ai-architecture.md)。已定决策：AI 界面 =
> 内置插件 `plugins/ai`；AI 服务 = 主进程 `src/main/ai/*`；协议升级纯增量（`apiVersion: 2`）；
> 工具授权按 `risk` 分级 + 审计；MCP 落在 v0.6.4。开发在 `feat/ai` 集成分支，每版合回 `main`。

- [x] v0.6.0 **AI 内核与对话**（已交付：`main/ai/{sse,chunk,provider,sessionModel,client,secrets,settings,store,chat,index}.ts`、
  内置 AI 插件 `plugins/ai`（会话列表/流式消息/模型切换/停止/复制/reasoning 折叠）、契约新增权限与功能 `ai` 及 7 条
  `plugin:ai.*` 通道 + `plugin:ai.delta` 事件流、网关新增 `internalOnly`（仅内置插件可调模型）、设置页「AI」分组
  （6 种预设 + 密钥掩码 + `/models` 探活））
  - 验收：✅ 填 key 后流式出字（mock 端点，端到端 15/15）；✅ 停止 431ms 内收到 `done{stopped:true}` 且保留已生成内容、无半截消息；
    ✅ 重启后会话仍在（分文件 + index，索引损坏可按目录重建）；✅ `secrets.bin` 密文、界面只见 `sk-…a1b2`；
    ✅ `pnpm test` 148/148（+25）；✅ `pnpm smoke` 95/95（+9）
  - 遗留：真实第三方端点未验证（本机无 key，用 mock）；`reasoning` 字段在 deepseek-reasoner 的实测形态待补
- [x] v0.6.1 **上下文与附件**（已交付：`main/ai/{tokens,extract,pdf,attach,summary}.ts`、
  token 估算与预算裁剪（CJK 按字、末条必留、中间截断）、附件抽取（txt/md/json/代码/日志 →
  GBK 回退 → docx 解 document.xml → PDF 走 unpdf 动态 import → 图片存原图 + 360px 缩略）、
  多模态 content 数组与视觉模型门槛（`visionModels` 子串匹配，不支持时提前拦下）、
  滚动摘要（只压本次被丢弃段、回答后异步、`saveSummary` 不动 updatedAt）、
  插件页拖拽/选文件与附件气泡、设置页补「上下文窗口 / 能读图的模型」、面板右键「用 AI 询问」）
  - 验收：✅ 文本附件抽取并进入请求体（冒烟）；✅ 不支持的类型被拒且说明原因；
    ✅ 图片生成缩略图并以 `image_url` 走多模态数组；✅ 面板条目信息作为上下文可见；
    ✅ `pnpm test` 186/186（+38）；✅ `pnpm smoke` 101/101（+6）
  - 遗留：PDF 中文抽取质量未实测（无样本）；摘要请求仅 mock 端点手验，未做弱网/超时压测
- [x] v0.6.2 **插件 AI 协议**（已交付：`plugin/manifestAi.ts`（apiVersion / window / ai 段校验，
  路径必须插件目录内且存在，坏一项丢一项，external 型忽略 ai）、`ai/toolsSpec.ts`（ajv 编译参数
  schema，校验器直接回「给模型看的原因」）、`ai/skillFile.ts`（front-matter 解析 + 按需加载正文）、
  `ai/tools.ts`（目录 + 授权 + mtime 缓存、`plugin:ai.tools` internalOnly 通道）、
  `config.aiToolGrants`（默认全空）、面板 AI 徽标（固定按钮出现时让位到右下角）、
  设置页「AI 工具」逐插件开关、计算器示例（`calculate` + SKILL.md））
  - 验收：✅ 计算器声明 tools.json 后图标出徽标、授权后工具进入下发清单、未授权时为空；
    ✅ 撤销授权立即停止下发；✅ 探针插件「一半好一半坏」的 tools.json 只丢坏工具、
    插件照常加载且错误有记录；✅ `pnpm test` 228/228（+42）；✅ `pnpm smoke` 109/109（+8）
  - 遗留：本版只做登记与授权，执行链路见 v0.6.3；`ai.mcp` 仅校验存在，读取在 v0.6.4
- [x] v0.6.3 **工具调用**（已交付：`ai/{toolCatalog,toolNames,builtinTools,toolExec,toolHost,toolCalls,confirm,audit}.ts`、
  内置 7 个工具（launcher_search/open、clipboard_read/write、docs_search/read、skill_read）、
  插件工具执行走「拉起居中页 → 等就绪 → send → 收执」（超时/崩溃重建一次/空闲 60s 回收）、
  风险三级确认（确认框在 AI 页内渲染，见下）、audit.jsonl、单消息 4 轮 / 8 次上限、
  `onDelta` 多订阅者 + 退订、计算器插件补 `onToolCall` 执行端）
  - 验收：✅「把剪贴板里的地址用翻译插件翻一下」全链路跑通（含 write 确认，翻译页 webview 带着地址打开）；
    ✅ `dangerous` 未获确认不执行（无「不再询问」选项）；✅ 插件超时/插件抛错以 `tool-result.error` 回给模型，
    模型据此给出最终回答；✅ `audit.jsonl` 有据可查（含 confirm=allowed/denied）；
    ✅ `pnpm test` 247/247（+19）；✅ `pnpm smoke` 124/124（+15）
  - 与设计稿的偏差：确认框没有走核心渲染层的 `OverlayHost`——插件页是原生层，核心浮层会被它盖住，
    改由 AI 页自己渲染（遮罩/Esc/焦点规则对齐）。工具宿主复用 pluginHost 视图而非独立隐藏页，
    避免同插件双实例踩存储；代价是占用 5 个常驻视图名额
  - 遗留：「插件未就绪」失败路径未在冒烟里造出来；确认超时固定 60s；内置工具没有逐项开关
- [x] v0.6.4 **MCP 接入**（已交付：`ai/{mcpSpec,mcpClient,mcpManager}.ts`、`config.aiMcpApprovals`、
  设置页「MCP 服务」分组 + `AiMcpConfirm` 确认弹窗、`panel:ai-mcp` / `panel:ai-mcp-decision`、
  冒烟用假 server `scripts/mock-mcp-server.mjs`）
  - 交付内容：`mcp.json` 解析（server 名/command/args/env/cwd/超时，坏一条丢一条）、
    **命令指纹**（`command+args+env+cwd` 的 sha256 前 32 位，落 config，改任一字符即失效）、
    自写 stdio JSON-RPC 客户端（按行分帧、initialize 握手、tools/list 翻页、tools/call、
    stderr 尾 64KB、Windows `taskkill /T` 收子进程树）、懒启动（`ensureForChat` 3s 预算）、
    连续失败 3 次本会话停用、按 `annotations` 推断风险（`destructiveHint`→dangerous、
    `readOnlyHint`→read、否则 write）、退出时收进程
  - 验收：✅ 声明的 server 默认 `pending` 且**没有进程被启动**；✅ 允许后建连并列出 2 个工具，
    模型调用 `echo` 拿到「回声：…」并把结果写进回答；✅ 改 `args` 后状态回到 `stale`
    （旧批准不再作数），重新批准才可用；✅ `crash` 工具让 server 退出码 7，
    工具以错误回给模型、**同一会话的下一轮对话仍正常**；✅ 审计能区分 `source: 'mcp'`；
    ✅ `pnpm test` 268/268（+21）；✅ `pnpm smoke` 135/135（+11，连续跑两次均通过）
  - 与设计稿的偏差：① 没用 `@modelcontextprotocol/sdk`，自写最小客户端（只要 tools 一族，
    进程/超时/崩溃计数需要自己掌控，理由与取舍写在 `mcpClient.ts` 头部）；② http 传输未做，
    只支持 stdio（社区 server 绝大多数是 stdio，http 需要额外的鉴权与证书口径）；
    ③ ~~工具宿主没做空闲回收~~（v0.6.10 补上：空转 30 分钟收掉、下次对话再拉起），
    当时不做是因为重启成本（npx 装依赖）比省下的内存贵
  - 遗留：~~`npx -y` 首次启动要下载依赖，可能超出 `MCP_CONNECT_TIMEOUT_MS`（20s）~~（v0.6.9 已给首次 45s）；
    ~~本会话停用后无「重新启用」入口~~（v0.6.9 已加「重新尝试」）；~~进程无空闲回收~~（v0.6.10）；
    `resources`/`prompts`/`sampling` 不支持；跨平台 stdio 路径差异留到 v0.7 盘点
- [x] v0.6.5 **宿主界面统一**（已交付：`src/shared/theme.css` 设计令牌、`ContextMenu` 重写、
  宿主/插件页各一份 `ConfirmDialog`、AI 会话/全部应用/设置/应用详情的破坏性操作收进 `···`）
  - 验收：✅ 颜色/圆角/阴影全部走令牌；✅ 删除类操作不再与主操作并排；✅ AI 页横竖滚动条消失
  - 遗留：~~插件页那份浮层组件与宿主重复~~（v0.6.9 已合并）；只重做了 AI 插件，计算器/记事本/翻译未对齐
- [x] v0.6.6 **内置插件统一到同一套 UI 基线**（已交付：`src/shared/plugin-ui.css`、
  `src/shared/ui/{menu.ts,PopMenu.vue,ConfirmDialog.vue}`、五个内置插件全部接入）
  - 交付内容：插件页公共层（页头/标题/按钮/图标按钮/输入框/列表行/空态/提示/表单对话框），
    只用令牌不写字面量；浮层菜单与确认框从 AI 插件提升为共享组件（宿主一份、插件一份，
    不再每个插件各抄一遍）；剪贴板的行内 `✕` 与"清空"、翻译源的删除、手册文档的删除
    全部收进 `···`/右键菜单 + 自绘确认，清空类操作从"点了就没了"变成先问一句
  - 验收：✅ `pnpm typecheck` 零错误；✅ `pnpm build:plugins` 五个插件全过；
    ✅ `pnpm smoke` 135/135（选择器契约未变）；✅ 逐屏截图核对（空态/列表/菜单/确认框/正文/管理页/表单弹窗），
    四页 `scrollWidth === clientWidth`（无横向溢出）
  - 遗留：~~`PLUGIN_FEATURES` 里的 `"ai"` 没有消费点~~（v0.6.10 已移除该名字）；
    笔记本（external 型）无页面不参与；
    浮层实现已与宿主合并（v0.6.9）；
    ~~calculator 的键盘区在超宽窗口下按键会拉得很大~~（v0.6.8 已补最大宽度）

- [x] v0.6.7 **AI 对话页体验收口**（已交付：过程折叠块、回合导航 + 回到底部、
  对话内工具授权面板、设置页/应用管理页拖动区、代码块与行内格式、输入框自动增高）
  - 验收：✅ 生成中过程展开、结束后收成一行（含用时/失败数）；✅ 长对话可跳回合、可回底部，
    向上翻历史时不被增量拽走；✅ 在对话里开关插件授权即时生效；✅ 设置/全部应用页可拖窗口；
    ✅ `pnpm typecheck` 0 / `pnpm test` 268 / `pnpm smoke` 135
  - 遗留：~~行内渲染不含表格与嵌套列表~~；~~过程块以"最后一段正文"为界~~（两项均在 v0.6.9 收掉）

- [x] v0.6.8 **计算器升级**（已交付：宽屏限宽居中、`^` 乘方、两种 `%`（取余/百分比）、
  科学计数法、`⌫ ± x² 1/x` 键、`=` 之后的三种走向、边敲边算、历史记录（持久化/召回/回填）、
  点结果即复制、带查询词打开预填）
  - 验收：✅ `pnpm test` 301 全过（新增 33 条计算器用例）；✅ `pnpm typecheck` 0；
    ✅ `pnpm build:plugins` 通过；✅ 1136×698 / 380×480 / 520×1000 三档界面核对；
    ✅ `12,345×30%` → 3,703.5、`2^10` → 1,024、`1÷0` 报错且保留表达式、`↑` 召回上一条
  - 遗留：`%` 按表达式语义（`100−30%` = 99.7 而不是 70）；历史不分天/不搜索/上限 30

- [x] v0.6.9 **收尾三笔挂账**（已交付：宿主与插件页共用一份浮层实现、AI 正文表格与嵌套列表、
  过程/回答分界改为「最后一次工具调用之后」、MCP 首次建连 45s + 停用后可「重新尝试」）
  - 验收：✅ `pnpm typecheck` 0；✅ `pnpm test` 330/330（+29）；✅ `pnpm smoke` 135/135；
    ✅ 宿主菜单上下键/分隔线/Esc 只关菜单、确认框托管模式无第二层遮罩、插件菜单不受影响；
    ✅ 表格/三层列表/引用在 1136×698 与 520×680 两档核对（窄屏容器内横向滚，页面不溢出）
  - 遗留：~~markdown 不做任务列表/嵌套引用/图片~~（v0.6.10 已补）；~~MCP 无空闲回收~~（v0.6.10）；
    ~~宿主菜单宽度自适应后右缘与触发按钮可能差几像素~~（v0.6.10 改锚点对齐）；
    MCP 仍只 stdio（无 `resources`/`prompts`/`sampling`）

- [x] v0.6.10 **再收四笔挂账**（已交付：markdown 任务列表/嵌套引用/图片/单元格 `<br>`、
  MCP 空闲回收、菜单右缘按锚点对齐、删掉 `features: ["ai"]` 这个没有消费点的名字）
  - 验收：✅ `pnpm typecheck` 0；✅ `pnpm test` 347/347（+17：渲染 17 条含四条反例）；
    ✅ `pnpm smoke` 135/135；✅ 插件页实测任务框 12×12 / 已完成取强调色 / 两层引用边框递进 /
    图片 `max-width:100%` / 单元格 `<br>` 撑成两行（49px）/ 容器仍 `pre-wrap`
  - 验收（菜单）：✅ 把菜单强行撑到 320px 宽后，菜单右缘与按钮右缘差 0px（旧写法会偏出 144px）；
    ✅ 贴边时只夹进视口、不翻转（锚点模式）
  - 说明：`features` 表如今只剩 `inline` 一项，且**只登记真有门禁的形态**；
    老 manifest 若写了 `"ai"` 会被当作未知项告警丢掉，行为与之前完全一致（它本来就不生效）

## v0.7+ — 探索项

- 多视图尺寸：插件可申请不同面板尺寸（`appapi.window.setSize`，需权限）
- 手册：整目录导入（当前为多选文件）、在线手册源（远程拉取 + 校验 + 缓存）
- 搜索：跨插件全文检索（正文入索引，需分词 + 增量更新）；条目规模上来后把线性扫描换前缀索引
- 跨平台（macOS：快捷键/托盘/通知 API 差异盘点）
- 兼容 uTools 插件协议的适配层（视用户量再评估）

## 技术债清单（随手修）

- [x] 网关 payload `any` 收紧为逐通道类型（v0.4.3 完成：契约 + `defineApi` 泛型，`any` 仅剩注册表内部一处）
- [x] `scanPlugins` 支持监听目录变化（v0.4.9 完成：`plugin/watcher.ts` + `watchPlan.ts`，打包版只监听用户安装目录）
- [x] LRU 淘汰链路纳入 `smoke`（v0.4.9 完成：7 个临时探针顶满上限，断言 target 消失 + `destroyed-at` 落盘）
- [x] 存储总量配额（v0.4.9 完成：单插件 8MB，`QUICKLAUNCHER_PLUGIN_STORE_LIMIT_MB` 可改，超限抛错）
- [ ] smoke 测试覆盖 external 型拉起（mock 命令避免真开记事本）
- [ ] 存储配额只按字节数计，未区分"关键配置"与"可重建缓存"；后续可给 `storage.set(key, value, { cache: true })` 让缓存类数据可被自动清理
