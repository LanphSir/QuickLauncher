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

## v0.6.8 — 计算器升级：历史、乘方、两种百分号、可撤销的键位（2026-11-08）

**目标**：收掉 v0.6.6 遗留的「宽窗口下键盘按键被拉成一堵墙」，顺手把它从"能算四则的
演示插件"做成真能天天用的计算器——原来的问题不是缺功能，而是**输入不跟手**：
按 `=` 之后再按数字会把数字接在结果后面（`1+2=` 然后按 7 得到 37），
敲错了只能整条清空，算过的东西一条不留。

### 1. 布局：宽屏不再是一整墙大按钮

- 屏幕+键盘+提示收进 `.stage`（`max-width: 520px` 居中），页头仍贴面板边缘——
  返回/历史在边上，跟其他插件一致；
- 键位从 5 行变 6 行，`max-height: 396px` 封顶，内容整体垂直居中；
- 实测三档：1136×698（按键 59px 高）、380×480（自动压缩，无溢出）、520×1000（键盘不再变高）。

### 2. 表达式层：`^`、两种 `%`、科学计数法

- 文法补 `power := atom ('^' unary)?`：右结合（`2^3^2 = 512`）、指数可负（`2^-1 = 0.5`）、
  一元负号比乘方松（`-2^2 = -4`，`(-2)^2 = 4`）；
- `%` 的两种读法由**后面还有没有操作数**决定，不需要用户加括号：
  `7%3` 取余得 1；`30%`、`100*30%` 按百分比得 0.3、30。SKILL.md 以前写着"百分号按除以 100 处理"
  而实现是取余，这回两边对上了；
- tokenizer 认 `1.2e+21`：以前把结果（可能是科学计数法）接着算会报"无法识别的字符: e"；
- 归一（`×÷−` → `*/-`）下沉进 `evaluate`。内联结果、AI 工具、键盘三条路以前各自转一遍，
  漏一处就是"界面上算得对、内联没结果"。

### 3. 键位与状态机：抽成 `keypad.ts` 纯函数

规则型的东西全在这里，`.vue` 只负责渲染：

- **`=` 之后**：按数字重开一题、按运算符接着结果算、按退格是改结果（不是把结果扔掉）；
- **输入修正**：连按运算符按替换处理（`5+×` → `5×`）；`3(2)` 自动补 `×`；前导 0 吃掉
  （`05` → `5`，但 `0.5` 不动）；一个小数里只允许一个点；`)` 只在配得上时才能敲；
- **新增 `⌫ ± x² 1/x`**：`±` 只翻转末尾那个操作数，按两次等于没按（`5+3±` → `5+(−3)`，
  再按一次回 `5+(3)`）；平方遇到负结果自动加括号——`−3^2` 是 −9，`(−3)^2` 才是 9；
- **边敲边算**：`preview` 与 `=` 共用同一个 `finalize`（补右括号、去掉悬挂的运算符），
  所以屏幕上那个数就是按下等号会得到的数；`12+` 显示 12，而不是先跳 0 再跳回来。
  `finalize` **不能删结尾的 `%`**——删了 `100*30%` 就变成 `100*30`，差一百倍（实测踩到）。

### 4. 历史与复制

- 每次求值成功记一条（同条去重、上限 30、`storage` 持久化），`历史` 按钮带计数角标；
- 历史是**视图切换**而不是浮层：浮层压在键位上既挡按键又留一条缝，怎么摆都难看；
- 点行回填、`↑/↓` 召回上一条、点结果或 `Ctrl+C` 复制并弹一个 1.2s 的提示；
- 从面板带查询词打开时预填：搜 `12*3+4` 再进插件，屏幕里就是这道算式（`12×3+4`，预览 40）。

### 关键文件

`plugins/calculator/src/keypad.ts`（新，状态机）、`evaluator.ts`（文法/归一）、
`App.vue`（键位/屏幕/历史/复制）、`plugins/calculator/public/{plugin.json,ai/tools.json,ai/SKILL.md}`、
`tests/calculator.test.ts`（新）

### 验证

- `pnpm test` 新增 33 条：求值器 12（优先级/括号/一元/乘方/两种百分号/报错原因）、
  格式化 2（科学计数法、千分位只作用于显示）、键盘 19（`=` 之后三种走向、输入修正、±/平方/倒数、
  没写完也能按等号、预览一致性、历史回填）；
- 界面实测（CDP 驱动真实运行的应用）：构造 `12,345×30%` → 3,703.5、`2^10` → 1,024、
  `100−30%` → 99.7、`1÷0` → 红线报错且表达式保留；`=` 后按 7 得 7；`↑` 召回上一条；
  复制后剪贴板确有内容、提示 1.2s 后消失；长表达式（scrollWidth 447 / clientWidth 312）
  自动滚到尾部且左缘淡出
- 三档尺寸逐屏核对：1136×698 / 380×480 / 520×1000

### 遗留

- 百分号按**表达式**语义算：`100−30%` = 99.7，不是 70。要"减去它的三成"得写 `100*(1-30%)`。
  改成 Windows/手机那种"减百分之几"的上下文语义，会让 AI 传 `100-30%` 时得到意外结果，
  所以这里选了可预测的一套
- 历史不分天、不搜索、上限 30 条；`⌫` 仍用字形而不是文字（小字号下略小）

## v0.6.7 — AI 对话页：过程折叠 / 长对话导航 / 就地授权工具（2026-11-08）

**目标**：用户提了四条具体体验问题——过程占版面、长对话找不到位置、想给工具授权得
跳去设置页、设置页拖不动窗口；顺带把几处"不符合直觉"的地方补上。

### 1. 过程折叠：生成中展开，结束后收成一行

原来推理是 `<details>`、工具卡片平铺在正文里，带两轮工具的答案一眼望过去全是灰卡片。
现在按"**最终回答之前的一切都是过程**"切一刀：

- `answerStart(m)` 从后往前找第一段非空正文，它之前的推理 / 工具调用 / 过程中的碎话
  全部进「过程」块，只留最后那段回答在外面；
- 生成中默认展开（要能看见它在想什么），结束后默认收起成一行
  `思考 2 段 · 调用 1 个工具 · 1 个失败 · 用时 9.1s`，点一下随时翻回去；
- 用户手动开合过的块记在 `procOverride` 里，**优先于默认值**——不能出现"我展开了，
  它一边生成一边自己收回去"；
- 生成中那行显示 `正在思考… / 正在执行 xx…` 加实时计时，结束后失败数会变成红点。

### 2. 长对话：跟随底部 + 回合导航 + 回到底部

- `scrollToEnd()` 以前每个增量都无脑滚到底，往上翻历史会被一帧帧拽回去。现在按
  `stick`（离底 < 48px 才算跟随）决定滚不滚，用户正在读历史时新内容不抢滚动条；
- 右下角「回到底部」只在真翻上去时出现，生成中还带一个小圆点；
- 右侧按**回合**（一条用户消息）画一列刻度，当前回合加宽变主色，点击平滑跳过去；
  少于 3 轮不显示——两句话的对话用不上导航。

### 3. 对话里就地授权工具

授权以前只能在设置页做，而用户决定"要不要让它动我的剪贴板"的时机，恰恰是模型要用的时候。
输入框左侧加了「工具 N」面板：列出**所有**声明了 AI 能力的插件（含未授权的）并直接开关。

