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

## v0.4.14 — 遮罩层级、设置分组侧栏、快捷键可解绑（2026-11-01）

**来源**：三条实测反馈——① 弹窗"遮罩压在弹窗上面，挡住实际操作"；② 设置想有侧栏，方便分离和快速导航；
③ 希望允许清除已绑定的快捷键。

### 1. 遮罩盖住弹窗（真 bug）

上一版把三个浮层的 backdrop 收口到 `OverlayHost`，遮罩是 `position: absolute`，
而各弹窗的 `.modal` 是静态定位。同一层级里 positioned 元素画在静态内容之上，
于是遮罩把弹窗整个盖住：视觉上是"弹窗蒙了一层灰"，交互上点哪里都命中遮罩、
直接触发 `click.self` 关闭，输入框根本点不进去。

修法：内容包一层 `.overlay-content`（`position: relative; z-index: 1`），遮罩 `z-index: 0`。
**没有**用 `z-index: -1` 压遮罩——那样点击会穿透到 layer 本身，`click.self` 就永远不触发；
也**没有**给内容加 `transform`，右键菜单是 `position: fixed` 按视口定位，加了会跑偏。

### 2. 设置页分组侧栏

6 张卡片改成「左侧 4 个分组（快捷键 / 面板 / 应用 / 关于）+ 右侧滚动」。
「应用」带插件数徽标；切分组自动回到顶部；侧栏宽 118px（"应用 + 徽标"不截断的下限）。

### 3. 快捷键可解绑

- `hotkey: ''` 现在表示**主动解绑**：`registerHotkey('')` 删除期望项再 flush 并返回成功；
  `flush()` 遇到空 accelerator 报 ok 且**不再 restore**（旧逻辑会报失败并把旧键接回去，
  表现是"清了还生效"）。
- 设置页：唤起键行加「清除」×，退格也能清空、按钮文案随之变成「清除」；
  清空后显示橙色警告"当前没有全局唤起键，只能托盘打开"。插件键本就有退格 + ×。
- 托盘菜单/tooltip 在无键时不再显示空 tab。

### 顺手修的两个坑

1. **默认唤起键 `Alt+Space` 在本机根本注册不上**（Windows 留给窗口系统菜单），
   所以「恢复默认」点了就报"可能被其他程序占用"。默认值改为 `CommandOrControl+Shift+Space`，
   并抽成 `config.ts` 的 `DEFAULT_HOTKEY`，经 `panel:get-config` 的 `defaultHotkey` 下发给前端，
   避免前后端各写一份。
2. **注册给系统的回调不会随表更新**：`flush()` 只改 `registered` 里的 action，系统侧闭包还是旧的。
   改为注册稳定的转发函数 `() => registered.get(owner)?.action()`，换回调不必重注册（不用抖键）。

### 关键文件

`components/OverlayHost.vue`、`main/hotkey.ts`、`main/config.ts`、`main/index.ts`、`main/tray.ts`、
`components/SettingsView.vue`、`components/HotkeyInput.vue`、`components/icons.ts`、
`renderer/env.d.ts`、`tests/hotkeyRegistry.test.ts`、`scripts/smoke.mjs`

### 验证

- `pnpm typecheck` 零错误
- `pnpm test` 123/123（新增 10 项：注册表解绑/幂等/差量/失败回滚/回调转发）
- `pnpm build` 通过
- `pnpm smoke` 86/86（新增 3 项：遮罩不遮挡弹窗内容、设置页分组侧栏可切换、唤起键可解绑并能恢复），连续两轮
- 交互实测：点弹窗内部输入框可聚焦（`elementFromPoint` 命中 input 而非遮罩）；
  清除唤起键 → 配置读回空串 + 橙色警告 + toast；「恢复默认」回到 `CommandOrControl+Shift+Space`；
  520px 窄宽下唤起键按钮自动换行、不重叠

---

## v0.4.13 — 自定义外部应用：不写 manifest 也能把程序接进来（2026-11-01）

**目标**：接一个程序不该需要"写 plugin.json + 准备图标 + 重启"，也不该只支持手填路径。
用户要的是「添加 / 从开始菜单导入 / 改一改」，外加一个像样的图标。

### 功能变更

1. **数据层**（新增 `services/shortcutModel.ts` 纯函数 + `services/shortcuts.ts` IO）
   - `userData/shortcuts.json`（`schemaVersion: 1` + `items[]`）：字段 id/name/command/args/workDir/
     keywords/description/icon{kind:auto|file|none}/createdAt。
   - id 由命令文件名生成（`com.launcher.shortcut.code`），撞了加 `-2`；**创建后不变**。
   - `parseShortcutList` 逐条洗数据：坏一条只丢这条；`buildShortcut` 负责表单校验与默认值。

2. **接入注册表**（`plugin/manager.ts`）
   - `PluginSource` 增加 `'shortcut'`；`scanPlugins()` 末尾把自定义应用翻译成 `PluginRecord`（type 固定
     external），启动/搜索/固定/快捷键全部复用现有链路，没有第二套打开逻辑。
   - manifest 增加 `workDir`，`launchExternalPlugin` 真正把 cwd 传给 spawn（绿色软件常要求从自己目录起）。

3. **图标**（新增 `services/shortcutIcons.ts`）
   - 四级回退：用户图 → `app.getFileIcon`（exe 与 .lnk 都行）→ 网址抓 favicon（2s/64KB）→ 渲染层分类图标+渐变。
   - 磁盘缓存 `shortcut-icons.json`（按 `kind|path|command` 指纹）：扫描同步读缓存出首屏，缺的异步补，
     并发 4，每完成一个 200ms 合并通知一次。

4. **导入**（`services/shortcuts.ts` 的扫描 + `components/ShortcutImport.vue`）
   - 扫开始菜单（用户 + 公共）、桌面、公共桌面的 `.lnk` / `.url`；`.url` 解析 `URL=` 行。
   - 按来源分组、按 command 去重（已导入的不出现）、默认不勾选，支持过滤/选本组/全选。

5. **界面**
   - 设置页新增「外部应用」卡片：列表（图标/名称/命令/编辑/删除/启停）+ 添加 + 从系统导入。
   - 新增 `ShortcutEdit.vue`：名称、命令（可浏览选文件）、参数、工作目录（可浏览）、关键词、描述、
     图标（自动/自定义/不用）。表单高时**只让中间滚动**，保存按钮常驻——否则矮窗口里要点"保存"
     得先找它在哪。
   - 全部应用页给自定义应用加「自定义」徽标；右键菜单与详情页的编辑入口按来源分流
     （插件改启动命令、自定义应用改整张表单，两处配置各归各的）。

### 三个坑

1. **配置两处写会打架**：自定义应用的启动命令若还能被 `savePluginOverride` 改，config 与
   shortcuts.json 就各存一份。处理是 IPC 层直接拒绝并提示"在该应用的编辑表单里改"。
2. **`getFileIcon` 是异步的**，而 `scanPlugins()` 是同步的——图标只能在扫描后补，
   所以必须有磁盘缓存，否则每次启动都要"看着图标一个个弹出来"。
3. **删条目不能只删文件**：pinnedIds / disabledPluginIds / pluginHotkeys / pluginOverrides 都按 id 索引，
   删除时要一并清理，否则留着悬空 id，下次同 id 新建会"继承"上次的固定位置。

