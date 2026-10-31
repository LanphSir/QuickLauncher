# QuickLauncher 架构说明

一个全局快捷键唤起的插件化桌面工具面板（类 uTools），Windows 优先。

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面框架 | Electron 38 + TypeScript |
| 构建 | electron-vite（main/preload/renderer 三端一体） |
| 主面板 UI | Vue 3 + Pinia + Naive UI |
| 插件 UI | Vue 3（每插件独立 vite 构建，产物为纯静态资源） |
| 包管理 | pnpm workspaces（根应用 + `plugins/*` 子包） |
| 打包 | electron-builder（NSIS 安装包） |

## 进程模型

```
┌─ 主进程（src/main）──────────────────────────────┐
│ index.ts        入口：单实例锁、装配、面板 IPC        │
│ config.ts       全局配置（userData/config.json）      │
│ hotkey.ts       全局快捷键注册/冲突回滚               │
│ tray.ts         托盘菜单（显示/自启/退出）             │
│ windows/panel      无边框透明主面板（失焦隐藏）         │
│ windows/pluginHost 每插件一个 WebContentsView 宿主      │
│ plugin/manager     扫描插件目录、校验 manifest、注册表   │
│ plugin/gateway     插件 API 网关（身份 + 权限校验）      │
│ plugin/callerRegistry  webContents→插件 身份映射        │
│ services/storage   按插件隔离的 JSON 存储               │
│ services/docs      按插件隔离的文档库（docs 权限）        │
│ services/external  external 型插件拉起（spawn/shell）   │
├─ 主面板渲染进程（src/renderer）───────────────────┤
│ 搜索框 / 已固定网格 / 全部应用 / 设置（Vue3 + Pinia） │
├─ 插件渲染进程 × N（每插件独立 WebContentsView）─────┤
│ sandbox:true + contextIsolation:true                │
│ preload 注入受控 window.appapi                      │
└──────────────────────────────────────────────────┘
```

## 插件协议

插件 = 一个含 `plugin.json` 的目录。扫描位置：

- 开发模式：`<项目根>/plugins/`（子目录本身含 plugin.json，或其 `dist/` 内含）
- 打包后：`<resources>/plugins/builtin/`（由 `scripts/collect-plugins.mjs` 收集）

```jsonc
// plugin.json
{
  "id": "com.launcher.clipboard",   // 必填，反向域名，/[\w.-]+/
  "name": "剪贴板历史",              // 必填
  "type": "web",                     // 必填：web | external
  "entry": "index.html",             // web 型必填，相对插件目录
  "command": "notepad.exe",          // external 型必填（exe 路径/命令或 http(s) URL）
  "args": [],
  "keywords": ["clip", "剪贴板"],    // 搜索关键词
  "permissions": ["storage", "clipboard", "notify"]
}
```

图标：目录下 `icon.svg` / `icon.png` / `icon.ico` 任一，主进程转 dataURL 下发。

## 隔离机制（互不干扰）

1. **进程隔离**：每个 web 插件独立 `WebContentsView`（独立渲染进程），单个插件崩溃只影响自身（`render-process-gone` → 移除该实例 → 面板 toast，其余不受影响）。
2. **上下文隔离**：`sandbox: true` + `contextIsolation: true`，插件拿不到 Node/Electron 原生 API，只能通过 preload 暴露的 `window.appapi`。
3. **权限模型**：manifest `permissions` 声明，网关逐调用校验（storage/clipboard/notify/shell/docs），未声明直接拒绝；窗口控制（hide/exit/info）无需权限。
4. **数据隔离**：存储强制命名空间 `userData/data/<pluginId>/store.json`，插件无法访问其他插件数据。
5. **加载隔离**：只从固定插件根目录扫描，manifest 校验失败即跳过，id 冲突先到先得。

## 插件文档库（docs 权限，v0.4.0）

插件拿不到任何路径能力（铁律 4），但"让用户把自己的文档丢进来"是刚需。折中做法：
**主进程持有目录，插件只按文件句柄收发内容**。

| 通道 | 行为 |
|---|---|
| `plugin:docs.list` | 列出 `data/<pluginId>/docs/` 下的 md/markdown/txt |
| `plugin:docs.import` | 弹系统文件框（可多选），拷贝进该目录，重名自动 `-2` |
| `plugin:docs.read` | 读文本，UTF-8 优先、出现替换字符回退 GBK；上限 4MB |
| `plugin:docs.remove` | 删除（句柄必须是纯文件名，挡 `../` 与绝对路径） |
| `plugin:docs.reveal` | 在资源管理器打开目录；不把路径回传给插件 |

五个通道都映射到 `docs` 权限，未声明的插件调用即拒绝。

内置手册插件（`plugins/handbook`）只把这套 API 用于"用户导入的文档"；随插件发布的
手册正文走构建期打包（`.md` 经 vite `?raw` 进 bundle），因为插件页在 `file://` 下
运行时 fetch 本地文件会被 CORS 拦掉，且手册包要能离线。

## 插件宿主行为

- 进入插件：面板窗口 `contentView.addChildView(view)`，插件页**嵌在启动器提供的外框里**（顶部 46px 工具条 + 四周 8px 留白），不再铺满整窗；退出后视图**保留在缓存**，重进恢复原状态。
- 外框由面板渲染层画（`PluginFrame.vue`），提供"返回主界面 / 独立窗口 / 关闭"；`src/shared/pluginFrame.ts` 是主进程算视图矩形与渲染层排版的唯一尺寸来源，改尺寸只改这里。
- 进插件时面板自动伸展（默认 ≥980×720，上限工作区 94%，只放大不缩小），退出时还原主页尺寸；插件页里调过的尺寸记进 `config.pluginBounds`，下次进插件沿用。
- 窗口 resize 时按 `pluginViewRect()` 同步视图 bounds；视图带白底与 10px 圆角，边缘留白同时是自实现缩放热区的作用带（视图贴着窗口边界时热区收不到指针事件）。
- 面板唤起（快捷键/二次启动）自动回到主页；Esc 在插件内 → `appapi.exit()`。

## 数据与配置

```
<userData>/                       %APPDATA%/quick-launcher/
├─ config.json                    全局配置（hotkey/autostart/pinnedIds）
├─ data/<pluginId>/store.json     各插件独立数据
├─ data/<pluginId>/docs/          各插件文档库（documents API，手动拖文件也可）
```

## 构建

```bash
pnpm dev          # 构建内置插件后启动开发模式
pnpm build        # electron-vite 构建 main/preload/renderer
pnpm build:plugins
pnpm dist         # 插件收集 → 构建 → electron-builder 出 Windows 安装包（release/<version>/）
node scripts/gen-icons.mjs   # 重新生成 build/icon.ico 与托盘图标
```

## 已知边界（后续路线）

- 插件市场（在线列表/下载/安装）未实现；`plugins/installed/` 目录已预留（在 `getPluginRoots()` 加一行即可）
- 插件视图数量无上限缓存（建议后续加 LRU 上限）
- 开机自启仅在打包版生效（`applyAutostart` 判断 `app.isPackaged`）