- 新通道 `plugin:ai.tools.catalog` 与 `plugin:ai.tool.grant`，都 `internalOnly`——
  第三方插件若能读目录就能顺藤摸瓜枚举别人的能力，能给自己授权就等于没有授权；
- 授权仍是**插件级**（与设置页同一份 config），面板里明写"改完下一轮对话生效"。

### 4. 设置页 / 全部应用页拖不动窗口

面板是无边框窗口，主页靠搜索行的 `-webkit-app-region: drag` 拖动。设置页和应用管理页
没有搜索行，也就没有拖动区——补上头部 `drag` + 子元素 `no-drag`。

### 5. 顺手的直觉修正

- 输入框随内容长高（上限 168px 后自己滚），不再两行就看不见刚打的字；
- 正文里的 ``` 围栏渲染成代码块（带语言标签与复制按钮），`**粗体**`/`` `代码` ``/
  行首 `#` 也做了极轻的行内渲染——先转义再替换，模型输出里的 HTML 只会当字面量；
- 会话列表副标题从"N 条消息"改成"今天 12:39 · 10 条"，找会话靠时间比靠条数有用。

### 关键文件

`plugins/ai/src/App.vue`（过程块 / 导航 / 工具面板 / 行内渲染）、`src/main/plugin/api/ai.ts`、
`src/shared/pluginApi.ts`、`src/preload/plugin.ts`、`SettingsView.vue`、`AppManage.vue`

### 验证

- `pnpm typecheck` 零错误；`pnpm test` 268/268；`pnpm build` + `pnpm build:plugins` 通过；
  `pnpm smoke` **135/135**
- 界面实测：造 5 轮带推理与工具的会话逐屏核对（收起/展开/导航/回到底部/工具面板/输入框增高）；
  又用本地慢速 mock（600ms/帧）跑了一整轮真实流式，确认"生成中展开 → 收尾自动收起"与 9.1s 计时；
  对话页内开关授权实测 count 0→1→0，`ai.tools()` 随之变化
- 拖动区用 `getComputedStyle` 核对：头 `drag`、子元素 `no-drag`

### 遗留

- 行内渲染只覆盖代码块/粗体/行内代码/标题，表格与嵌套列表仍是纯文本（要真解析器，不是几行正则）
- 过程块以"最后一段正文"为界；模型若在工具之后又写了一段过渡话再接答案，那段落会算进最终回答
- 会话删除在冒烟脚本连续删除 50+ 文件的沙箱里会被 safe-delete 拦下（环境限制，不是产品问题）

## skills — 插件开发 skill 提到根目录，并补齐 v0.6 的三块内容（2026-11-03）

**目标**：把项目开始时丢在 `.zcode/skills/` 里的插件开发 skill 提升到根目录 `skills/`，
并把内容对齐到当前版本——它停在 v0.4 的时代，AI 接入与界面令牌这两块完全没写。

### 1. 位置：`.zcode/skills/` → `skills/`

`.zcode/` 是某个 IDE 的私有目录，skill 放在里面等于只有那一个工具能看见；项目自己的
开发规范不该寄人篱下。用 `git mv` 迁移（保留文件历史），`.zcode/` 现在只剩会话/计划元数据，
`.gitignore` 从 `.zcode/plans/` 改成整目录。

### 2. 内容：补三块，校正三处

新增：

- **第 4 节 界面**（v0.6.5）：入口 `import '../../../src/shared/theme.css'`（这行同时给 reset，
  漏了就是"怎么拉伸都有滚动条"）、令牌清单、破坏性操作进 `···` + 右键 + 自绘确认框、
  插件页不引 naive-ui
- **第 5 节 AI 接入**（v0.6.2–v0.6.4）：`permissions: ["ai"]` + `ai.{tools,skill,mcp}` 三个
  目录内相对路径、`tools.json` 字段表与 `risk` 三档、`onToolCall` 写法与四条约定、
  `SKILL.md` 只解析 front-matter、MCP 命令默认不执行且绑定指纹
- **验证清单第 6、7 条**：声明了 AI 工具要真问一句触发调用；动插件系统本体才需要 smoke

校正（原文这几点是错的，照抄会白折腾）：

| 原来说法 | 实际 |
|---|---|
| 要 AI 能力就声明 `permissions: ["ai"]` + `features: ["ai"]` | `features` 里的 `"ai"` 在 `PLUGIN_FEATURES` 有名字，但**没有任何代码消费它**。门槛是权限 + `ai.tools` + 用户授权 |
| 第三方插件声明了也进不来（`internalOnly`） | `plugin:ai.*` 里 `plugin:ai.tool.reply` **不是** internalOnly，第三方插件正是靠它回执。进不来的是对话/确认/附件/会话那几组 |
| external 型也能声明 ai | 主进程 `normalizeAiSection` 直接拒掉并告警：没有页面能回执 |

### 3. 脚手架跟上

- `--ai` 一次生成 `public/ai/{tools.json,SKILL.md}` 并打开 `ai` 权限，工具名自动从目录名
  转成合法短名（`demo-tool` → `demo_tool`）；`--ai` + `--external` 直接报错退出
- manifest 补 `apiVersion: 2`（否则 v0.6 的 `window`/`ai` 字段落在 1 档）
- 生成的 `main.ts` import 令牌、`App.vue` 用令牌写样式并补上 Esc → `appapi.exit()`

### 关键文件

- `skills/quicklauncher-plugin-dev/SKILL.md`（重写，7 节工作流 + 7 条铁律 + 17 条坑）
- `skills/quicklauncher-plugin-dev/references/api.md`（补 `ai.*` 全量签名与 internalOnly 标注、
  界面令牌表、工具回执约束表）
- `skills/quicklauncher-plugin-dev/scripts/scaffold.mjs`（`--ai`、apiVersion、令牌化骨架）
- `CLAUDE.md` §4/§7、`README.md`、`.gitignore`（路径与新事实同步）

### 验证

- 在临时目录跑了三次脚手架：web + `--ai`（10 个文件齐全，`tools.json`/`plugin.json` 内容正确）、
  external（只有 manifest + icon）、`--ai` + `--external`（退出码 1 并给出原因）
- 本次不涉及 TS 源码，未跑 typecheck / test / smoke

### 遗留事项

- `PLUGIN_FEATURES` 里的 `"ai"` 要么接上消费点，要么删掉——现在它只是一个会误导人的名字
- skill 与 `docs/plugin-dev-guide.md` 有内容重叠（前者给 AI、后者给人读）。这次以"skill 讲
  怎么下手、guide 讲全量字段"分工，字段表已改为指向 guide，避免第三份真相

---

## v0.6.6 — 内置插件统一到同一套 UI 基线（2026-11-03）

**目标**：v0.6.5 只把主面板与 AI 插件收成了一套，其余四个内置插件还各写各的——四份 reset、
四份按钮样式、四个色系（翻译插件甚至是天蓝色），删除入口也还是"行尾一个 ✕"。
这一版把插件页也拉进同一个基线。

### 1. 公共层：`src/shared/plugin-ui.css`