### 关键文件

`services/shortcutModel.ts`、`services/shortcuts.ts`、`services/shortcutIcons.ts`、
`plugin/manager.ts`、`services/external.ts`、`main/index.ts`、`preload/panel.ts`、
`components/ShortcutEdit.vue`、`components/ShortcutImport.vue`、`components/SettingsView.vue`、
`components/PanelShell.vue`、`tests/shortcuts.test.ts`、`scripts/smoke.mjs`

### 验证

- `pnpm typecheck` 零错误
- `pnpm test` 113/113（新增 20 项：id 生成/参数拆分/关键词与图标归一化/文件读取容错/`.url` 解析/候选去重分组）
- `pnpm build` 通过
- `pnpm smoke` 83/83（新增 7 项：保存并生成 id、进插件表且带系统图标、名称为空被拒、external 直接拉起、
  候选可扫描（本机 182 个）、批量导入、删除后立即下架），连续两轮通过
- 交互实测：设置页「添加」表单可填可存，图标自动提取到记事本图标；「从系统导入」列出 182 个候选并按
  桌面/公共桌面/开始菜单分组；表单在 560 高的窗口里改为中间滚动、保存按钮常驻
- 未验证：`.lnk` 参数透传（有意不做）；favicon 抓取只在无网环境外未单独构造用例

---

## v0.4.12 — 插件快捷启动键：按一下直达某个插件（2026-11-01）

**目标**：给常用插件挂一个全局键，按下直接打开（外部程序型直接启动），不用"唤起面板 → 再搜一次"。
同时把快捷键注册从"单键 + 复制状态"重构成一张表，为以后更多全局键留位置。

### 功能变更

1. **注册表重构**（`src/main/hotkey.ts`）
   - 原来只有 `current` 一个变量 + `toggle` 回调，加第二个用途就得再复制一份。
     现在统一成 `owner → { accelerator, action }`：`TOGGLE_OWNER` 是唤起面板，插件用自身 id。
   - `syncHotkeys()` 差量同步：键没变就一个系统调用都不发（插件重扫/启停都会调它）；
     每项独立成败；某项改键失败时把原键接回去，不连带弄丢旧键。

2. **绑定计划**（新增 `src/main/plugin/hotkeyPlan.ts`，纯函数）
   - `buildPluginHotkeyPlan(map, plugins, reserved)` 先判定"该不该注册"：停用插件保留配置但不注册、
     与唤起键同键报 `reserved`、两个插件抢同一个键按 id 排序先到先得（结果确定）、
     没修饰键报 `invalid`、已卸载插件的残留配置直接忽略。
   - `sanitizeHotkeyMap()` 洗配置（非字符串/空串/非法 id 丢弃），`loadConfig()` 与 IPC 共用。

3. **配置与状态**（`config.ts` / `main/index.ts`）
   - `AppConfig.pluginHotkeys: Record<pluginId, accelerator>`；停用/卸载的插件保留配置。
   - 新增 `panel:set-plugin-hotkey`：静态冲突预检在写配置之前；真注册失败（被别的程序占用）
     则回滚配置再同步一次，返回原因。
   - `panel:get-plugins` 增加 `hotkey` / `hotkeyError` / `hotkeySuggestion`，设置页直接显示"没生效的原因"。
   - 唤起键变更时先查是否被某个插件键占着，给出"与「计算器」的插件快捷键冲突"而不是
     系统那句"可能已被其他程序占用"（那句话会把人引向错误方向）。

4. **触发**：按下插件键 = `activatePlugin(id)`，与托盘菜单/面板点击同一条路径（web 唤起面板进插件页，
   external 直接拉起程序）。

5. **设置页**（`SettingsView.vue` + 新增 `components/HotkeyInput.vue`）
   - 抽出 `HotkeyInput` 复用原 `captureHotkey`：退格清除、Esc 只退出捕获（不顺手收面板）、
     只按修饰键不算组合键。唤起键与插件键共用一个控件。
   - 新增「插件快捷键」卡片：每行插件图标 + 名称 + 捕获框，未设置时显示作者建议值（可点即用），
     失败原因红字显示，停用插件的输入框置灰。
   - manifest 新增 `hotkey` 字段（仅建议值，校验格式后保留，不自动注册）；内置的剪贴板/计算器/翻译
     各补了一个建议值。

### 两个坑

1. **停止注册也要"显示得出来"**：只把没注册上的键写进日志等于没做——设置页必须能说清
   "是这个键被别人占了，还是和另一个插件撞了"。所以 `hotkeyError` 直接随 `getPlugins` 下发。
2. **失败不能留下"看着有"的配置**：注册失败仍把配置写进去，用户下次会以为键坏了。
   处理是回滚配置 + 再同步一次，界面显示旧值。

### 关键文件

`src/main/hotkey.ts`、`src/main/plugin/hotkeyPlan.ts`、`src/main/index.ts`、`src/main/config.ts`、
`src/main/plugin/manager.ts`、`src/preload/panel.ts`、`src/renderer/src/env.d.ts`、
`components/HotkeyInput.vue`、`components/SettingsView.vue`、`tests/pluginHotkeys.test.ts`、`scripts/smoke.mjs`

### 验证

- `pnpm typecheck` 零错误
- `pnpm test` 93/93（新增 13 项：归一化/合法性/配置清洗/计划表各分支）
- `pnpm build` 通过
- `pnpm smoke` 76/76（新增 6 项：建议值下发、设置并落配置、两插件抢键被拒、占用唤起键被拒、
  单键被拒、可清除），连续两轮通过
- 交互实测：设置页真按键 `Ctrl+Alt+K` → 计算器行显示为分段标签并 toast 成功；同一键设给剪贴板
  → toast「与「计算器」的快捷键冲突」、剪贴板配置不变；改唤起键为插件已用键 → 提示指向具体插件
- 未验证：真按下插件键触发打开（全局热键无法经 CDP 注入），需人工按一次确认

---

## v0.4.11 — 浮层统一：遮罩、层级、焦点与失焦收起（2026-11-01）

**目标**：用户反馈"应用的弹窗设置缺少遮罩，而且总是在移出弹窗返回时收起"。
排查下来是**两个根因**，不是零散的三个 bug：

1. `panel.on('blur')` 只认"置顶/DevTools"两个例外，**渲染层模态完全没登记**——
   以前只有原生对话框靠 `withPanelDialog()` 挡了一下，所以 HTML 弹窗一律一移出去就整个面板消失。
2. 三个浮层各写各的 backdrop：详情 z-index 70、编辑 80、右键菜单 60（透明无遮罩），
   遮罩色 / Esc / 点击关闭 / 焦点管理全不一致；"详情→编辑"切换时还有一帧焦点掉到 body。

### 功能变更

1. **主进程：可见性令牌 + 延迟收起**（`windows/panel.ts` + 新增 `windows/panelVisibility.ts`）
   - `dialogDepth` 泛化成 `Set<string>` 令牌：渲染层浮层与原生对话框共用一套登记，
     最后一个令牌释放时补一次判定（用户先点到外面、再回来关浮层，不留悬空窗口）。
   - 新增 `blurBehavior` 配置：`immediate` / `delay`（默认，160ms）/ `never`。
     延迟到期后复检焦点——点托盘、输入法候选窗、二级弹窗切换都不再误收。
   - 判定抽成纯函数 `blurDecision` / `shouldHideAfterDelay`，9 项单测覆盖每个分支。

