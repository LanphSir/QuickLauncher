# 功能开发记录（DEVLOG）

> 目的：按迭代记录功能层面的主要变更，让任何开发者（人或 AI）不用翻代码就能知道
> "这个项目每一步做了什么、为什么这么做、验证到什么程度"。
>
> 记录规则：
> 1. **每完成一个可交付的功能迭代就追加一条**，不记细枝末节的修复（那些看 git log）
> 2. 新条目加在最上面，版本号遵循 [ROADMAP.md](ROADMAP.md) 的迭代规划
> 3. "关键文件" 只列本次变更的核心文件，不穷举
> 4. "验证" 必须写实际执行过的验证手段与结果，没验证的写"未验证"

---

## v0.4.1 — 插件页外框：自适应窗口 / 可缩放 / 一键回主页（2026-10-31）

**目标**：修掉实测暴露的三个体验缺陷——插件页继承主页的小尺寸且无法拉伸、插件内容贴边导致边缘控件不好点、
插件内部返回只能一级级退、没有"直接回主界面"的入口。

### 问题与根因

| 现象 | 根因 |
|---|---|
| 进插件后窗口还是主页大小（760×560），拖边缘没反应 | 插件 `WebContentsView` 的 bounds 直接取窗口全尺寸（`x:0,y:0,w,h`），原生视图盖住了面板渲染层的 8 向缩放热区，指针事件到不了 DOM |
| 插件内部贴边按钮（如手册顶部"返回"）不好点 | 同上：视图贴死在窗口边界，标题栏/按钮正好落在窗口边缘，和缩放热区、圆角裁切重叠 |
| 想回主界面只能靠插件的 `appapi.exit()`，第三方插件不一定有 | 外框能力缺失，导航责任被推给了插件作者 |

### 功能变更

| 模块 | 变更 |
|---|---|
| 插件页外框 | 新增 `PluginFrame.vue`：顶部 46px 工具条（`‹ 主界面` / 插件图标+名称 / 独立窗口 / 关闭），窗口拖拽区在工具条空白处；主页内容在插件打开时整块卸载，避免被原生视图盖住还抢焦点 |
| 布局单一来源 | 新增 `src/shared/pluginFrame.ts`（`header:46 / inset:8 / radius:10` + `pluginViewRect()`），主进程算视图矩形、渲染层排外框共用，杜绝两边对不上 |
| 自适应窗口 | `enterPluginLayout()`：进插件时按 `config.pluginBounds` 或默认 980×720 伸展（上限工作区 94%，只放大不缩小，水平居中对齐）；`leavePluginLayout()` 还原主页尺寸并记住本次插件尺寸 |
| 边缘留白 | 视图四周留 8px、顶部让出工具条，视图设白底 + 10px 圆角；留白带让缩放热区可点，边缘控件也不再贴死窗口边界 |
| 网关/桥 | `panel:exit-plugin`（回主页）、`panel:detach-active`（当前插件甩到独立窗口）、`panel:plugin-opened` 事件；`window.panel.exitPlugin/detachActive/onPluginOpened` |
| 持久化 | `savePanelBounds()` 在插件页里保存的是**主页**尺寸，避免下次唤起主页拿到插件的大窗口 |

### 关键文件

- `src/shared/pluginFrame.ts`（新增）、`src/renderer/src/components/PluginFrame.vue`（新增）
- `src/main/windows/panel.ts`（进出插件页的窗口伸展/还原）、`src/main/windows/pluginHost.ts`（视图矩形、外框事件、分离/崩溃路径的还原）
- `src/main/index.ts` / `src/preload/panel.ts` / `src/renderer/src/env.d.ts` / `PanelShell.vue`
- `docs/plugin-dev-guide.md`（插件页外框约定）、`scripts/smoke.mjs`（5 条新断言）

### 关键决策