和 `theme.css` 的分工写进了文件头：theme.css 给**值**（颜色、圆角、阴影、reset、滚动条），
plugin-ui.css 给**形**（插件页共有的结构）。放这里而不是塞进 theme.css，是因为主面板有
自己的组件体系（PanelShell / ContextMenu / OverlayHost），这些类对它没用；反过来插件页
是独立构建，拿不到宿主组件，只能靠 CSS。

提供的东西：`.pl-page`（三段式满高）、`.pl-head` / `.pl-title`、`.pl-btn`（含 primary / danger）、
`.pl-icon-btn`、`.pl-input` / `.pl-search`、`.pl-list` / `.pl-row`（含 `.tile` 卡片变体与
`.active`）、`.pl-empty` / `.pl-tip` / `.pl-hint`、`.pl-mask` / `.pl-dialog` / `.pl-actions`。
`body` 在插件页统一 13px（面板是浮窗，网页默认 16px 一屏装不下几行）。

顺带给 theme.css 补了四个语义令牌：`--scrim`（遮罩）、`--toast-bg`、`--mark` / `--mark-soft`
（搜索命中高亮）、`--on-accent`（落在主色/危险色底上的文字）。以前这些散在各处写死。

### 2. 浮层组件从"每个插件一份"变成共享

v0.6.5 把 `PopMenu` / `ConfirmDialog` 做在 AI 插件里，当时的判断是"插件页是原生层，
宿主组件复用不了"。这话只对了一半——**宿主**那份确实复用不了（OverlayHost 体系不同），
但插件与插件之间是可以复用的：它们都是独立构建，跨目录 import 一个 .vue 完全没问题
（`theme.css` 早就这么干了）。

于是有了 `src/shared/ui/{menu.ts,PopMenu.vue,ConfirmDialog.vue}`，AI 插件的本地副本删掉。
共享版本比原来多了三件小事：上下键在菜单项间移动焦点、滚动容器一滚就关（否则菜单悬在半空）、
菜单项支持 `disabled`。

### 3. 四个插件重做

| 插件 | 改动 |
|---|---|
| 计算器 | 只换了皮：键盘/屏幕/运算符全部走令牌，删掉自己的 reset 与按钮样式 |
| 剪贴板 | 行从"透明文本"改成卡片式 `.pl-row.tile`；行尾 `✕` 换成 hover 出现的 `···`（右键同菜单）；「清空」从页头按钮挪进页头 `···`，并且**先确认再清** |
| 翻译 | 天蓝 `#0ea5e9` 换成主色 indigo（之前和整个面板像两个产品）；侧栏三个小图标（↑↓✕）换成一个 `···`，右键同菜单；添加源的弹窗改用 `.pl-dialog` 骨架 |
| 手册 | 六百科 CSS 逐条令牌化；自定义文档行的 `✕` 换成 `···`（阅读 / 在目录中查看 / 删除 + 确认）；搜索高亮与定位闪烁改用 `--mark` |

### 关键决策

1. **确认框只该有一种长相**。复制到第三份时必然有一份按钮顺序是反的，所以宁可在
   `src/shared/ui` 里维护一份"插件版"，也不让每个插件自己画。
2. **插件页不引 naive-ui**。AI 插件的界面是手写的，四个插件若各引一套组件库，主题覆盖、
   体积、圆角粒度都会再次分叉；这次给的是一条 CSS 骨架，成本几乎为零。
3. **`···` 的可见性按行高定档**：剪贴板/会话这类密行默认隐形（hover / 选中才出），
   列表页常驻 35% 透明。全部隐形等于入口不可发现，全部常驻又会让列表变成图标墙。

### 关键文件

- `src/shared/plugin-ui.css`（新，插件页公共层）
- `src/shared/ui/{menu.ts,PopMenu.vue,ConfirmDialog.vue}`（新，插件页浮层）
- `src/shared/theme.css`（新增 `--scrim` / `--toast-bg` / `--mark` / `--mark-soft` / `--on-accent`）
- `plugins/{calculator,clipboard,translator,handbook,ai}/src/{main.ts,App.vue}`
- 删除：`plugins/ai/src/components/{PopMenu,ConfirmDialog}.vue`、`plugins/ai/src/menu.ts`

### 验证

- `pnpm typecheck` 零错误；`pnpm test` 268/268
- `pnpm build:plugins` 五个插件全部构建通过（跨目录 import `.vue` 与 `.css` 都没问题）
- `pnpm smoke` **135/135**（选择器与交互契约未变，AI 页的 `.composer textarea` 仍在）
- 逐屏截图核对：计算器、剪贴板空态/列表/行菜单/页菜单/清空确认、翻译空态/添加弹窗、
  手册正文/管理页/文档行菜单/删除确认、AI 页与会话菜单
- 四页 `document.documentElement.scrollWidth === clientWidth`（无横向溢出）

### 顺带修掉的

- 手册侧栏底部的横向滚动条：`.kw` 用 `width: calc(100% - 18px)` 再加 `margin-left: 27px`，
  必然溢出，改 `width: auto` + margin；`.side` 补 `overflow-x: hidden`
- 剪贴板「清空」原本点了就清，没有任何确认
- 翻译插件的 `#0ea5e9` 与 indigo 主题打架

### 遗留事项

- `PLUGIN_FEATURES` 里的 `"ai"` 仍没有消费点（名字误导，见 v0.6.5 遗留）
- 计算器键盘区在超宽窗口下按键会被拉得很大，沿用原布局，未加最大宽度
- 宿主与插件页的浮层仍是两份实现（定位/Esc/焦点逻辑重复），彻底合并需要把宿主也切到
  插件版组件上，牵扯 OverlayHost 的可见性登记，留到后面单独做

---

## v0.6.5 — 界面统一与操作收口（2026-11-03）

**目标**：把"一个功能一个样子"的界面收成一套。三件事：横向对齐颜色/圆角/边框/间距；
把散布在行尾的破坏性按钮收进 `···` 菜单；修掉 AI 助手页常驻的横竖滚动条。

### 1. 设计令牌只有一份（`src/shared/theme.css`）

核心渲染层与插件页是两套独立构建，但用户看到的是同一块面板里的两块。以前各自写死
`#1f2329` / `#8f959e` / `#e5e6eb`，同一个"灰"在不同组件里能出现四种深浅。

现在 `theme.css` 定义文本四档、边框两档、圆角五档、阴影三档、焦点环、缓动，两边的入口
都先 import 它，再加载各自的组件样式。插件页通过 `../../../src/shared/theme.css` 引用——
跨目录 import 在这套 vite 配置里是可行的，类型/协议文件早就有先例。

**细节**：滚动条从固定 14% 深灰改成"透明轨道 + 内缩 thumb"（`border: 3px solid transparent`
+ `background-clip: padding-box`），静止时几乎看不见，悬浮变深。

### 2. AI 页滚动条的真正原因不是布局，是没做重置

插件页的 `index.html` 从未引入任何 reset：`body` 默认 8px margin 还在，而 `.app` 又写了
`height: 100vh`。文档高度 = 100vh + 16px，垂直滚动条于是常驻；滚动条占宽后再叠加
`textarea` 的 content-box 宽度，横向也溢出。

修法不是 `overflow: hidden` 盖上，而是把 reset 补上（`html/body/#app` 满高、`box-sizing`
统一、margin 归零），`.app` 改用 `100%`。**这类"怎么拉伸都有滚动条"的问题，先怀疑盒模型，
再怀疑布局。**