2. **渲染层：统一浮层宿主**（新增 `composables/useOverlay.ts` + `components/OverlayHost.vue`）
   - 栈式：Esc 只关栈顶（capture 阶段 `stopPropagation`，不会同时"隐藏面板"）；
     点遮罩关闭；遮罩与面板同 16px 圆角。
   - 焦点：打开时移进浮层首个可聚焦元素，Tab/Shift+Tab 困在层内，关闭后还给原元素。
   - `PluginDetail` / `ExternalEdit` / `ContextMenu` 去掉各自的 backdrop 与 z-index，
     变成纯内容组件；`PanelShell` 里三个 `ref` 与 `onGlobalKeydown` 一并删掉。

3. **设置页新增「面板行为 · 点到面板外面时」**三档，即时生效（`panel:update-config` 走白名单，脏值不落库）。

### 踩到的两个坑

- **别用 `watch(栈长度)` 触发聚焦**：点菜单里的"应用详情"是同一 tick 内 pop 菜单 + push 详情，
  长度回到原值，`watch` 新旧值相等、回调根本不跑——弹窗开了但焦点还在搜索框，Tab 直接跑到遮罩下面。
  改为 `openOverlay` 里 `nextTick` 调度。
- **焦点还原目标要向上追溯**：详情层的 previousFocus 是菜单项，而菜单马上被移除，
  `focus()` 落到已不在 DOM 的按钮上 → 焦点掉到 body。取 activeElement 时若它属于某层浮层就继承那层的还原目标；
  "详情→编辑"同时改成**先开新层再关旧层**。

### 关键文件

`src/main/windows/panel.ts`、`src/main/windows/panelVisibility.ts`（新）、`src/main/config.ts`、`src/main/index.ts`、`src/preload/panel.ts`、`src/renderer/src/composables/useOverlay.ts`（新）、`src/renderer/src/components/OverlayHost.vue`（新）、`PluginDetail.vue`、`ExternalEdit.vue`、`ContextMenu.vue`、`PanelShell.vue`、`SettingsView.vue`、`tests/panelVisibility.test.ts`（新）、`scripts/smoke.mjs`

### 验证

- `pnpm typecheck` 零错误；`pnpm test` **80/80**（新增失焦判定 9 项）
- `pnpm build` 通过
- `pnpm smoke` **70/70**（64 → 70）：右键菜单经统一浮层渲染、菜单→详情只留一层、
  详情打开后焦点进浮层、Tab 焦点困在浮层内（真 `Input.dispatchKeyEvent`，不是合成事件）、
  Esc 关浮层后仍在主页、失焦策略可配置且拒绝脏值
- CDP 手动核对："详情→编辑"切换后层级为 1、输入框可聚焦；关闭后焦点回到触发元素

### 备注

"真失焦"（点桌面/别的窗口）无法在自动化里触发：`window.blur()` 只让页面失焦，
不改变窗口焦点；而用脚本切前台的两种常规手段都被本机安全策略拦了（运行时编译代码、实例化 shell 对象）。
所以这条链路靠 `blurDecision` 单测 + 代码路径审查兜底，交互效果由人工确认；
冒烟里那条"浮层打开期间 `window.blur()` 后面板仍可见"保留着——它至少能挡住
"某天有人把可见性登记删了"这类回归。

---

## v0.4.10 — 细节优化：插件页居中 / 外部程序可浏览选文件（2026-11-01）

**目标**：两条用户反馈——"打开插件页时窗口应该端在屏幕正中"、"外部应用设启动命令要能浏览本地文件挑"。

### 功能变更

1. **插件页居中**（`windows/panel.ts` + 新增 `windows/panelLayout.ts`）
   - 以前只把窗口左右居中、纵向保持原顶边；主页贴在 16% 处，插件页一变大下半截就偏下。
   - 现在算完目标尺寸后直接摆到工作区正中（`getDisplayMatching` 决定用哪块屏），多屏也落在当前那块屏的中心。
   - 尺寸与居中是纯算术，抽到 `panelLayout.ts`（`pluginSize` / `centerInWorkArea`），单测覆盖"只放大不缩小 / 94% 封顶 / 副屏偏移 / 半像素取整"。

2. **外部程序型的启动命令可浏览选择**
   - 详情页「编辑启动命令」的命令输入框旁加「浏览…」：原生文件对话框挑 `.exe/.com/.bat/.cmd/.lnk`，选完回填路径，不用手打带空格/中文的路径。
   - 顺手补齐拉起方式（`services/external.ts`）：`.bat/.cmd` 经 `cmd` 解释（直接 spawn 是 EINVAL，用户只看到"点了没反应"）；`.lnk` 交给系统 ShellExecute（spawn 是 ENOENT），UI 里明确提示"快捷方式的启动参数不生效"。

3. **原生对话框不再连面板一起收起**
   - 面板是"失焦即隐藏"，而文件对话框会把焦点拿走。新增 `withPanelDialog()`：对话框期间屏蔽失焦隐藏，关闭后把焦点还给面板。
   - 安装插件（目录/ZIP）用的也是这个包一层，之前的隐患一并修掉。

### 关键文件

`src/main/windows/panel.ts`、`src/main/windows/panelLayout.ts`（新）、`src/main/services/external.ts`、`src/main/index.ts`（`panel:pick-command`）、`src/preload/panel.ts`、`src/renderer/src/components/ExternalEdit.vue`、`src/renderer/src/env.d.ts`、`tests/panelLayout.test.ts`（新）、`scripts/smoke.mjs`

### 验证

- `pnpm typecheck` 零错误；`pnpm test` **67/67**（新增布局 9 项）
- `pnpm build` 通过
- `pnpm smoke` **64/64**，新增断言「插件页窗口居中于屏幕 — 偏移 0px / 0px」
- 手动（CDP）：调 `window.panel.pickCommand()` 弹出系统文件对话框，期间 `document.visibilityState === 'visible'`（面板没被收起）

### 备注

对话框无法在自动化里点"确定"，所以"选中回填"这一步只做了代码路径检查；ESCAPE 取消路径与面板可见性已实测。

---

## v0.4.9 — 还清三笔技术债：目录监听 / 存储配额 / LRU 进冒烟（2026-11-01）

**目标**：v0.4.8 收掉常驻成本后，技术债清单上还剩三条"知道有问题但没管"的：插件目录变了要重启、
存储只限单值不限总量、LRU 淘汰链路靠人工临时探针验证。本版把这三条补上，**不新增用户可见功能**。

### 功能变更

1. **插件目录监听**：`fs.watch` 盯插件根目录 + 每个插件目录及其 `dist`，只看 `plugin.json` 与
   `dist` 的增删（构建时刷 JS/CSS 不该触发重扫），事件 300ms 合并后重扫并通知面板/托盘。
   新放一个插件目录进去、改个名字、加个权限，都不再需要重启。打包版只监听用户安装目录
   （内置插件在安装目录里不会变）。
2. **重扫后刷新缓存条目**：`refreshPluginRecords()` 把已打开视图的 `rec` 换成新记录、重新登记
   身份锚定（权限/名称可能变了），入口 URL 变了就换源；插件目录被删掉的视图直接销毁。
   以前重扫只更新注册表，缓存里还挂着旧 manifest，权限改了要等页面重载才生效。