1. **外框由启动器提供，而不是插件自绘**：所有插件一致，且第三方插件不需要知道"窗口边缘在哪"，也不会和外框抢点击。
2. **尺寸常量放 `src/shared`**：这是主进程与渲染层唯一必须逐像素对齐的地方，放两份注释必然会漂移。
3. **只放大不缩小**：用户把主页拉得更大时，开插件不该被压回去；插件页尺寸单独记 `pluginBounds`，主页尺寸仍由 `panelBounds` 管。
4. **留白 8px 兼作缩放热区作用带**：透明无边框窗口只能自实现缩放，原先被原生视图挡住的根因就是"没有留白"。

### 验证

- `pnpm typecheck` 零错误；`pnpm build` 通过
- `pnpm smoke` **27/27 通过**（新增：插件页自动伸展窗口、外框返回主界面按钮、点击返回后主页回来、窗口尺寸还原、插件视图尺寸 = 窗口 − 46 − 16）
- 人工 CDP 实测：主页 772×579 → 进插件 980×720（视图 964×666）→ 改为 1100×800（视图 1084×746，跟随 resize）→ 退出还原 772×579；外框截图核对按钮位置与卡片留白

### 遗留事项

- 插件不能申请自己的初始尺寸（ROADMAP v0.6「多视图尺寸」）；当前统一 980×720 起步
- 外框只有"返回主界面/独立窗口/关闭"，还没有置顶、投屏、多开等 uTools 式工具项

---

## v0.4.0 — 本地程序员手册：手册包 + 启用开关 + 自定义文档（2026-10-30）

**目标**：把"随手查"这件事做进启动器——内置几本中文手册离线可读，能按需只留要用的那几本，
也能把自己的 Markdown 扔进来；协议要能持续加手册，而不是写死两本。

### 功能变更

| 模块 | 变更 |
|---|---|
| 手册插件 | 新增内置插件 `com.launcher.handbook`（web 型）：左侧手册/章节树 + 右侧正文阅读、`/` 聚焦搜索、Esc 逐级返回（章节 → 手册 → 面板）、代码块一键复制、阅读位置记忆 |
| 手册包协议 | `manuals/<name>/manual.json`（id/title/description/keywords/order/source/license/chapters）+ 章节 markdown；`chapters` 省略则按文件名自动收录。加一本手册 = 丢一个目录 + `pnpm build:plugins` |
| 构建期打包 | `scripts/build-manuals.mjs` 校验清单 → 用 vite `?raw` 生成 `src/data/manuals.generated.ts`，正文进 bundle，离线可读（插件页是 `file://`，运行时 fetch 被 CORS 拦） |
| 启用/停用 | 右上角「手册管理」逐本开关，存 `disabled-ids`（存"停用"而非"启用"，新手册默认可用、无需迁移）；停用的手册同时从列表和全文搜索里消失 |
| 全文搜索 | 跨已启用手册建索引（`plainText` 去语法符号），每个章节给 2 段带高亮摘要；点结果打开章节并滚到正文首处命中（`.found` 闪烁标记） |
| 自定义文档 | `appapi.docs.*`（新 `docs` 权限）：`import` 弹系统文件框多选（.md/.markdown/.txt）、`list`/`read`/`remove`/`reveal`；文件落在 `userData/data/<pluginId>/docs/`，**路径不出主进程**，句柄只接受纯文件名 |
| 文本解码 | UTF-8 优先，解码出现替换字符时回退 GBK（中文技术文档 GBK 很常见），单文件上限 4MB |
| 网关 | `plugin:docs.{list,import,read,remove,reveal}` 五个通道 + `PERMS` 映射到 `docs` |
| 测试数据 | 从 GitHub 拉真实文档：TypeScript 官方手册中文版 16 章（`zhongsp/TypeScript`）+ Linux 命令手册 35 条（`jaywcjlove/linux-command`，MIT） |
| 顺手修 | 脚手架把 manifest/icon 写到插件根目录（导致扫到源码目录白屏）→ 改为写 `public/`；`smoke` 扩到 22 项 |

**文档漂移清理（同日）**：`DEVLOG.md` 恢复"新条目在最上面"（v0.1.0 移到末尾）；`ROADMAP.md` 对齐版本口径——v0.2.2 按实际交付（翻译修复）勾选，插件市场顺延 v0.2.5，v0.2.4 详情页按 v0.2.0 已交付勾选，发布能力整体顺延到 v0.5.x。