### 3. 破坏性操作一律进 `···`，并配自绘确认框

用户的原话是"不直接用删除"。真正的问题不是图标不好看，而是**删除和打开只差 20px**：
鼠标一抖就是不可逆操作。改动覆盖五处：

| 位置 | 原来 | 现在 |
|---|---|---|
| AI 会话列表 | hover 出现 `×` + `window.confirm` | `···` → 重命名 / 删除；右键同菜单；自绘确认框 |
| 全部应用 | 一排 4 个图标按钮（含垃圾桶） | 主操作只留 `···`，右键同菜单 |
| 设置 → 外部应用 | 编辑 + 删除气泡确认 | `···` → 编辑 / 从启动器移除 |
| 设置 → 插件管理 | 打开目录 + 卸载气泡确认 | `···` → 打开目录 / 卸载 |
| 设置 → 模型服务 | 「测试 编辑 删除」三个文字按钮 | `···` → 测试 / 编辑 / 删除 |
| 应用详情 | 「清除插件数据」与「打开」并排 | 移到右上 `···` |

`window.confirm` 一律换掉：它在这个圆角浮窗里像另一个程序弹出来的，还会阻塞渲染进程。
自绘的确认框固定在"取消在左、默认焦点在取消"——回车就能通过的删除确认等于没有确认。

**`···` 的可见性分两档**：会话列表项多、行矮，默认隐形（hover/选中才出现）；列表型页面
行高足够，常驻 35% 透明、hover 变实——完全隐藏会让"这里有操作"没人发现。

### 4. 顺手修的三处不一致

- **naive-ui 主色是绿色**，和面板的 indigo 摆在一起像两套设计。在 `NConfigProvider` 用
  `themeOverrides` 覆盖 `primaryColor` 系与圆角字号，`NButton`/`NSwitch`/`NSelect` 一次性对齐。
- **快捷键显示成 `CommandOrControl`**：accelerator 是给 Electron 看的，界面上映射成 `Ctrl`/`Win`。
- **全局 `:focus-visible` 与组件焦点态叠加**：搜索框、对话输入框本来就有自己的焦点表达，
  各自 `box-shadow: none` 掉全局环，避免"框里还有一圈框"。

### 关键文件

```
src/shared/theme.css                     设计令牌 + 重置 + 滚动条（两端共用）
src/renderer/src/components/ContextMenu.vue   重写：分隔线、hint、测量后翻转定位
src/renderer/src/components/ConfirmDialog.vue 新增：宿主侧确认框
plugins/ai/src/components/PopMenu.vue         新增：插件页浮层菜单（宿主浮层盖不到插件页）
plugins/ai/src/components/ConfirmDialog.vue   新增：插件页确认框
plugins/ai/src/App.vue                        会话列表、气泡、composer、工具卡片
src/renderer/src/components/{AppManage,SettingsView,AiSettings,PluginDetail,AppTile}.vue
```

### 验证

- `pnpm typecheck` 0 错；`pnpm test` 268/268（纯逻辑层未受影响）
- `electron-vite build` + `build:plugins` 通过
- `pnpm smoke` 135/135（选择器与交互契约未变）
- 逐屏截图核对：主界面、全部应用（含 `···` 菜单）、设置四个分组、应用详情、
  AI 空态 / 会话菜单 / 删除确认框
- 交互实测：新建会话 → 行内重命名（`重命名测试`）→ `···` 删除 → 确认框 → 列表从 11 项变 10 项

### 遗留

- **组件不能跨构建复用**：`PopMenu` / `ConfirmDialog` 在宿主与插件页各有一份实现。
  两边样式令牌已统一，但逻辑（定位、Esc、焦点）是重复的。等插件页需要第三个浮层时，
  再抽一个不含 Vue 依赖的 `positionPopover(el, x, y)` 工具函数共享定位逻辑。
- 只有 AI 插件做了页面级视觉重做；计算器/记事本/翻译等仍是各自原有样式，
  与宿主差距不大但未逐屏核对。

---

## v0.6.4 — MCP 接入（2026-11-02）

**目标**：让插件能把外部 MCP server 的能力接进对话，同时不把「执行任意命令」这件事
变成一次静默授权。验收口径三条：能列出并调用工具、确认弹窗展示完整 argv 且改参数要重新确认、
server 崩了对话还能继续。

### 1. 为什么自写客户端而不是用官方 SDK（`ai/mcpClient.ts`）

官方 `@modelcontextprotocol/sdk` 把进程管理、传输、版本协商都包了，但**恰恰是我们最需要
掌控的部分**被藏起来：崩溃计数、stderr 归因、Windows 上杀子进程树、建连预算。要在它的
抽象上插一手，比从头写这一层更绕。

而 MCP 的 stdio 传输本身很薄：**按行分帧的 JSON-RPC 2.0**（不是 LSP 的 `Content-Length`），
工具场景只需要 `initialize` / `tools/list` / `tools/call` 三个方法。这与项目一贯的口径一致
（SSE 解析、表达式求值都是自己写的）：协议足够简单就自己写，依赖留给真正复杂的地方。

代价明确写下：只支持 tools 一族，`resources` / `prompts` / `sampling` / `roots` 一律不碰。
这层薄到可以随时替换成 SDK，真需要时再换。

### 2. 审批绑定指纹，而不是布尔（`ai/mcpSpec.ts` + `config.aiMcpApprovals`）

插件自带的 MCP 声明等于「让启动器执行一条命令」。如果只存 `true/false`，那等于
「允许这个插件以后执行任何命令」——确认就变成了摆设。

所以存的是 `command + args + env + cwd` 的 sha256 前 32 位。任何一个字符变了，指纹对不上，
状态回到 `stale`，用户必须重新看一遍再批。`timeoutMs` **故意不进指纹**：超时是本地策略，
改它不该让用户重新授权一次执行。

状态机（`stateOf`）：`pending` → `approved` / `rejected`；命令改了 → `stale`；
连续失败 3 次 → `disabled`（本会话内）。

### 3. 不经过 shell 是唯一的安全边界（`mcpClient.ts`）

`spawn(command, args, { shell: false })`。于是 `args: ["a; rm -rf /"]` 只是一个普通参数。
这条路走通了，就不需要去写「危险字符正则」——那种正则永远漏。

env 是**合并**而不是替换（`{...process.env, ...spec.env}`）：`npx`、`node`、`uvx` 都靠
PATH 找到，清空 env 会让绝大多数社区 server 直接起不来。

### 4. 生命周期：懒启动、崩溃计数、退出收尸（`ai/mcpManager.ts`）

- **懒启动**：批准时就建连（这是用户唯一一次主动要求它跑起来的机会，等几秒可接受），
  之后进程常驻；每次对话前 `ensureForChat` 只补「还没连上的」，总预算 3 秒。
  超预算的那几个本轮只是不出现——模型少一个工具照样能答，让用户等 20 秒才见第一个字才是坏体验。
- **崩溃计数**：建连失败或调用时发现进程没了，都记一次；成功执行一次工具才清零。
  达到 3 次停用。不这么做的话，一个配置错误的 server 会在每轮对话里重启一次。
- **退出收尸**：`shutdownAi` 里 `shutdownMcp()`。Windows 上用 `taskkill /pid <pid> /T /F`，
  因为 `npx` 起的 node 是孙进程，只 kill 父进程会留孤儿。