3. **存储总量配额**：单插件封顶 **8MB**（`QUICKLAUNCHER_PLUGIN_STORE_LIMIT_MB` 可改，`0` = 关闭）。
   内存里维护每个键的分片字节数，写入前 O(1) 判断（覆盖已有键会先扣掉旧值）。
   超限时 `storage.set` **抛错并说明已用/上限**——不能悄悄返回 false 让插件以为存上了。
4. **三条链路进冒烟**：一次建 7 个临时探针插件把常驻上限顶满，断言目录监听（新增/改 manifest/删除）、
   最久未用的视图被回收、`onDestroy` 在 400ms 宽限内落盘、重开能读回时间戳、存储配额拒绝并说明原因。

### 关键文件

- 新增 `src/main/plugin/watcher.ts`（watch + 防抖 + 重挂）、`src/main/plugin/watchPlan.ts`（待监听目录，纯函数）
- `src/main/index.ts`：装配目录监听，与 dev server 监听共用"重扫 → 刷新条目 → 刷托盘 → 通知面板"
- `src/main/windows/pluginHost.ts`：`refreshPluginRecords()`
- `src/main/services/{storage,storageShards}.ts`：配额判定 `overQuota`、`formatBytes`、按 key 记账的字节数、
  序列化文本复用（set 算过的文本直接用于落盘）
- `src/main/plugin/api/storage.ts`：超限改为抛错（契约仍是 `res: boolean`）
- `scripts/smoke.mjs`：第 12/13 段（监听 + LRU + 配额）；`tests/watchPlan.test.ts`、`tests/storageShards.test.ts` 扩测

### 验证

| 检查 | 结果 |
|---|---|
| `pnpm typecheck` | 零错误（含 tests） |
| `pnpm test` | **58/58**（6 个文件，新增监听计划 7 项、配额判定 7 项） |
| `pnpm build` | 通过 |
| `pnpm smoke` | **63/63**（55 → 63：新增 8 项） |
| 目录监听 | 建 7 个探针目录后插件表自动出现；改 `plugin.json` 名称自动生效；删目录自动下架 |
| LRU 端到端 | 依次打开 7 个 → 最久未用的 target 消失；最近两个仍常驻；重开读到 `destroyed-at` |
| 配额端到端 | 1.9MB × 8 次写入：前 4 次成功，第 5 次返回「存储配额已满（已用 7.x MB，上限 8.0 MB）」 |

### 踩坑

- **冒烟里的固定 sleep 不可靠**：第一版断言"打开完 7 个 + 900ms 后 lru1 已关闭"，实测偶发失败——
  淘汰可能分几轮发生在最后几次打开里，900ms 恰好落在 400ms 宽限窗口内。改成**轮询 target 消失**
  （上限 6s）后稳定；顺带发现宽限期内重开是"撤销淘汰"，同样的现象会被误判成"没被淘汰"。
- **监听要按文件名过滤**：最初监听整个插件目录，`pnpm build:plugins` 期间每条 JS/CSS 写入都触发重扫，
  日志刷屏且白耗 CPU。只认 `plugin.json` 与 `dist` 的增删即可。
- **重扫不等于刷新**：注册表重建后，`viewCache` 里仍是旧 `rec`，权限/名称改动对已打开页面无效；
  必须重新登记 `callerRegistry`，入口 URL 变了还要换源。
- **配额要抛错不能返回 false**：`boolean` 兑现不了"为什么没存上"，插件只能靠猜；网关抛错后
  插件侧 catch 到的是带数字的可读消息。

---

## v0.4.8 — 常驻成本收敛：视图 LRU / 存储分片 / 面板拆分 / 单测（2026-10-31）

**目标**：v0.4.7 的内联结果把"插件常驻"变成常态，但视图缓存只增不减；存储每改一个键都要重写
整个 `store.json`；`PanelShell.vue` 800 行把搜索、键盘、缩放、弹层混在一起；验证全靠 smoke，
纯逻辑没有任何回归护栏。本版集中还这四笔债，**不新增用户可见功能**。

### 功能变更

1. **视图 LRU（上限 5）**：`viewCache` 按 LRU 保留最近 5 个插件视图，超出时淘汰最久未用的。
   保护名单：当前激活的、分离到独立窗口的、`features: ["inline"]` 的（它们靠常驻换"输入即得"）。
   淘汰不是"卸载"——下次打开重新加载页面。上限可用 `QUICKLAUNCHER_PLUGIN_VIEW_LIMIT` 覆盖（调试/验证用）。
2. **`appapi.onDestroy`**：淘汰前先推 `plugin:lifecycle { state: 'destroy' }`，给插件 **400ms**
   把内存里的草稿 `storage.set` 落盘，之后再关页面。宽限期内重新打开该插件会**撤销淘汰**，
   页面状态完整保留。契约 `PluginLifecycleState` 扩为 `show | hide | destroy`。
3. **存储分片 + 防抖**：`store.json` → `data/<pluginId>/shards/<hash>-<slug>.json`，一个 key 一个文件；
   先写 `.tmp` 再 `rename`（原子）；同插件的写盘合并到 250ms 一次，`before-quit` 统一 flush。
   旧 `store.json` 首次读取时自动迁移，原文件改名为 `store.json.migrated`（不删用户数据）。
4. **面板拆分**：`PanelShell.vue` 的搜索/回车分发 → `composables/useSearch.ts`，
   键盘导航 → `useKeyboardNav.ts`，8 向缩放 → `useWindowResize.ts`；组件只剩视图状态与事件接线。
5. **单测 + CI**：引入 vitest（`pnpm test`），44 项覆盖校验器、内联归一化、分片命名/解析、LRU 策略、
   契约表一致性；`.github/workflows/ci.yml` 跑 typecheck → test → build:plugins → build。

### 关键文件

- 新增 `src/main/windows/viewLru.ts`（纯函数淘汰策略）、`src/main/services/storageShards.ts`（分片命名/解析）
- `src/main/windows/pluginHost.ts`：LRU 淘汰、`beginEvict`/`destroyTimer`、`activeId` 切换后回收
- `src/main/services/storage.ts`：分片读写、原子写、写盘合并、迁移、`flushAll`
- `src/shared/pluginApi.ts` + `src/preload/plugin.ts`：`PluginLifecycleState` / `onDestroy`
- 新增 `src/renderer/src/composables/{useSearch,useKeyboardNav,useWindowResize}.ts`
- 新增 `vitest.config.ts`、`tests/*.test.ts`、`.github/workflows/ci.yml`

### 验证

| 检查 | 结果 |
|---|---|
| `pnpm typecheck` | 零错误（含 tests） |
| `pnpm test` | **44/44**（5 个文件） |
| `pnpm build` | 通过 |
| `pnpm smoke` | **55/55**（无回归） |
| LRU 端到端 | 上限=1 启动 → 开探针（show=1）→ 开剪贴板 → 探针收到 `destroy` 并在宽限内写入 `destroyed-at` → 重开探针为新页面（show=1、destroy=0）且读到该时间戳 |
| 存储迁移 | `com.launcher.handbook/store.json` → `shards/*-last-position.json`（原值 `{manualId,chapterId}` 完整）、旧文件改名 `.migrated` |

### 踩坑