### 关键文件

- `src/main/services/docs.ts`（新增：文档库命名空间、导入/读取/删除、GBK 回退）
- `src/main/plugin/gateway.ts`（docs 五通道 + PERMS）、`src/preload/plugin.ts`（`appapi.docs`）
- `plugins/handbook/`（App.vue / markdown.ts / types.ts / scripts/build-manuals.mjs / manuals/）
- `scripts/smoke.mjs`（手册加载、正文渲染、docs 通道与权限拒绝）、`.zcode/skills/.../scaffold.mjs`

### 关键决策

1. **随插件发布的内容走构建期打包，用户内容走网关**：两条路各管一段，既有离线能力，又不给插件任何文件系统能力。
2. **自写 markdown 渲染器而不是引依赖**：只需标题/段落/列表/代码/表格/引用；解析结果全部先转义再拼标签、链接只放行 http(s)/mailto/锚点，`v-html` 上不存在注入面。顺带支持了 setext 标题（`ls` + `===`），Linux 命令手册整篇都是这种写法。
3. **存"停用列表"而非"启用列表"**：以后加手册不用写迁移逻辑，老用户自动获得新手册。
4. **搜索索引只覆盖已启用手册**：停用即"这台机器上没有这本"，语义一致，也省内存。
5. **正文高亮不复用侧栏结果的 `.hit` 类**：`.hit` 是 `display:flex` 的列表项，套到 `<p>` 上会把段落拆成竖排（本轮踩到并修掉）。

### 验证

- `pnpm typecheck` 零错误；`pnpm build:plugins` 通过：2 本手册 / 51 章，bundle 611KB（gzip 211KB）
- `pnpm smoke` **22/22 通过**（新增：手册插件独立进程加载、手册列表 2 本、章节正文 26 个块、`docs` 通道可用、`docs` 权限未声明即拒绝）
- 人工 CDP 实测 8 个场景截图核对（欢迎页/章节树/正文/代码块/搜索/命中跳转/管理页/Linux 命令页），修复两个渲染缺陷：段落被拆成竖排（类名冲突）、中文 `*强调*` 不解析
- 面板搜索「手册」「linux」「命令」均可命中该插件（keywords）

### 遗留事项

- 自定义文档只支持多选文件，未支持"整目录导入"
- 正文无目录（TOC）与锚点跳转；markdown 里的图片未加载（离线包通常没有本地资源）
- 自定义文档一次性全量读进内存建索引，文档很多时需要改成懒加载/分页
- 手册内容随仓库走，更新要重新发版（在线手册源见 ROADMAP v0.6）
- 插件未纳入 `pnpm typecheck`（只有 vite 构建），插件侧类型仅靠各自 `env.d.ts` 自觉

---

## v0.3.0 — 窗口管理：拖拽缩放 / 置顶钉住 / 插件分离独立窗口（2026-10-25）

**目标**：让面板从"固定尺寸的弹窗"升级为可长驻使用的工作窗口，并解决"频繁切换插件被收起"的痛点。

### 功能变更

| 模块 | 变更 |
|---|---|
| 窗口拖动 | 搜索行空白处为拖拽区（`-webkit-app-region: drag`，输入框/按钮排除），按住可移动面板 |
| 窗口缩放 | **自实现 8 向缩放**（四边+四角热区，指针捕获 + rAF 节流 + IPC setBounds）——Electron 透明无边框窗口不支持系统边缘缩放（官方文档明确限制）；最小 520×400；缩放结束/隐藏时持久化 `panelBounds`，重启恢复位置尺寸（跨显示器钳制进工作区） |
| 置顶钉住 | 标题栏图钉按钮切换：钉住时**点击面板外不自动收起**（blur 隐藏被跳过；Esc/快捷键/托盘仍可隐藏），状态同步到渲染层高亮 |
| 分离独立窗口 | 右键应用"在独立窗口打开"、详情弹窗按钮、插件内 `appapi.window.detach()` 三种入口；实现方式是**整个 WebContentsView 重挂载到新 BrowserWindow**——渲染进程与页面状态原样保留，原生标题栏、可拖拽缩放、**出现在任务栏/Alt-Tab**；已分离时再次打开=聚焦该窗口并透传搜索词；分离窗口内 Esc/exit=关闭窗口；每插件分离尺寸记忆（`windowStates`） |
| 其他 | 卸载/崩溃时同步销毁分离窗口；重复分离幂等 |