### 5. 风险等级来自服务端注解

`annotations.destructiveHint` → `dangerous`，`readOnlyHint` → `read`，都没有 → `write`。
两个都标了（自相矛盾）按更危险的算。这样第三方 server 的危险工具会自动进入
v0.6.3 那套确认流程，不需要插件作者再声明一遍。

### 6. 顺手补的漏洞：插件的 AI 授权也是闸

第一版里 MCP 工具只看「命令批没批」，于是出现一个说不通的组合：用户在「AI 工具」里
关掉某个插件（意思是「别让它参与 AI」），它的 MCP 工具却照样下发。

修法：`isUsable` 要求**命令已批准 且 插件已授权**；同时批准命令时顺手把插件的开关打开
（用户已经为这条命令点过允许，再让他去另一个地方开一次是多余的）。

### 7. 冒烟踩到的自身问题

第一版断言「初始状态是 pending」，第二次跑就挂了——上一轮留在 config 里的审批记录
让新声明的命令变成 `stale`。这不是产品 bug，是冒烟不够隔离。

修法：`mcp.json` 声明两个 server，`idle` 永远不批准，专门用来断言「默认不启动」与
「argv 完整可见」；`mock` 走完整流程。改完连跑两次均通过。

### 关键文件

新增 `src/main/ai/{mcpSpec,mcpClient,mcpManager}.ts`、`src/renderer/src/components/AiMcpConfirm.vue`、
`scripts/mock-mcp-server.mjs`、`tests/aiMcp.test.ts`；改 `config.ts`（`aiMcpApprovals` + 洗脏值）、
`shared/ai.ts`（MCP 常量与 `AiMcpServerView`）、`ai/{toolCatalog,toolExec,chat,index,audit,toolsSpec}.ts`、
`preload/panel.ts`、`renderer/src/{env.d.ts,components/AiSettings.vue}`、`scripts/smoke.mjs`。

### 验证

- `pnpm typecheck` 0 错；`pnpm test` **268/268**（+21）；`npx electron-vite build` + `build:plugins` 通过
- `pnpm smoke` **135/135**（+11），其中 MCP 段：
  - `MCP server 声明被识别且默认不启动 — pending / running=false`
  - `设置页能拿到完整 argv（确认的依据） — …mock-mcp-server.mjs --idle`
  - `env 只暴露键名（值里可能带 token） — SMOKE_MCP`
  - `允许后建连并列出工具 — ok / 2 个工具`
  - `MCP 工具被模型调用并返回结果 — mcp_com_smoke_probe-ai_mock_echo → 回声：你好，MCP`
  - `命令改动后旧批准失效，回到待确认 — stale / … --smoke-changed`
  - `MCP 的高危工具同样要确认 — 「让服务崩掉」/ 高风险`
  - `server 崩溃后工具以错误回给模型 — 退出码 7`
  - `server 崩溃后对话仍可用 — 你好，我是本地 mock 端点。`
  - `审计区分工具来源（内置/插件/MCP） — mcp:com.smoke.probe-ai:mock:echo / mcp`
- 连续跑两次冒烟均 135/135（验证上一轮的审批记录不会污染下一轮）

### 遗留

- `npx -y` 首次启动要下载依赖，可能超过建连预算（20s）；真实社区 server 未实测（本机无网侧依赖）
- 停用（3 次失败）后没有「重新启用」入口，要重启应用
- 只支持 stdio，未做 http 传输；不支持 resources/prompts/sampling
- 进程常驻到退出，没有空闲回收（重启成本比内存贵，先这么定）

---

## v0.6.3 — 工具调用（2026-11-02）

**目标**：让 v0.6.2 登记好的工具真正跑起来——模型可以调启动器自身的能力和插件的工具，
有副作用的操作先问人，每次调用留痕。验收口径是那句「把剪贴板里的地址用翻译插件翻一下」
能从头走到尾。

### 1. 工具目录（`ai/toolCatalog.ts`、`ai/toolNames.ts`、`ai/builtinTools.ts`）

内置 7 个工具：`launcher_search`、`launcher_open`、`clipboard_read`、`clipboard_write`、
`docs_search`、`docs_read`、`skill_read`。它们和插件工具一样走 `toolsSpec` 解析——
参数校验、描述长度上限、风险缺省值**同一套代码**，不会出现「内置的松、插件的紧」。

两个必须在这里解决的事：

- **函数名合法化**。OpenAI 的函数名只允许 `[A-Za-z0-9_-]{1,64}`，而插件工具的全局名是
  `plugin:<id>:<name>`（带冒号与点），直接下发会被端点 400。下发前换成
  `plugin_com_launcher_calculator_calculate`，并保留「函数名 → 工具」反查表；
  执行前一律按表反查，**模型给的名字不能当身份**。超长 id 用 前缀+短哈希 防撞名。
- **目录每次发消息重建**。用户刚撤销授权，下一条消息就不该再看到那个工具；
  不做跨轮缓存（`tools.json` 的解析结果仍按 mtime 缓存，那是另一回事）。

内置工具不需要授权开关（读的是启动器自身状态，不涉及第三方数据），但写操作照样受风险分级。

### 2. 执行链（`ai/toolExec.ts`）

顺序固定：**解析参数 → schema 校验 → 风险确认 → 执行 → 审计**。不能换：先确认后校验，
用户点了「允许」才被告知参数不合法；先执行后确认，那是先斩后奏。

失败一律变成 `tool-result`（ok=false + 给模型看的原因）而**不是抛出去结束这一轮**：
模型拿到「超时」「参数不对」「用户拒绝了」还能换个办法，直接断掉对话用户只能看到一句报错。

### 3. 工具宿主（`ai/toolHost.ts`）

插件工具的执行必须发生在**插件自己的页面里**：数据、权限、存储在它的渲染进程，
主进程替它执行等于把插件能力搬进一个权限更高的地方。

- 复用 `pluginHost` 的视图（`warmPluginContents`）而不是另建一套隐藏 webContents：
  同一插件两个实例会互相踩存储与生命周期，代价比省下的几十 MB 更大。
- 页面没起来就先等加载（10s），等不到回「页面没有就绪」而不是让模型干等超时。
- 超时用工具自己声明的 `timeoutMs`；迟到的回执按 callId 找不到等待者，直接丢弃。
- 崩溃/被回收：**重建一次**再试；再失败就如实回报。业务报错不重试（参数错了重试也一样）。
- 空闲 60s 回收视图，但用户正开着它（面板激活/分离窗口/可见）就不动。
- 回执照 callId + `callerRegistry` 双重核对来源，任何插件都不能冒充别的插件回结果。

### 4. 风险确认（`ai/confirm.ts`）

- `read` 直接执行；`write` 每次问（可勾「本次会话内不再询问」）；`dangerous` 每次问且**不可记住**。
- **超时按拒绝**（60s）：用户走开、面板被收起都不能变成一次静默授权。
- 点停止会立刻把等待中的确认按拒绝收尾，否则那个 Promise 还要挂满 60 秒。
- **确认框画在 AI 页里，不是主面板的 OverlayHost**：插件页是原生 WebContentsView，
  盖在核心渲染层之上，OverlayHost 的弹窗只会出现在它下面（用户看到的是被遮住的对话）。
  交互规则与 OverlayHost 对齐：遮罩、Esc = 拒绝、默认焦点不给「允许」。

