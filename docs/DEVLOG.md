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