### 关键决策

1. **缩放自实现而非去透明化**：官方文档明确透明窗口不支持边缘缩放；保留圆角+阴影视觉，8 个热区方案可控且跨平台一致。
2. **分离=重挂载而非新开窗口加载 URL**：WebContentsView 可在窗口间移动，插件进程与页面状态零丢失（输入到一半的翻译、剪贴板列表都在）；新开 URL 的方案做不到。
3. **已分离时再次打开=聚焦**：避免双实例状态分裂；搜索词仍通过 `plugin:query` 透传。
4. **分离窗口用原生标题栏**：独立窗口要的就是任务栏/拖拽/缩放这些系统行为，没必要再自绘。
5. **exit 语义按宿主区分**：面板内 exit=回主页；分离窗口 exit=关窗（符合独立应用的直觉）。

### 验证

- 三端 typecheck 零错误；smoke 扩至 **17/17**（新增：置顶切换、setWindowBounds 实测 760→880、8 热区渲染、分离/重复分离幂等/分离窗口内退出即关窗）
- 排查记录：连续几次"启动失败"为测试环境污染——上一实例未死透时单实例锁使新启动秒退，而 `tasklist|grep` 在中文 locale 下不可靠导致误判"无进程"；应用代码本身无问题（t=2s 端口即 200）

### 修复补记（同日，用户实测反馈"左右可缩放、上下不行"）

用户实测发现仅左右可缩放。排查确认**两个独立根因**，均已修复：

1. **顶边被拖拽区吞掉（原生层）**：搜索行 `-webkit-app-region: drag` 的盒子从面板 y=0 开始；
   Electron 的 drag region 按**文档顺序**做"drag 矩形加、no-drag 矩形减"——缩放热区在模板里排在
   搜索行之前（先减去），搜索行随后又把整块矩形加回，顶边热区被覆盖成 HTCAPTION（移动而非缩放）。
   修复：`.rz` 显式 `no-drag` + **热区移到模板末尾**（最后做减法）。教训：`no-drag` 抠除与
   DOM 层叠无关，必须保证文档顺序在 drag 元素之后。
2. **底边热区悬空 33px（渲染层）**：naive-ui 的 `NConfigProvider`/`NMessageProvider` 包裹 div
   无高度，`.shell` 的 `height:100%` 对 auto 父级解析成内容高度 → 卡片比窗口矮 33px，
   底边热区浮在窗口内的透明死区。修复：`.shell` 改 `height: 100vh` 直接锚定窗口视口。

**验证手段升级**：CDP 合成鼠标事件绕过浏览器进程原生命中测试（HTCAPTION 发生在该层），无法覆盖此类
问题；改用 **PowerShell SendInput 操作系统级注入** + 按 PID `GetWindowRect` 取真实物理矩形做
DIP→物理坐标映射（每次拖拽后刷新矩形，多显示器/缩放下 DIP×dpr 的朴素换算不成立）。
四边真实拖拽 **4/4**（顶边 h+60/y-60、底边 h+60、左边 w+60/x-60、右边 w+60），smoke 17/17 回归。

---

## v0.2.2 — 翻译插件修复与增强：引擎排序 / 弹窗遮罩 / 自定义源直添（2026-10-25）

**目标**：修复用户反馈的三个翻译插件问题，并顺带揪出一个影响所有插件的 IPC 深坑。

### 功能变更