### 5. 回合循环（`ai/chat.ts`、`ai/toolCalls.ts`）

- 流式 `tool_calls` 碎片**按 index 归并**：并行调用时两路碎片交错到达，按顺序拼会把
  A 的参数接到 B 上；id 只在第一帧出现，不能拿「这帧没 id」当新调用。
- 上限：单条消息 4 轮、8 次调用。触到上限时给未执行的调用补一条「未执行」结果再收尾——
  assistant 的 `tool_calls` 缺对应 `tool` 消息会让下一次请求直接 400。
- 工具调用与结果**都落进会话**（`tool_call` / `tool_result` part），切走再回来、下次继续
  都还在；只调工具没写正文的回答不会被当成空消息丢掉。
- 用户停止：正在等的确认/执行立即收尾，已产生的部分保留并标 `stopped`。

### 6. 协议变更

- `plugin:ai.tool.reply`（非 internalOnly，插件是回执方）+ `plugin:ai.tool.confirm`
  （internalOnly：能自批的确认等于没有确认）。
- `appapi.ai.onToolCall(handler)`：回调返回字符串或 `{ok,result,error}`；抛错按失败回执。
- `appapi.ai.onDelta` 改为**支持多个订阅者并返回退订函数**。原来的「后注册的顶掉先注册的」
  在这一版直接咬了一口：工具确认事件被测试脚本的监听器顶掉，界面永远收不到确认框，
  每次 tool 调用都卡到超时。顺带发现 `offDelta(callback)` 这种按引用取消在 contextBridge
  两侧不可靠，改成返回闭包。

### 7. 审计（`ai/audit.ts`）

`userData/ai/audit.jsonl`，一行一次调用：时间、会话、消息、工具、来源插件、风险、
参数（截断 2000 字）、是否确认（allowed/denied/timeout/not-required）、耗时、错误。
只追加不重写；超过 2MB 轮转为 `audit.1.jsonl`（审计被自动删掉比占 2MB 更糟）。

### 关键文件

`src/main/ai/{toolCatalog,toolNames,builtinTools,toolExec,toolHost,toolCalls,confirm,audit}.ts`（新）、
`src/main/ai/{chat,chunk,client,provider,tokens,sessionModel,tools}.ts`、
`src/main/plugin/api/ai.ts`、`src/main/windows/pluginHost.ts`（`releaseIdlePluginView`）、
`src/main/index.ts`（启动器能力注入）、`src/preload/plugin.ts`、`src/shared/{ai,pluginApi}.ts`、
`plugins/ai/src/App.vue`（工具卡片 + 确认框）、`plugins/calculator/src/App.vue`（`calculate` 执行端）

### 验证

- `pnpm test` 247/247（+19）：工具名映射与撞名、流式碎片按 index 归并、`tool_calls` 解析、
  确认的分级/超时/会话记忆、工具调用进入历史（成对、无结果不伪造）
- `pnpm smoke` 124/124（+15，全部跑在本地 mock 端点上）：
  计算器工具调用并回结果、工具结果回填后继续生成、调用与结果落进会话、
  写操作弹确认并显示风险与参数、**「剪贴板 → 翻译插件」全链路**（确认允许 → 翻译页 webview
  带着那段地址打开）、用户拒绝后不执行且原因回到模型、`dangerous` 不给「不再询问」且未获准不执行、
  插件超时/插件抛错都以 tool-result.error 回给模型、审计日志有据可查（含被拒的高危调用）
- 手工：AI 页工具卡片（进行中/成功/失败三态）与确认框的样式、Esc 拒绝

### 遗留

- 「插件页面未就绪」这条失败路径没有在冒烟里造出来（要伪造加载失败），只做了代码路径与手工验证
- 确认超时固定 60s，没有做「面板被藏起时自动暂停计时」
- 内置工具没有在设置页列出（AI 页欢迎语里说了它们存在），用户不能逐个关掉
- 工具宿主复用 pluginHost 的视图，因此会占用 5 个常驻视图的名额；真实使用中若感到插件被频繁收复，再考虑独立宿主

## v0.6.2 — 插件 AI 协议（2026-11-02）

**目标**：让插件能把自己的能力"交给"AI——声明工具、写技能说明、由用户按插件授权。
这一版只做**登记与授权**，执行链路留给 v0.6.3；先把"谁有什么、谁被允许"做对，
执行层写出来才不漏。

### 1. manifest 扩展（`plugin/manifestAi.ts`）

新增 `apiVersion` / `window` / `ai` 三个字段，校验逻辑抽成纯函数（`manager.validate` 要摸 fs，
没法单测）。共同原则与 `hosts` / `features` 一致：**坏一项只丢一项**，插件照常加载。

- `apiVersion`：缺省 1；高于 2 按 2 并告警——未来版本的插件至少还能跑，拒载更糟。
- `window`：宽 420–2400、高 320–1800；只在**首次分离窗口**时作为默认尺寸，用户拉过就听用户的。
- `ai.tools` / `ai.skill` / `ai.mcp`：必须是**插件目录内的相对路径**且存在。
  挡掉 `../`、绝对路径、盘符、URL——这些写法会把「插件自带文件」变成「机器上任意文件」，
  而工具描述与技能正文都会进模型上下文，等于开了一条读任意文件的通路。
- `external` 型插件直接忽略 `ai`：没有页面能接收工具调用，发下去只会超时。

### 2. `ai/tools.json`（`ai/toolsSpec.ts`）

`parameters` 用 **ajv** 编译（这是当初在 CLAUDE.md 里预留的依赖例外，本版第一次真用上）。
理由：schema 形状完全开放（嵌套、枚举、oneOf 都可能），手写检查要么放过错参数，
要么拒掉合法工具。编译一次、每次调用跑一遍。

- 校验器直接返回**给模型看的一句话**（`/expression must be string`），而不是布尔——
  v0.6.3 会把它当 `tool-result.error` 回给模型，让它照着改参数重试。
- `risk` 缺省按 `write`（需确认）：漏写一行就静默放行，代价不可逆，宁可多问一次。
- `timeoutMs` 夹取到 [1000, 60000]；单个插件最多 32 个工具；description 截到 500 字
  （模型每轮都要读它，几十个工具就是几千 token）。
- 坏一个工具只丢一个：名字非法/重名/缺 description/schema 编译不过，其余照常可用。

### 3. `ai/SKILL.md`（`ai/skillFile.ts`）

front-matter 只解析 `name` / `description` 一层，**不引 YAML 解析器**——需要嵌套结构的
技能文档，用 Markdown 正文表达更自然。

只有 `name` + `description` 进目录，正文按需读（`load_skill`）。多插件场景下，
把每份 SKILL.md 全文拼进 system prompt 是最容易把上下文吃光的方式。

### 4. 授权与目录（`ai/tools.ts`）

- `config.json` 新增 `aiToolGrants`（插件 id 数组），**默认全空 = 一个都不授权**。
- 下发条件三样缺一不可：用户授权 + `permissions` 含 `ai` + 插件未停用，**每次实时算**，
  不缓存授权结果（撤销后必须立刻不下发）。
