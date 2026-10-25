# 插件开发指南

QuickLauncher 插件分两种：**web 型**（自设计的 HTML 页面应用）和 **external 型**（拉起任意外部程序）。

## 快速开始：最小 web 插件

```
my-plugin/
├─ plugin.json
├─ icon.svg          可选，支持 icon.svg / icon.png / icon.ico
└─ index.html        入口（可以是任何能产出静态页面的构建产物）
```

```jsonc
// plugin.json
{
  "id": "com.yourname.my-plugin",   // 全局唯一，建议反向域名
  "name": "我的插件",
  "version": "0.1.0",
  "description": "一句话说明",
  "type": "web",
  "entry": "index.html",
  "keywords": ["demo", "示例"],     // 面板搜索关键词
  "permissions": ["storage", "notify"]
}
```

把目录放到项目 `plugins/` 下（或其构建产物放进 `my-plugin/dist/`），重启应用即可在面板搜索到。

## 插件 API（window.appapi）

所有调用经过主进程网关：先校验调用方身份，再校验 `plugin.json` 里声明的权限，未声明会直接 reject。

```ts
// 信息
await appapi.info()                        // { id, name, version, permissions }

// 存储（按插件 id 强制隔离，key-value，值需可 JSON 序列化）
await appapi.storage.set('todos', [1, 2])
await appapi.storage.get('todos')          // 未声明 storage 权限会被拒绝
await appapi.storage.keys()
await appapi.storage.remove('todos')

// 剪贴板（需要 clipboard 权限）
await appapi.clipboard.readText()
await appapi.clipboard.writeText('hello')

// 系统通知（需要 notify 权限）
await appapi.notify('标题', '内容')

// 打开外部链接（需要 shell 权限，仅 http/https）
await appapi.shell.openExternal('https://example.com')

// 窗口控制（无需权限）
await appapi.window.hide()                 // 隐藏整个面板（等同 Esc）
await appapi.exit()                        // 退出当前插件，返回面板主页
```

约定俗成的交互：**Esc 键调用 `appapi.exit()` 返回面板**，插件页自己监听 keydown 实现。

## 权限一览

| 权限 | 控制的 API |
|---|---|
| `storage` | `appapi.storage.*` |
| `clipboard` | `appapi.clipboard.*` |
| `notify` | `appapi.notify` |
| `shell` | `appapi.shell.openExternal` |

`window.hide` / `exit` / `info` 不需要权限。

## external 型插件：集成外部程序

不需要写任何代码，一个 manifest 即可：

```jsonc
{
  "id": "com.launcher.vscode",
  "name": "VS Code",
  "type": "external",
  "command": "C:/Users/you/AppData/Local/Programs/Microsoft VS Code/Code.exe",
  "args": ["--new-window"],
  "keywords": ["code", "编辑器"],
  "permissions": []
}
```

- `command` 为 http(s) 链接时用默认浏览器打开；否则作为命令拉起（走 PATH 解析，`detached` 启动，不随启动器退出）。
- 面板中回车/点击后：外部程序启动，面板自动隐藏。

## 用 Vue 3 开发（与内置插件一致）

参考 `plugins/clipboard/` 与 `plugins/calculator/`：

- `vite.config.ts` 里 `base: './'`（file:// 协议下相对路径才能加载资源）
- manifest 和图标放 `public/`，构建后自动进入 `dist/`
- 构建产物 `dist/plugin.json` 会被扫描器识别

## 调试建议

- 插件页是普通 Chromium 页面：开发期可以在插件入口代码里临时加 `console.log`，用 `pnpm dev` 启动后通过插件页的上下文查看（后续版本可加 remote debugging 端口）
- 插件崩溃不影响主程序：可在插件里调用 `process.crash?.()` 验证隔离
- 权限被拒会在控制台看到网关的错误信息，检查 `plugin.json` 的 `permissions`

## 安全须知

- 插件运行在沙箱渲染进程，没有 Node 能力；所有系统能力都必须走 `appapi` 并在 manifest 声明
- 安装来路不明的插件 = 信任该插件申请的全部权限（后续市场版本会做权限确认弹窗）