| 模块 | 变更 |
|---|---|
| 引擎排序 | 翻译源标签悬停显示 ↑/↓，顺序即打开默认引擎，持久化到 `source-order`（未知 id 自动追加，预置与自定义源统一排序） |
| 添加弹窗 | 遮罩加深至 45% 并提升 z-index；**移除点击遮罩关闭**（原 `@click.self` 在输入框内选中文本、鼠标在遮罩上松开时会误关），关闭仅走 取消/✕/Esc；新增 ✕ 按钮 |
| 自定义源直添 | 允许直接粘贴纯网址（不再强制 `{q}`）：不含占位符时后台自动补 `?q={q}`（URL 已含 `?` 则用 `&`）；点击引擎标签即创建 webview 打开站点主页（原先无查询词时什么都不显示——这是"添加后无法打开页面"的真正原因之一）；表单含占位符说明 |
| 保存失败可见性 | addSource 全程 try/catch，存储失败时弹窗保持打开并显示错误（原先静默中断，表象是"点了添加没反应"） |

### 根因分析（重要，写进规范的坑）

"添加翻译源无效"的元凶是 **contextBridge 传参即结构化克隆**：`storage.set('custom-sources', custom.value)`
传的是 Vue 响应式 Proxy 数组 → 桥在 preload 代码执行**之前**就拒绝（`An object could not be cloned`）
→ `await` 处中断 → `activate()` 未执行 → webview 不创建、弹窗不关，表象极其迷惑。
排序之所以能存，是因为它恰好是字符串数组。**剪贴板插件的历史保存也因此一直静默失败**（本次一并修复）。

修复分层：插件侧调用前 `JSON.parse(JSON.stringify(...))` 转纯数据（`plain()`，两个内置插件已加）；
preload 侧保留 `plain()` 作二次保险；文档（插件指南/skill api.md/CLAUDE.md 已知坑）均已收录该坑。

### 验证

- 三端 typecheck 零错误
- 翻译插件专项 **14/14**：查询透传、多引擎切换、遮罩存在且可见（computed bg=rgba(15,18,25,0.45)|z50）、
  纯网址添加、`{q}` 自动补全（youdao `?q=hello` 实测导航成功）、点击遮罩不关闭、Esc 关闭、
  排序生效且持久化
- **跨重启持久化**：自定义源与顺序重启后保留（2/2）；验证残留已清理，用户存储恢复默认
- 排查期间发现两次"假失败"：上一实例未死透时单实例锁使新启动退出、CDP 连到旧进程——
  跑 CDP 验证前必须确认 electron 进程已清空

---

## v0.2.1 — 本地插件安装 + 翻译插件官方网页多引擎版（2026-10-25）

**目标**：落地 v0.2.1 规划的本地插件安装闭环；翻译弃用自建 API，改为内嵌官方翻译网页（减少适配难度），支持多引擎并存与自定义添加。

### 功能变更

| 模块 | 变更 |
|---|---|
| 本地插件安装 | 扫描根增加 `userData/plugins/installed/`（builtin 与 installed 双来源，id 冲突 builtin 优先）；**目录投放重启即生效**；面板"全部应用"页支持从目录/ZIP 安装（原生对话框）；ZIP 手工解包防 zip-slip（过滤 `..` 路径穿越与 node_modules）；安装即校验，失败自动回滚 |
| 插件管理 | 设置页新增"插件管理"：全部插件列表、启用/停用开关（`disabledPluginIds`，停用后不进面板、打开被拒）、卸载（仅 installed 来源，插件文件删除/数据保留）、打开插件目录 |
| 翻译插件 v2 | 弃用 MyMemory API，改为 **webview 内嵌官方翻译页**：Google / DeepL / 必应 / 百度四引擎并存，左侧切换（各引擎独立 webview 懒创建、状态保留）；**自定义添加翻译源**（名称 + 含 `{q}` 占位符的 URL 模板，存 storage，可删除）；"浏览器打开"当前页；查询词经 onQuery 自动导航翻译 |
| webview 权限 | 新增 `webview` 权限：插件宿主开 `webviewTag`，`will-attach-webview` 网关式校验——未声明权限的插件嵌入被拦截，放行时强制 guest 沙箱（删 preload、禁 nodeIntegration、contextIsolation+sandbox） |
| IPC | panel:* 新增 install-plugin / uninstall-plugin / set-plugin-disabled / reveal-plugin-dir / plugins-changed 事件；pluginHost 新增 destroyPlugin（卸载时销毁缓存视图） |