- 解析结果按文件 mtime+size 缓存：改完 `tools.json` 刷新设置页即生效，不用重启。
- 新通道 `plugin:ai.tools`（`internalOnly`）：给 AI 页看「现在手上有几个工具」；
  设置页走 `panel:ai-tools` / `panel:ai-set-tool-grant`。

### 5. 界面

- 面板图标右上角 AI 徽标（`AppTile`）：固定按钮出现时滑到右下角让位——
  直接隐藏会让已固定的应用永远看不到标记，而固定恰恰是最常用状态。
- 设置 → AI → **AI 工具**：逐插件开关、工具与风险等级、技能一句话说明、解析错误。
  未授权的插件也列出来，否则用户不知道有这能力可开。
- AI 页底部提示「N 个插件工具可用」，进入时与回到前台时刷新。

### 6. 示例

计算器新增 `public/ai/tools.json`（`calculate`：`risk: read`）+ `public/ai/SKILL.md`，
manifest 补 `apiVersion: 2` 与 `permissions: ["ai"]`，作为协议的活样例。

### 关键文件

`main/plugin/manifestAi.ts`（新）、`main/plugin/manager.ts`、`main/ai/toolsSpec.ts`（新）、
`main/ai/skillFile.ts`（新）、`main/ai/tools.ts`（新）、`main/ai/index.ts`、`main/index.ts`、
`main/config.ts`、`main/windows/pluginHost.ts`、`shared/ai.ts`、`shared/pluginApi.ts`、
`preload/{panel,plugin}.ts`、`components/{AppTile,AiSettings}.vue`、
`plugins/{calculator,ai}/public/*`、`tests/{pluginManifestAi,aiToolsSpec,aiSkillFile}.test.ts`

### 验证

- `pnpm typecheck` 0 错（tsconfig.json + tsconfig.web.json）
- `pnpm test` 228/228（+42：路径越界、坏 schema、重名/缺字段、front-matter 解析与截断）
- `pnpm build` + `build:plugins` 通过；`out/main` 里 `require("ajv")` 保持外部依赖形态
- `pnpm smoke` 109/109（+8）：
  - 探针插件的「一半好一半坏」tools.json → 只保留好工具、错误有记录、插件照常加载
  - 计算器被识别为 1 工具 + 技能、默认未授权、零解析错误
  - 未授权时 `appapi.ai.tools()` 为空；授权后出现 `plugin:com.launcher.calculator:calculate`
  - 面板图标出 AI 徽标且标题写明能力与授权状态
  - 撤销授权后立即停止下发

### 遗留

- 工具执行、风险确认、审计日志在 v0.6.3；本版声明了不会被调用
- `mcp` 路径只做存在性校验，真正读取在 v0.6.4

---

## v0.6.1 — 上下文与附件（2026-11-02）

**目标**：让 AI 真的能"看东西"——把文件拖进来就能问，长对话不再因为超窗口被服务端 400 打回。

### 1. token 预算（`main/ai/tokens.ts`）

自己估而不引 tiktoken：那套是 OpenAI 的分词器，对 DeepSeek / 通义 / 本地模型都不准，
却要带几 MB 的 wasm。这里只需要"不把服务端撑爆"，所以**宁可估高**——
估高只是少带几条历史，估低就是整条请求 400，而用户对那句报错完全无从下手。

- 口径：CJK 按 1 字 1 token（真实约 0.6–0.7），其余 4 字符 1 token，每条消息另加 4 开销。
- `fitTurns()` 从新到旧装，装不下就停；**最后一条必留**（用户刚说的话不能丢），
  单独超预算就从中间截断（保头 60% 尾 40%，中间写明"省略 N 字"）。
- 裁剪后不以 `assistant` 开头——部分服务端会因此 400。
- 图片按每张 800 token 计（1024² 在 gpt-4o 上约 765），带图时会更早开始丢。

### 2. 附件（`main/ai/{attach,extract,pdf}.ts`）

- **解析权只在主进程**。插件页把文件读成 base64 传上来，拿到的是一个 `attachId`；
  发送时回传 id，正文由主进程从暂存表重建。页面无法伪造一段文本冒充附件。
- 文本类（txt/md/json/代码/日志…）直读，UTF-8 解不开时回退 GBK（中文 Windows 的日志
  相当一部分是 GBK）；带 NUL 或大量控制字符的拒收，避免把改名的压缩包当文本灌进去。
- docx 用 `adm-zip` 解 `word/document.xml` 抽 `<w:t>`：不引 mammoth，因为模型要的是字不是样式。
- PDF 走 `unpdf`（pdfjs 的 serverless 构建），**ESM-only，用动态 `import()` 加载**——
  主进程产物是 CJS，但 CJS 里 `import()` 加载 ESM 是合法的，比引 pdfjs 全家桶省几十 MB。
  设 80 页与 20s 超时；扫描件抽不出字时给的是"没有文字层，需要 OCR"，而不是空串。
- 图片：原图存 `userData/ai/files/`，消息里只留宽 360 的 JPEG 缩略图（约 20–40KB）。
  否则一张 4MB 图 base64 进会话文件就是 5.3MB，几十条就把会话撑到几十兆（每次保存整体重写）。
- 上限：单文件 8MB、图片 4MB、进上下文的正文 6 万字、单条消息 6 个附件。

### 3. 多模态与视觉门槛

`ApiMessage.content` 支持 `string | ApiContentPart[]`，只有带图的消息才用数组
（兼容实现对数组的支持参差不齐）。**模型名不在 `visionModels` 里时提前拦下**并说明
"换一个能看图的模型或移除图片"——不拦的话服务端只会回一句 `invalid content type`。

### 4. 滚动摘要（`main/ai/summary.ts`）

超出预算时把**这次真正被丢掉的那一段**压成摘要，而不是每轮重新总结全部历史：

- `summarizeRange()` 是纯函数，三种"不压"都返回 null：丢得不够多（< 6 条）、
  上次摘要已覆盖到边界、摘要终点指向的消息已被裁掉（此时旧摘要不可信）。
- 摘要在**回答结束后**异步跑：不占用户等待时间，失败也静默（只是这轮不更新）。
- 落盘走 `saveSummary()`，只改 `summary`/`summaryUpTo` 两个字段、不动 `updatedAt`——
  否则一条半小时前的对话会在列表里突然跳到最前面，而用户并没有说话。
- 摘要以"【更早对话的摘要】"注入 system，和系统提示一起算进固定开销。

### 5. 面板「用 AI 询问」

搜索结果右键多一项：把条目名称/类型/启动命令/目录/关键词作为 `intent.askAbout`
带进 AI 插件，插件页顶部显示一个可关闭的引用条，发送时拼在正文前。
只带结构化字段，不带图标 base64 这类对模型没意义的东西。

### 坑

1. **`Math.max(64, 预算)` 这种"保底"会把截断结果顶爆**：预算 50 时强留 64，
   裁剪后反而比预算还大。下限应该只保证"还能读出几个字"，不是拍脑袋的 64。
2. **冒烟清理段把所有会话都删了**：早期写法是"列出会话逐个删"，一旦用户自己也用过
   AI 插件，跑一次冒烟就把他的对话清空。改成只删本次冒烟自己建的 sessionId。
3. **冒烟不指定模型就会打真实端点**：用户配了 DeepSeek 后，默认模型不再是 mock，
   冒烟断言拿到的是真人回答（内容对不上才发现）。现在发送一律显式带 `model`。