- **淘汰时机**：第一版在 `ensureEntry` 里回收，结果把"刚建好的视图"自己淘汰了——那一刻旧插件
  还是 `activeId`（受保护），唯一可淘汰的候选正是新视图。必须等 `activeId` 切换后再回收；
  预热路径（`warmPluginContents`）不经过激活，才在创建后立即回收。
- **销毁计时器别拖住退出**：`setTimeout` 一律 `unref()`，否则托盘常驻时会拦住 `before-quit`。
- **删除键要先撤销排队写**：否则 `remove` 之后防抖定时器又把旧值写回去（分片文件复活）。

---

## v0.4.7 — 内联结果：输入 `2+3` 直接出 `5`（2026-10-31）

**目标**：v0.4.2 的搜索贡献解决的是"插件里的内容能被搜到"，但插件始终是"打开一个 App"。
uTools 最核心的体感是**输入即得**——`2+3` 在搜索框下方直接给 `5`，回车复制。本版补上这一层，
让插件从"另一个窗口"变成"搜索结果的一部分"。

### 功能变更

1. **manifest `features: ["inline"]`**：与 `permissions` 分开的第二条轴——权限管"能调什么能力"，
   功能管"以什么形态参与启动器"。未声明就调 `appapi.inline.set` 会被网关拒绝（错误信息提示补声明）。
2. **`appapi.onInlineQuery` + `appapi.inline.set`**：面板每次输入（防抖 140ms）把 `{ seq, query }`
   推给内联插件，插件在 **120ms** 内回 ≤2 条结果。
3. **后台视图调度**（`plugin/inline.ts`）：内联插件视图由 `pluginHost.warmPluginContents` 拉起但
   **不挂到面板**，同一份页面之后被用户正式打开时状态连续。三条约束：超时 120ms、不排队
   （同插件只认最新 seq）、页面未就绪就不问。
4. **冷启动补查**：页面加载完（`did-finish-load`）主进程发 `panel:inline-ready`，面板用当前搜索词
   再查一次——否则首次输入会"没结果、再打一个字才有"。
5. **面板渲染与动作**：内联结果排在搜索条目与应用之前，共用 ↑↓ 光标；右侧标出回车会做什么。
   `copy` 写剪贴板且面板不关（连续取用），`open` 打开插件并透传 intent；不写 action 按 open。
6. **计算器接上**（`plugins/calculator`）：只认"像算式"的输入，算得出回一条、算不出回空。

### 关键文件

- `src/shared/pluginApi.ts`（`PLUGIN_FEATURES` / `InlineItem` / `inline.set` 通道 / `onInlineQuery`）
- `src/shared/inline.ts`（条目归一化：条数、文本长度、action 校验）
- `src/main/plugin/inline.ts`（查询调度、seq 匹配、超时、就绪补查）
- `src/main/plugin/api/inline.ts` + `gateway.ts`（`feature` 门禁）
- `src/main/windows/pluginHost.ts`（`warmPluginContents`）
- `src/renderer/src/components/PanelShell.vue`、`stores/launcher.ts`（两路并发查询 + 首段渲染）
- `plugins/calculator/*`

### 验证

| 检查 | 结果 |
|---|---|
| `pnpm typecheck` / `pnpm build` / `pnpm build:plugins` | 零错误 / 通过 / 通过 |
| `pnpm smoke` | **55/55**（新增 8 条内联断言） |
| `window.panel.inline('2+3')` | `title:'5'`, `action:{type:'copy',text:'5'}`, `pluginId:com.launcher.calculator` |
| 非算式 `hello` | `[]`（不产生噪音条目） |
| 面板真实链路 | 输入 `7*8` → 800ms 内出「56」行（14px/600、蓝色 `=` 徽标、右侧「复制」）→ 回车 → toast「已复制：56」 |
| 功能门禁 | 未声明 `features` 的探针插件调 `inline.set` → 拒绝（"缺少功能声明"） |
| 冷启动 | 视图被销毁后只敲一次 `8*8`，无需再按键即自动补出「64」 |
| 后台预热 | 面板没打开计算器时，其 `plugin://` target 已存在（视图在后台跑） |

### 踩坑

- **未挂到窗口的 `WebContentsView` 仍会正常加载并执行 JS**：一开始以为必须挂在 `BaseWindow` 上，
  实测后台视图可用，内联才能做到"不打开插件也能算"。代价是内联插件一旦被唤醒就常驻一个渲染进程
  （视图缓存无 LRU 的老问题，记在架构文档"已知边界"）。
- **首屏加载期间输入会丢结果**：视图第一次创建要 300~800ms，而用户往往打一个词就停。补了
  `panel:inline-ready` 回环后，第一次输入也能等到结果，不必再敲一个字。

---

## v0.4.6 — 插件能用网了 + 可见性事件：`net.request` / `onShow` / `onHide`（2026-10-31）

**目标**：v0.4.5 把插件页搬到 `plugin://` 后，跨域 `fetch` 仍然被 CORS 拦——插件等于不能调任何
HTTP API，这是"自由度"最大的一道墙。同时视图是缓存不是销毁，`onUnmounted` 永不触发，
剪贴板插件退出后仍在后台每 800ms 读一次剪贴板。本版补上这两块：**网络能力**与**生命周期事件**。

### 功能变更

1. **`appapi.net.request`**（`net` 权限）：主进程转发 HTTP，插件页不再受 CORS 限制。
   授权两层——先要 `net` 权限，再要 manifest `hosts` 里有目标域；**重定向逐跳校验**，
   302 到白名单外会被拒绝，避免被一跳带走。
   - `hosts` 支持精确域 / `*.example.com`（含裸域）/ 可选端口；缺省为空 = 一个都不许
   - 方法限 7 个动词（大小写不敏感），`host`/`cookie`/`content-length` 等受控头由主进程接管被丢弃
   - `credentials: 'omit'`：插件拿不到主面板与其他分区的登录态
   - 响应体 ≤4MB（超出截断并置 `truncated`）、请求体 ≤2MB、超时 1~60s（默认 15s）
   - 语义对齐 `fetch`：4xx/5xx 正常返回（`ok:false`），网络错误/超时/白名单外才 reject
2. **`appapi.onShow` / `onHide`**（无需权限）：主进程在可见性**真正变化**时推 `plugin:lifecycle`。
   触发点覆盖：面板内切插件、返回主界面、面板收起（Esc/失焦/快捷键）、分离窗口隐藏/恢复；
   分离为独立窗口本身不推（一直可见）。preload 初始态为 `show`，且 `onShow` 注册时若已可见
   会立即回调一次——启动轮询可以直接写进 `onShow`。
3. **剪贴板插件改为按可见性轮询**：`onShow` 启动 + 补一次，`onHide` 停止，`onUnmounted` 兜底。
4. **校验器补齐**：`validate.ts` 新增 `int` / `oneOf`（可 `upper` 归一）/ `stringRecord`。
5. **manifest 增 `hosts` 字段**：非法项只丢弃并告警（不整插件拒载），因为缺项等于少给权限。

### 关键文件