### 关键文件

- `src/main/plugin/manager.ts`（双扫描根、installPluginFromPath、uninstallPlugin、zip 安全解包）
- `src/main/windows/pluginHost.ts`（webviewTag + will-attach-webview 门禁 + destroyPlugin）
- `src/main/{index.ts,config.ts}`；`src/preload/panel.ts`
- `src/renderer/src/components/{AppManage,SettingsView}.vue`；`stores/launcher.ts`（过滤停用）
- `plugins/translator/`（webview 多引擎重写，vite `isCustomElement` 声明 webview 标签）

### 关键决策

1. **webview 而非 iframe**：官方翻译站普遍有 X-Frame-Options，iframe 全军覆没；webview 是独立 guest 进程不受限，且能按权限门禁——符合"减少适配难度 + 保持隔离架构"。
2. **安装采用"拷贝进 installed 根"而非引用原路径**：与未来市场下载安装统一语义，插件目录不可变原则不被破坏。
3. **ZIP 手工解包而非 adm-zip extractAll**：规避 zip-slip，同时顺带过滤 node_modules 垃圾。
4. **停用而非删除内置插件**：builtin 不可卸载（随包发布），只允许停用。
5. **翻译源 = URL 模板**（`{q}` 占位符）：把"适配"简化为一条 URL，任何翻译网站都能接入。

### 验证

- 三端 typecheck 零错误；插件构建通过；smoke 回归 10/10
- 专项验证 **7/7**（临时脚本）：目录投放→重启扫描（source=installed）→ 停用后打开被拒 → 重新启用 → 卸载移除；翻译插件查询透传后 webview 成功加载 `translate.google.com/?...text=hello`
- 已知限制：翻译页内嵌属网页级集成，站点自身改版/风控（如 Google 地区跳转）由官方页面自理，这正是选择 webview 的原因；个别站点如拒绝自动填充查询词，可手动粘贴

---

## v0.2.0 — 体验优化：图标库 / 托盘菜单 / 关键词通配与正则 / 右键配置 / 全部应用管理（2026-10-25）

**目标**：把 MVP 的粗糙处打磨到位——图标体系、托盘面板、搜索匹配能力、插件配置入口，并新增一个真实场景插件（翻译）。

### 功能变更

| 模块 | 变更 |
|---|---|
| 图标库 | 新增统一线性图标组件 `AppIcon.vue`（`icons.ts` 登记 path，18 个图标），替换全部内联 SVG；无自定义图标的插件按名称/关键词/ID 推断分类默认图标（翻译→地球、计算→计算器等 5 类），配 6 色渐变底（按插件 id 稳定散列）；external 型应用卡片带 ↗ 角标 |
| 托盘菜单 | 重写为功能面板：快捷键提示、📌 常用插件子菜单（随固定/取消固定实时重建）、⚙ 设置入口（直达设置页）、ℹ 关于（版本+运行时信息）、开机自启；Windows 原生菜单不支持逐项图标，用 emoji 前缀替代 |
| 关键词匹配 | `utils/match.ts`：普通子串之外支持通配符（`*`/`?`，整词匹配）与 `re:` 前缀正则（对整个查询词 test）；非法正则静默跳过。典型用法：`"keywords": ["翻译", "re:^[a-zA-Z][a-zA-Z0-9@._\\- ]{1,120}$"]` 让任意英文输入命中翻译应用 |
| 右键配置 | 应用卡片右键菜单：打开 / 固定·取消 / 应用详情 / external 编辑启动命令 / 浏览器搜索；详情弹窗展示版本、类型、ID、目录、启动命令、关键词、权限（chips），web 型支持"清除插件数据"（NPopconfirm 二次确认） |
| 插件配置覆盖 | external 型启动命令可被用户覆盖：`config.json#pluginOverrides`（`command`/`args`），扫描加载时应用、详情页"恢复默认"还原磁盘原始值；插件文件永不被修改 |
| 全部应用管理页 | 主页"全部 ›"进入：搜索过滤 + 行式列表（类型徽章、双击打开、打开/固定/详情操作） |
| 查询透传 | 打开插件时携带面板搜索词：主进程 `plugin:query` → preload 缓冲 → 插件 `appapi.onQuery`（解决页面加载与监听注册的时序竞争） |
| 面板细节 | 显示入场动画（scale+fade）、底部操作提示栏（↑↓/Enter/右键/Esc）、"全部 ›"入口、空态文案提示通配符、外链搜索 |
| 新插件 | **快速翻译**（com.launcher.translator）：演示 `re:` 正则命中英文输入 + onQuery 自动填充 + MyMemory 免费 API（中英互译自动判断语向）+ 历史记录（storage） |