4. **vitest 缓存目录被沙箱的批量删除保护拦下**：`node_modules/.vitest-cache` 里
   条目数过阈值，`vitest` 启动时清理缓存被拒。整体 `mv` 走一次即可，不用删除。

### 关键文件

`src/shared/ai.ts`（附件/预算/摘要类型与上限）、`src/main/ai/{tokens,extract,pdf,attach,summary}.ts`（新）、
`ai/{chat,sessionModel,provider,client,settings,store,index}.ts`、`plugin/api/{ai,validate}.ts`、
`shared/pluginApi.ts`、`preload/plugin.ts`、`components/{AiProviderEdit,AiSettings}.vue`、
`components/PanelShell.vue`、`plugins/ai/src/App.vue`、`tests/ai{Tokens,Extract,Summary}.test.ts`（新）、
`scripts/smoke.mjs`

### 验证

- `pnpm typecheck` 零错误
- `pnpm test` **186/186**（新增 38 项：估算口径、裁剪规则、中间截断、编码回退、
  docx 抽取、二进制嗅探、上限截断、摘要触发条件）
- `pnpm build` 通过；`build:plugins` 通过；产物里 `import("unpdf")` 保持动态导入形态
- `pnpm smoke` **101/101**（新增 6 项：文本附件抽取、不支持类型被拒、图片缩略图、
  附件进上下文且请求体含正文、图片走多模态 content 数组、面板条目上下文可见）

### 遗留事项

- **PDF 中文抽取质量未实测**：本机没有中文 PDF 样本，unpdf 的 CJK 表现待验证
- GBK 回退依赖运行时带完整 ICU（Electron 自带，Node 精简构建下会退化为 UTF-8）
- 图片只测了 1×1 PNG，大图缩略的耗时与内存未压测
- 摘要链路已由纯函数覆盖，但"摘要请求真的发出去了"只在 mock 端点上手验过一次

---

## v0.6.0 — AI 内核与对话（2026-11-02）

**目标**：让启动器里有一个能用的 AI 对话应用，并且把"模型调用"关在主进程里
（密钥不进插件页），为后面几版的插件 AI 协议（tools / skill / MCP）铺好通道。
设计见 [ai-architecture.md](ai-architecture.md)。

### 1. 主进程 AI 服务（`src/main/ai/`）

- **纯逻辑四件套**（可单测，不碰 electron）：
  `sse.ts`（有状态 SSE 解码，扛得住"帧横跨两次 read"）、`chunk.ts`（OpenAI 增量解析：
  正文 / `reasoning_content` / usage / 流内 error）、`provider.ts`（地址归一、模型 id 解析、
  密钥掩码、请求体构造）、`sessionModel.ts`（造消息、取标题、转请求体、裁剪）。
- **IO 层**：`client.ts`（fetch + 流式读取，HTTP 错误按状态码给方向）、`secrets.ts`
  （`safeStorage` 加密落 `userData/ai/secrets.bin`）、`settings.ts`（provider 增删改、
  默认模型、`resolveModel` 把"发不出去"的每种原因说清）、`store.ts`（一会话一文件 + `index.json`，
  tmp/rename 原子写，索引坏了按目录重建）。
- **`chat.ts` 编排**：用户消息先落盘（进程被杀也不丢问题）→ 流式增量 → **只在结束时**
  落一条完整回答。两个刻意的取舍写在注释里：停止/失败/崩溃后不会留下"永远正在输入"的半截消息；
  增量每 16ms 合并一次再发 IPC（长回答少掉几千次 send）。

### 2. 契约与网关（纯增量）

- `shared/ai.ts` 定义消息/会话/模型/流式事件；`shared/pluginApi.ts` 加权限 `ai`、
  功能 `ai`、7 条 `plugin:ai.*` 通道与事件通道 `plugin:ai.delta`。
- `api/define.ts` 新增 `internalOnly`；网关只加一句判定：`internalOnly` 要求
  `source === 'builtin'`。**模型调用花的是用户的钱，第三方插件声明了权限也调不通。**

### 3. 内置 AI 插件（`plugins/ai/`）

左侧会话列表（新建/删除/条数）、右侧流式消息、模型下拉、停止按钮、复制答案、
`reasoning` 折叠展示；`Esc` 两段式（有草稿先清草稿，再按才退出）。
**懒建会话**：打开插件不写盘，发第一条消息时才创建——否则每次打开都多一条空会话。

### 4. 设置页「AI」分组

`AiSettings.vue`（默认模型 + provider 列表 + 测试/编辑/删除）+ `AiProviderEdit.vue`
（预设 6 种：DeepSeek / 通义 / Kimi / Ollama / OpenAI / 自定义；模型逗号分隔；密钥框
在编辑态留空表示不修改）。密钥只以 `sk-…a1b2` 回显，「测试」打 `/models`，不花对话额度。

### 三个坑（都花了时间）

1. **`abort()` 之后 fetch 的 body 可能"正常结束"而不是抛 `AbortError`**：只看异常会把
   用户主动停止记成一次完整回答（界面没有"已停止"）。改为以 `controller.signal.aborted`
   为准。另一个坑：`DOMException` 在部分运行时不继承 `Error`，`instanceof` 判定不可靠。
2. **`ai.chat.send` 一开始 await 到流结束**：结果调用方的 `await` 一直挂到整段回答生成完，
   同一页面里连"停止"都发不出去（我的端到端测试就是这样发现它的——停止请求先到、
   流其实早已结束）。改为立刻返回"已受理"，结果一律走事件。
3. **preload 的 `onDelta` 只保留最后一个回调**：插件 App 在 `onMounted` 里注册，
   冒烟脚本若抢在挂载前注册就会被覆盖（表现为一个事件都收不到）。冒烟里先等
   `.composer textarea` 出现再注册。

### 关键文件

`src/shared/ai.ts`（新）、`src/main/ai/*`（新，8 个）、`plugin/api/ai.ts`（新）、
`api/define.ts`、`plugin/gateway.ts`、`preload/{plugin,panel}.ts`、`main/index.ts`、
`components/{AiSettings,AiProviderEdit}.vue`（新）、`SettingsView.vue`、`components/icons.ts`、
`plugins/ai/*`（新）、`tests/ai{Provider,Sse,SessionModel}.test.ts`（新）、`scripts/smoke.mjs`

### 验证

- `pnpm typecheck` 零错误；`pnpm test` **148/148**（新增 25 项：SSE 分片边界、增量解析、
  地址与模型 id、密钥掩码、配置清洗、请求体、标题/裁剪/排序）
- `pnpm build` 通过；`build:plugins` 通过（新插件 75KB）
- `pnpm smoke` **95/95**（新增 9 项：provider 保存与掩码、探活、插件页可打开、界面挂载、
  消息受理、流式拼接、会话落库、停止标记、停止后无半截）
- 端到端（临时脚本 + 本地 mock 端点，15 项）：配置 → 探活 → 打开 AI → 流式 → 停止 → 清理，
  15/15；停止在 431ms 内收到 `done{stopped:true}`，保留 24 字已生成内容
- **未验证**：真实第三方端点（本机没有可用 key，用的是 mock）、`reasoning` 在
  deepseek-reasoner 上的实际形态、超长会话的 token 预算（v0.6.1 才有）

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