- 新增 `src/main/plugin/api/net.ts`（白名单匹配 + `net.request` 逐跳重定向 + 响应截断）
- `src/shared/pluginApi.ts`：`net` 权限、`NetRequest`/`NetResponse`、`plugin:net.request`、`PluginLifecycleState`、`onShow`/`onHide`
- `src/preload/plugin.ts`：`net.request` 桥 + `plugin:lifecycle` 订阅（状态去重）
- `src/main/windows/pluginHost.ts`：`CacheEntry.visible` + `emitLifecycle`（面板显隐、切插件、分离窗口 hide/show）
- `src/main/plugin/manager.ts`：`hosts` 校验与归一化
- `plugins/clipboard/src/App.vue`：轮询跟随可见性
- `scripts/smoke.mjs`：临时探针插件 + 本地 HTTP 服务，覆盖 net 与 lifecycle 共 11 条断言

### 验证

| 项 | 结果 |
|---|---|
| `pnpm typecheck` / `pnpm build` / `pnpm build:plugins` | 零错误 / 通过 / 通过 |
| `pnpm smoke` | **47/47** |
| net 正常路径 | `GET http://127.0.0.1:<port>/ok` → 200 + JSON；`method: 'post'`（小写）正确归一为 POST |
| net 白名单 | `127.0.0.2` → 拒绝并列出已声明的域；`file://` → "仅允许 http(s)" |
| net 重定向 | 同域 302 自动跟随（`url` 为最终地址）；跨域 302 → 拒绝（`example.com 不在 manifest.hosts 白名单内`） |
| net 权限 | 未声明 `net` 的插件（calculator）调用 → 网关拒绝 |
| 生命周期 | 探针页计数：加载即 `show=1` → 退出后 `hide=1` → 重进 `show=2` |
| 无残留 | 探针插件在 `finally` 里删除并重扫，`plugins/` 干净 |

### 坑

- **`net.fetch` 不支持"先看 302 再决定"**：`redirect: 'manual'` 在 Electron 里直接以
  `Redirect was cancelled` 失败，拿不到响应头。第一版就是这么写的，同域重定向都过不去。
  改用 `net.request` 的 `redirect` 事件 + `followRedirect()` 才能逐跳裁定。
- **在 `redirect` 事件里 `abort()` 不会触发 `error`**：Promise 会一直悬到超时才结束。
  策略性拒绝必须自己 `reject`，再 `abort()`（第一版跨域重定向因此报"请求超时"）。
- 冒烟怎么测一个"需要新权限 + 指定域"的能力：脚本在 `plugins/` 下临时生成探针插件，
  借 `panel:setPluginDisabled` 的副作用触发 `scanPlugins()` 让它无需重启就出现，
  断言完在 `finally` 删目录再重扫。不需要为测试在生产代码里加调试接口。

---

## v0.4.5 — 插件专属协议 + 独立分区：origin 与存储都按插件切开（2026-10-31）

**目标**：插件页此前用 `file://` 加载，且全部插件共用 `defaultSession`。两个后果是真实的：
① 翻译插件内嵌第三方站点拿到的 cookie，别的插件（及其 `<webview>`）能读到；② `file://` 的
origin 语义不透明，`localStorage` 边界不可靠，运行时 `fetch('xx.json')` 还会被 CORS 拦掉——
为了读自己目录里的文本，手册插件不得不在构建期用 `?raw` 把正文打进 bundle。
本版把插件页换成自定义标准协议 `plugin://<插件 id>/…`，并给每个插件一个独立 session。

### 功能变更

1. **自定义协议**：`plugin://<id>/<相对路径>`。scheme 以 `standard + secure + supportFetchAPI +
   corsEnabled + stream` 注册（必须在 app ready 前）；请求由 `protocol.handle` 处理，按 host 找插件、
   解析到 `rec.dir` 内后交给 `net.fetch(file://…)` 读盘，MIME / Range / 流式都交给 Chromium。
2. **来源隔离**：每个插件页拿到真实 origin（`plugin://com.launcher.handbook`），`localStorage` /
   IndexedDB 天然按插件分开，同时 `postMessage`、`window.opener` 这类 origin 判定也有了意义。
3. **分区隔离**：插件视图带 `partition: persist:plugin:<id>`，cookie / 缓存 / 站点数据各归各的，
   内嵌 `<webview>` 继承同一分区；分区级权限策略默认拒绝摄像头/麦克风/定位/通知/串口等
   （只放行 `clipboard-sanitized-write` / `fullscreen` / `pointerLock`），要弹通知请走 `appapi.notify`。
4. **跨插件拦截**：自定义协议的响应由主进程直接产生、Chromium 不做 CORS 校验，因此
   `fetch('plugin://别的插件/…')` 原本能成功。改为在分区上挂 `webRequest.onBeforeRequest`，
   非本插件 host 的 `plugin://` 请求直接取消；handler 内再按 `referrer` 复核一次。
5. **路径守卫**：解析后必须仍在插件目录内（越界 403）、拒绝 `.` 开头的路径段（403）、
   目录请求补 `index.html`；响应统一 `cache-control: no-store`（插件升级后不会跑旧缓存）+ `nosniff`。
6. **「清除插件数据」补全**：原来只删 `store.json`，现在同时 `clearStorageData() + clearCache()`，
   设置页点一下真的把这个插件清干净。
7. **dev 热更新回退目标**：`did-fail-load` 的回退从 `file://…/dist/index.html` 改为 `plugin://<id>/index.html`。

### 关键文件

- 新增 `src/main/plugin/protocol.ts`（scheme 特权 + 请求处理 + 路径守卫）、`src/main/plugin/sessions.ts`
  （分区、权限策略、跨插件拦截、清数据）、`src/main/plugin/urls.ts`（地址构造与 host 解析，避免 manager↔protocol 循环依赖）
- `src/main/plugin/manager.ts`：`pluginBuiltUrl` 改为返回 `plugin://` 地址
- `src/main/windows/pluginHost.ts`：视图加 `partition`
- `src/main/index.ts`：ready 前注册 scheme 特权、ready 后装协议；清数据接口改为异步并清分区
- `scripts/smoke.mjs`：插件页判定改为 `plugin://com.launcher.<name>/`，新增 5 条隔离断言

### 验证

| 项 | 结果 |
|---|---|
| `pnpm typecheck` / `pnpm build` | 零错误 / 通过 |
| `pnpm smoke` | **35/35**（新增：origin 为 `plugin://<id>`、localStorage 可用、同源 fetch `plugin.json` 成功、跨插件 fetch 被拦、`..%2f` 越界 403） |
| 分区真实落地 | `%APPDATA%/quick-launcher/Partitions/` 下按插件生成 `plugin%3Acom.launcher.{calculator,clipboard,handbook}` |
| 存储隔离 | clipboard 写 `localStorage.iso='clipboard'` → calculator 读到 `null`、自己写 `calc` → 重进 clipboard 仍读到 `clipboard`（互不覆盖） |
| 清数据 | 调 `clearPluginData('com.launcher.clipboard')` 后重开插件，`localStorage.iso` 为 `null` |
| webview 不被破坏 | 翻译插件带查询词打开 → `webview` 正常挂载，guest 为 `https://fanyi.baidu.com/...`，未崩溃 |
| dev 热更新未回退 | `pnpm dev:plugin handbook` → 视图切到 `http://localhost:5173/?__plugin=…`；登记项失效 → `did-fail-load` 回退到 `plugin://com.launcher.handbook/index.html`（日志有 warn） |

### 坑

- `protocol.handle` 只注册在 `defaultSession` 上；插件各自有分区，**必须**对 `session.fromPartition(...)`
  再注册一次，否则插件页直接 `ERR_UNKNOWN_URL_SCHEME`。