### 关键文件

- `src/renderer/src/components/{icons.ts,AppIcon.vue,ContextMenu.vue,PluginDetail.vue,ExternalEdit.vue,AppManage.vue}`（新增）
- `src/renderer/src/utils/{match.ts,appFallback.ts}`（新增）；`stores/launcher.ts`、`components/{PanelShell,AppTile}.vue`（重写）
- `src/main/{index.ts,tray.ts,config.ts}`、`plugin/manager.ts`（覆盖应用）、`services/storage.ts`（clear）、`windows/pluginHost.ts`（payload）
- `src/preload/{panel,plugin}.ts`（API 扩展 + query 缓冲）；`plugins/translator/`

### 关键决策

1. **Windows 原生菜单不支持逐项图标**（Electron 平台限制）→ 托盘菜单用 emoji 前缀 + 子菜单结构达成"有图标的面板"体验，不引入自定义 HTML 弹窗的复杂度。
2. **正则匹配放渲染层而非主进程**：匹配是纯字符串逻辑，主面板进程崩溃有单实例锁兜底；正则风险（回溯）靠短查询词 + try/catch 控制，文档明示插件作者责任。
3. **插件配置覆盖存全局 config 而非改写插件文件**：保持插件目录不可变（未来市场安装/更新才有清晰的升级语义），baseCommand 保留用于"恢复默认"。
4. **onQuery 用 preload 缓冲而不是主进程延时重发**：时序问题在接收端解决最可靠，preload 先于页面脚本运行，天然有缓冲窗口。

### 验证

- 三端 typecheck 零错误；4 个插件全部构建成功
- CDP 冒烟 **10/10 通过**（新增第 10 项：DOM 级输入 `hello world` → 断言"快速翻译"被 re: 正则命中出现在结果网格；另将快捷键断言放宽为格式合法——用户已把热键改为 CommandOrControl+Shift+Space，属预期用户状态）
- 权限拒绝、插件崩溃隔离、外部程序集成回归通过（smoke 原有项）

### 遗留事项

- 通配/正则命中关键词不高亮显示；拼音搜索仍未做（ROADMAP v0.3.3）
- 翻译用的是免费公共 API（MyMemory），无 SLA；正式版应接自有服务或本地词典
- 托盘"常用插件"子菜单暂只含 web 型（external 直接点击启动语义不明确）
- 右键菜单/详情弹窗暂无键盘导航（鼠标为主）

---

## v0.1.0 — MVP：壳 + 插件系统 + 示例应用（2026-10-25）

**目标**：跑通"快捷键唤起 → 搜索/点击 → 插件运行"的完整闭环，并落实插件间互不干扰。

### 功能变更

