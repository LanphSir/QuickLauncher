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