- 自定义协议响应不经 CORS：`corsEnabled: true` 只影响 http(s) 资源，跨插件读取必须用 session 层
  `webRequest` 兜（第一版就是靠 CORS 想当然，冒烟立刻判为 ALLOWED）。
- 迁移提示：0.4.5 之前写进 `file://` 的 `localStorage` 在新 origin 下读不到。内置插件没用浏览器存储
  （全走 `appapi.storage`），第三方插件若用过需自行迁移。

---

## v0.4.4 — 插件开发热更新：改一行不用重构建重启（2026-10-31）

**目标**：插件开发最慢的一环是反馈循环——改一行 `.vue` 要 `pnpm build:plugins`、重启应用、
再重进插件。本版给插件加一条只在开发期生效的旁路：入口切到 vite dev server，页面拿到 HMR，
主进程负责在启停 dev server 时自动换源，不重启应用。

### 功能变更

| 模块 | 变更 |
|---|---|
| dev 入口登记 | 新增 `.dev-plugins.json`（仓库根、gitignore）：`{ "<pluginId>": "http://localhost:<port>/" }`；`src/main/plugin/devServers.ts` 负责读取、只认本机地址、打包版直接返回 `{}` |
| 插件记录 | `PluginRecord.devUrl`；`scanPlugins` 命中登记项时写入；`pluginEntryUrl` 优先返回 dev 地址（附 `?__plugin=<id>` 标记） |
| 视图换源 | `pluginHost.reloadPluginViews()`：dev 入口变化后对已缓存视图 `loadURL` 换源，页面与应用都不重启 |
| 自动跟随 | `watchDevServers` 轮询 `.dev-plugins.json` **文件原文**（400ms），变化即重扫 + 换源 + 刷新托盘；脚本退出时清理登记项，视图自动切回构建产物 |
| 失败兜底 | `did-fail-load` 时若当前是 dev 入口，回退到 `dist/index.html` 并打 warn——dev server 被强杀留下的死地址不会把用户卡在错误页 |
| 脚本 | 新增 `scripts/dev-plugin.mjs` + `pnpm dev:plugin <name>`：起 vite dev server、解析真实端口（默认端口占用会自增）、登记/清理、透传 HMR 日志 |
| 冒烟硬化 | 插件页识别从"路径含 `plugins/<name>/dist`"改为 `isPluginPage()`（兼容 dev 标记）；手册页断言改为轮询等待渲染（避免 dev 失效回退期间读到空 DOM）；开跑前先 `exitPlugin()` 复位到主页，可从任意状态重跑 |

### 关键决策

1. **dev 入口不进 manifest**：manifest 是随插件发布的产物，塞本地端口会污染协议、也会被打进安装包；用一个 gitignore 的本机文件，打包版完全不可见。
2. **比较文件原文而不是解析后的映射**：同端口重启 dev server 时 URL 不变（只更新 `_updatedAt` 时间戳），比映射会漏掉这次变化，页面就切不回 dev——这是实测踩出来的。
3. **URL 带 `?__plugin=<id>`**：dev 页面地址不再包含插件名，调试时认不出 target，冒烟也会全挂；标记让目标自描述。
4. **失败回退而不是报错**：脚本被强杀时登记项会残留，插件页必须还能用——回退构建产物，代价只是少了 HMR。
5. **不改 `pnpm dev` 的默认行为**：常规开发仍走构建产物（快、与发布一致），要热更新显式开 `dev:plugin`，避免每个插件都常驻一个 dev server。

### 关键文件

- `src/main/plugin/devServers.ts`（新增）、`scripts/dev-plugin.mjs`（新增）
- `src/main/plugin/manager.ts`（`devUrl` + `pluginBuiltUrl`）、`src/main/windows/pluginHost.ts`（入口标记、换源、失败回退）
- `src/main/index.ts`（监听挂载）、`scripts/smoke.mjs`（dev 入口识别 + 复位 + 轮询等待）、`package.json`（`dev:plugin`）、`.gitignore`

### 验证

- `pnpm typecheck` 零错误；`pnpm build` 通过；`pnpm build:plugins` 通过
- `pnpm smoke` **30/30**（两种状态：dev server 在线时手册页为 `http://localhost:5173/?__plugin=...`；dev 地址失效时自动回退为 `file://.../dist/index.html`）
- HMR 实测：改 `plugins/handbook/src/App.vue` 的 `.side-title` 颜色 → 2s 内页面计算样式变为 `rgb(255, 0, 0)`（无刷新、手册阅读状态保留）；还原后同样 2s 内回到 `rgb(161, 166, 173)`
- 换源链路实测：新增登记项 → 已打开的手册页自动切到 dev server；移除登记项（等同脚本 Ctrl+C）→ 3s 内自动切回构建产物
- 失效地址实测：`ERR_CONNECTION_REFUSED` → 日志 `dev server 不可用(ERR_CONNECTION_REFUSED)，回退到构建产物`，页面可用

### 遗留事项

- 硬杀（SIGKILL）脚本仍会留下登记项，靠加载失败兜底恢复；正常 Ctrl+C 会清理
- 插件页还没有 DevTools 快捷键（现在只能靠 CDP），下一步可加 dev 模式的 F12
- 下一步按评审顺序：自定义协议 + 独立 session → net / events / inline 结果

---

## v0.4.3 — 插件能力契约 + 注册表网关：加一个 API 只改一处（2026-10-31）

**目标**：插件系统此前每加一个 API 要同步改四处（网关通道、`PERMS` 表、preload 暴露、
每个插件的 `env.d.ts`），且已经开始漂移——渲染层 `env.d.ts` 的 `PluginApi` 少了 `docs`/`search`，
handbook 与 translator 各自重写了一份 appapi 接口。本版把"通道、权限、入参/返回值"
收敛成一份契约，并让网关从"手写分发"变成"遍历注册表"，把新能力的接入成本压到一处。

### 功能变更

| 模块 | 变更 |
|---|---|
| 能力契约 | 新增 `src/shared/pluginApi.ts`：`PluginApiTypes`（通道 → req/res）、`PLUGIN_PERMS`（通道 → 权限）、`PluginApiSurface`（`window.appapi` 形状）、`PluginPermission` 常量表。纯类型/常量，不依赖 electron/node，四端共用 |
| 能力定义 | 新增 `src/main/plugin/api/`：`define.ts`（`defineApi` 泛型 + 注册表类型擦除）、`validate.ts`（5 个校验组合子），能力按域拆成 `meta` / `storage` / `system` / `docs` / `search` 五个模块 |
| 网关 | `gateway.ts` 从 91 行硬编码降到 40 行：遍历 `apiDefs` 统一做身份锚定 → 权限（查 `PLUGIN_PERMS`）→ 入参校验 → handler；文件里不再出现任何通道名；重复通道在启动期直接抛错 |
| 入参硬化 | `storage.set` value ≤2MB 且 key 禁用 `__proto__` 等保留名；`notify` title ≤120 / body ≤2000；`clipboard.writeText` ≤2MB；`shell.openExternal` 仅 http(s) ≤2048；`docs` 句柄 ≤255 且不含路径分隔符。超限一律 reject，不再静默截断 |
| 类型同源 | `preload/plugin.ts` 标注 `api: PluginApiSurface` + `invoke<C>` 泛型；渲染层 `env.d.ts` 删除手写 `PluginApi`（改由 `shared/appapi.global.d.ts` 提供）；5 个内置插件统一改为一行 reference，删除各自的 `TranslatorApi` / `HandbookApi` 重写 |
| 安全 | `__proto__`/`constructor`/`prototype` 作为 storage key 直接拒绝（避免原型污染面） |