| 模块 | 变更 |
|---|---|
| 应用壳 | 无边框透明主面板（760×560，居屏上方 16% 显示）；全局快捷键唤起/隐藏（默认 Alt+Space，可录制修改，冲突回滚）；失焦/Esc 自动隐藏（DevTools 打开时不隐藏）；托盘常驻（显示/隐藏、开机自启、退出）；单实例锁（二次启动唤起面板） |
| 主面板 UI | 按参考截图实现：大搜索框（占位"搜索功能 / 粘贴文件、图片"）+ 已固定网格 + 全部应用网格；↑↓/Enter/Esc 键盘导航；图钉固定/取消固定（持久化到 config）；设置页（快捷键录制、开机自启开关） |
| 插件系统 | 自定义插件协议 `plugin.json`（id/name/type/entry/command/keywords/permissions）；扫描 `plugins/*/dist` 与免构建目录，manifest 严格校验后注册；web 型插件每插件一个独立 `WebContentsView`（独立渲染进程），退出后缓存视图保留状态；external 型经 spawn/shell 拉起后自动隐藏面板 |
| 插件 API | `window.appapi`（preload + contextBridge 注入）：storage / clipboard / notify / shell.openExternal / window.hide / exit / info；主进程网关按 manifest 声明的权限逐调用校验，未声明即拒绝 |
| 示例应用 | 剪贴板历史（轮询剪贴板 + storage 持久化，演示三大权限）；计算器（自写递归下降表达式解析器，不用 eval，演示纯 UI + 键盘操作）；记事本（external 型，0 代码集成 notepad.exe） |
| 隔离 | 五层：进程隔离（插件崩溃仅影响自身，面板 toast 提示）· 上下文隔离（sandbox+contextIsolation）· 权限校验 · 数据按插件 id 强制命名空间 · 加载隔离（目录白名单 + manifest 校验 + id 去重） |
| 工程 | pnpm workspaces（根应用 + `plugins/*` 子包）；electron-vite 三端构建；electron-builder 打包（NSIS）；图标由 `scripts/gen-icons.mjs` 纯代码生成（PNG 编码 + 像素绘制，无设计资源依赖） |

### 关键文件

- `src/main/`：`index.ts`（装配/单实例/面板 IPC）、`windows/panel.ts`、`windows/pluginHost.ts`、`plugin/{manager,gateway,callerRegistry}.ts`、`services/{storage,external}.ts`、`hotkey.ts`、`tray.ts`、`config.ts`
- `src/preload/{panel,plugin}.ts`（两座桥）
- `src/renderer/src/`：`components/{PanelShell,AppTile,SettingsView}.vue`、`stores/launcher.ts`
- `plugins/{clipboard,calculator,external-notepad}/`
- `scripts/{gen-icons,collect-plugins,smoke}.mjs`
- `docs/{architecture,plugin-dev-guide}.md`

### 关键决策

1. **Electron 而非 Tauri**：插件进程级隔离（WebContentsView）是"互不干扰"的核心诉求，Electron 最成熟；uTools 同源方案。
2. **自定义插件协议而非兼容 uTools**：简化协议面，保留未来兼容的可能。
3. **退出插件不销毁视图**：缓存 WebContentsView，重进恢复状态；唤起面板则回主页。
4. **权限不申请、只声明**：MVP 无授权弹窗，manifest 声明即放行；市场上线时再加强制确认。
5. **内置插件也走同一套扫描/校验/网关**：与用户后续安装的插件无特权差异，保证协议真实可靠。

### 验证

- 三端 TypeScript 严格模式类型检查：零错误
- CDP 功能冒烟（`scripts/smoke.mjs`）：**9/9 通过**（桥注入、插件扫描、图标 dataURL、配置读写、插件独立进程加载、插件桥注入、storage 读写、插件身份、权限拒绝）
- 权限模型实测：calculator（未声明 clipboard）调用被网关拒绝，错误信息含修复指引
- 打包验证：`release/0.1.0/QuickLauncher Setup 0.1.0.exe`（约 107MB），打包版启动加载 3 个内置插件无报错，`resources/plugins/builtin/` 资源完整

### 遗留事项

- 插件视图缓存无上限（建议 LRU）
- 无插件市场 / 自动更新（见 ROADMAP v0.2 / v0.4）
- 开机自启仅打包版生效（设计如此）
- 面板搜索不支持拼音匹配、不支持文件/图片粘贴动作

---

<!-- 新条目模板（复制后填写，放本注释之上）：

## vX.Y.Z — 迭代标题（YYYY-MM-DD）

**目标**：一句话。

### 功能变更
| 模块 | 变更 |
|---|---|

### 关键文件
-

### 关键决策
1.

### 验证
-

### 遗留事项
-

-->
