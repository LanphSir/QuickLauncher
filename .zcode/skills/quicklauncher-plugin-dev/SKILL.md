---
name: quicklauncher-plugin-dev
description: QuickLauncher（本仓库）插件开发全流程规范：创建新的内置 web 插件或 external 外部程序集成插件、修改/调试现有插件、使用 window.appapi、处理插件不被扫描/权限被拒/崩溃隔离等问题。只要用户要求"给启动器/面板加一个 XX 应用/功能/工具"、"集成 XX 外部程序"、动 plugins/ 目录或 plugin.json，即使没出现"插件"二字也必须使用本 skill。
---

# QuickLauncher 插件开发

本 skill 让你在 QuickLauncher 仓库里正确地开发插件：不破坏五层隔离架构、
通过 manifest 校验、正确声明权限、并完成构建注册。插件分两种：

- **web 型**：自设计的 HTML 页面应用（可与主面板同栈 Vue 3，也可纯 HTML/JS）
- **external 型**：零代码，一个 manifest 把任意 exe / 文件夹 / 网址接入面板

选型判断：需要界面和交互 → web 型；只是"拉起某个程序/网站" → external 型。

## 工作流

### 1. 脚手架

```bash
node .zcode/skills/quicklauncher-plugin-dev/scripts/scaffold.mjs <目录名> --name "显示名" [--keywords "a,b"] [--perms "storage,clipboard"] [--external "notepad.exe 或 https://..."]
```

脚本会生成完整骨架（web 型含 package.json / vite.config / index.html / public/plugin.json / icon.svg / src/App.vue），
并打印后续步骤。已有目录会被拒绝（加 `--force` 覆盖）。**写逻辑之前先跑它。**

### 2. 理解 manifest（校验失败 = 插件不被加载）

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✓ | 反向域名 `com.launcher.<name>`，正则 `/^[\w.-]+$/`，全库唯一 |
| `name` | ✓ | 面板显示名（中文） |
| `type` | ✓ | `web` 或 `external` |
| `entry` | web 型 | 入口 html，**相对插件目录**（构建后即相对 dist） |
| `command` | external 型 | exe 路径/命令（走 PATH）或 http(s) URL；`args` 数组可选 |
| `keywords` | 建议 | 面板搜索关键词（中英都放） |
| `permissions` | 建议 | 申请的 API 权限，见下方权限表 |

图标：目录（或 dist）内 `icon.svg` / `icon.png` / `icon.ico` 任一，由主进程转 dataURL 下发。
扫描位置：`plugins/<name>/dist/plugin.json`（web 型）或 `plugins/<name>/plugin.json`（external 型）。

### 3. 使用插件 API

插件运行在沙箱渲染进程（无 Node 能力），一切系统能力通过 `window.appapi`，
且**必须**在 manifest `permissions` 里声明对应权限，否则网关拒绝（错误信息会提示补哪个权限）：

```ts
await appapi.storage.set('key', value)     // 权限 storage —— 按插件 id 强制隔离
await appapi.clipboard.writeText('hello')  // 权限 clipboard
await appapi.notify('标题', '内容')          // 权限 notify
await appapi.shell.openExternal(url)       // 权限 shell，仅 http(s)
await appapi.exit()                        // 无需权限 —— 退出插件返回面板
await appapi.window.hide()                 // 无需权限 —— 隐藏整个面板
```

完整签名、生命周期（视图缓存/恢复状态）、示例代码见 `references/api.md`。
**约定**：插件页自己监听 `keydown`，Esc 调 `appapi.exit()` 返回面板——所有内置插件都遵守。

### 4. 构建与注册

- vite 配置必须 `base: './'`（file:// 协议下相对路径才能加载资源），manifest 和 icon 放 `public/`
- 构建进 `dist/`：`pnpm build:plugins`（dev 模式不会热更新插件，改完必须重跑）
- external 型无需构建，目录里直接放 `plugin.json` + icon

### 5. 验证清单（完成前逐条过）

1. `pnpm typecheck` 零错误
2. `pnpm build:plugins` 成功，`plugins/<name>/dist/plugin.json` 存在
3. 启动应用，控制台出现 `[plugin] 已加载 N 个插件` 且 N 包含你的
4. 面板搜索 `keywords` 能命中；回车进入插件；Esc 返回
5. 若用了权限 API：故意删掉一个权限声明，确认网关拒绝（证明走的是网关）——测完恢复
6. 若改了插件系统本体（gateway/host/manager）：跑 `pnpm smoke`

## 铁律（违反 = 破坏互不干扰架构）

1. 不给插件宿主开 `nodeIntegration` / 关 `sandbox` / 关 `contextIsolation`
2. 插件需要的任何新系统能力：`preload/plugin.ts` 暴露 → `plugin/gateway.ts` 注册通道 + `PERMS` 加权限 → manifest 声明。三步缺一不可
3. 不在插件间提供任何直接通信/共享存储
4. 插件代码不 `eval` 用户不可信输入（计算器插件有现成的表达式解析器可抄）

## 常见坑

| 现象 | 原因/解法 |
|---|---|
| 面板搜不到插件 | manifest 校验失败（看主进程控制台 `[plugin] 跳过 ...`）：常见是缺 entry、entry 文件不存在、id 含非法字符 |
| 页面白屏、资源 404 | vite 忘了 `base: './'`，或用绝对路径引用了资源 |
| 调用 API 报"缺少权限" | manifest `permissions` 没声明，加上后**重新 build** |
| 改了插件没变化 | dev 不热更插件，先 `pnpm build:plugins`；旧视图有缓存，Esc 重进即可 |
| 图标不显示 | icon 不在插件目录/dist 根部，或扩展名不在 svg/png/ico 列表 |
| dev 与打包版配置串了 | 两者共用 `%APPDATA%/quick-launcher`，必要时清掉 |