### 关键决策

1. **契约放 shared 而不是 main**：preload、渲染层、插件都要用同一份类型，放 main 会把 electron 依赖带进渲染层与插件；shared 只放纯类型与常量。
2. **权限表只留一份**：`Record<PluginChannel, PluginPermission | null>` 强制穷尽——新增通道忘了标权限，编译就过不去，比"记得改 PERMS"可靠。
3. **入参校验放定义里而不是网关里**：`parse` 与 `handle` 写在一起，读一个文件就知道这个通道收什么、怎么归一化；网关保持与业务无关。
4. **保留 `any` 一处并说明理由**：注册表要按通道批量注册，运行时无法保留每个通道的类型；`any` 只出现在 `define.ts` 的 `RegisteredApiDef`，对外类型由 `defineApi` 泛型锚定。
5. **上限宁可 reject 也不静默截断**：静默截断会让插件以为写成功了，排查成本更高；错误信息带上限值，插件作者能直接改。

### 关键文件

- `src/shared/pluginApi.ts`（新增）、`src/shared/appapi.global.d.ts`（新增）
- `src/main/plugin/api/{index,define,validate,meta,storage,system,docs,search}.ts`（新增）
- `src/main/plugin/gateway.ts`（重写为注册表驱动）、`src/preload/plugin.ts`（契约化）
- `src/renderer/src/env.d.ts`、`plugins/*/src/env.d.ts`（删除重复的 appapi 声明）

### 验证

- `pnpm typecheck` 零错误（main + renderer 两套 tsconfig，含 shared 新契约）
- `pnpm build:plugins` 通过；`pnpm build` 三端产物通过（main 52.57 kB / preload plugin.js 1.82 kB）
- `pnpm smoke` **30/30 通过**：插件桥注入、storage 读写、插件身份、`docs` 通道、权限模型（storage/clipboard 未声明即拒绝）、搜索条目 intent 直达手册等均不受重构影响

### 遗留事项

- 网关只做了同步/异步统一包装，还没有单测；校验组合子的边界（超长、非对象、保留 key）建议补 vitest
- 插件 SDK 仍是仓库内相对引用（`../../../src/shared/appapi.global.d.ts`），第三方插件开发者拿不到，待抽 `@launcher/plugin-sdk` 包
- 下一步按评审顺序：插件 dev HMR → 自定义协议 + 独立 session → net / events / inline 结果

---

## v0.4.2 — 搜索贡献协议 + 手册匹配词：面板直搜手册内容（2026-10-31）

**目标**：主面板搜索原本只认插件 manifest 的关键词，搜「linux」只能出「程序员手册」这个
**整包应用**，进去还得自己找那本手册。这一版让插件把**内部条目**注册给启动器，做到
「搜 linux → 直接出现《Linux 命令手册》→ 回车落到该手册章节」，并允许用户给每本手册
补自己的匹配词。

### 功能变更

| 模块 | 变更 |
|---|---|
| 搜索贡献协议 | 新增 `search` 权限与 `appapi.search.set/clear`；条目字段 `id/title/subtitle/keywords/group/weight/intent`，全量覆盖语义 |
| 主进程索引 | 新增 `services/searchIndex.ts`：运行时条目 + 落盘 `userData/search/<pluginId>.json` + 插件目录 `search-index.json` 三级来源；校验裁剪（≤300 条 / 关键词 ≤40 / 文本 ≤120 字 / intent ≤800 字节） |
| 面板检索 | 新增 `panel:search`；`panel:open-plugin` 支持第三个参数 `intent`，经 `plugin:query` 送到插件的 `onQuery` |
| 面板 UI | 搜索结果拆成「文档与内容」条目区 + 「应用」网格，两区共用 ↑↓ 光标；条目显示插件图标、标题、副标题（章节数 · 来源） |
| 匹配规则 | 提取到 `src/shared/search.ts`，渲染层的 `utils/match.ts` 改为复用，主进程与面板同一份实现 |
| 手册插件 | 推送「手册级（weight 0）+ 章节级（weight 10）」条目；管理页每本手册新增「匹配词」输入（逗号/空格分隔，存 storage，留空恢复默认）；`onQuery` 支持 `intent` 直达手册/章节 |
| 冷启动 | `build-manuals.mjs` 额外产出 `public/search-index.json`（随 vite 复制进 dist），插件没打开过也能被搜到 |

### 关键决策

1. **条目检索放主进程，不放渲染层**：条目落盘在 userData，插件没启动也要能读；渲染层只有 `panel:search` 一个入口。
2. **三级来源、运行时覆盖静态**：静态索引解决冷启动，但没有"停用某本手册""用户改过关键词"这些状态；插件一启动就用自己的动态条目整体覆盖。
3. **副标题不参与匹配**：第一版把 subtitle（手册名）也纳入匹配，结果搜「linux」把 35 个章节全刷了出来——每个章节的副标题都是「Linux 命令手册」。
4. **单插件限 4 条**：手册类插件一次能命中几十章，不设限会把其他插件的结果挤没。
5. **用户关键词用"补充"而非"替换"**：手册自带关键词（`ts`/`linux`）不该被用户误删清空，用户填的追加在默认值之后。

### 关键文件

- `src/shared/search.ts`（新增）、`src/main/services/searchIndex.ts`（新增）
- `src/main/plugin/gateway.ts`（`plugin:search.set/clear` + `search` 权限）、`src/main/index.ts`（`panel:search`、intent 透传、卸载清索引）
- `src/preload/plugin.ts` / `src/preload/panel.ts` / `src/renderer/src/env.d.ts` / `stores/launcher.ts` / `PanelShell.vue`
- `plugins/handbook/src/App.vue`（条目推送、匹配词编辑、intent 直达）、`scripts/build-manuals.mjs`（静态索引）、`public/plugin.json`（`search` 权限）

### 验证

- `pnpm typecheck` 零错误；`pnpm build` 通过；`pnpm build:plugins` 通过
- `pnpm smoke` **30/30 通过**（新增：搜索贡献命中手册条目、手册级条目排在章节之前、条目 intent 直达手册）
- 人工 CDP 实测：搜「linux」只出 1 条手册条目（对照组：搜索前为 35 条章节噪音）→ 回车落到《Linux 命令手册》35 章列表；管理页填「运维」后搜「运维」命中该手册；停用该手册后条目消失；清空运行时索引后搜「grep」仍能靠静态索引命中
- 截图核对搜索结果区：「文档与内容」「应用」两段、条目图标/标题/副标题/箭头对齐正常

### 遗留事项

- 静态索引不感知"用户停用了哪本手册"，需插件启动后推送动态条目才准确（首次安装的下一轮打开即修正）
- 章节正文不参与匹配（只匹配标题与关键词），全文检索仍在插件内做；跨插件全文检索见 ROADMAP v0.6
- 条目检索是线性扫描，单插件几百条内没问题；插件数量上来后需要换成前缀索引

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
