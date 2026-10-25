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

### 关键词高级匹配（v0.2.0 起）

除普通子串匹配外，`keywords` 支持：

```jsonc
"keywords": [
  "翻译",                              // 子串：query 包含"翻译"即命中
  "calc*",                             // 通配符：* 任意串、? 单字符，与整个查询词匹配
  "re:^[a-zA-Z][a-zA-Z0-9@._\\- ]{1,120}$"  // 正则：re: 前缀，对整个查询词 test
]
```

- 典型场景：翻译类插件加 `re:^[a-zA-Z]...`，用户输入**任意英文**都会命中翻译应用
- 正则非法时静默跳过；请避免灾难性回溯模式（查询词很短，风险可控但仍是好习惯）

### 接收面板搜索词（v0.2.0 起）

打开插件时面板会把当前搜索词传给插件，用于"输入即动作"场景：

```ts
onMounted(() => {
  window.appapi.onQuery(({ query }) => {
    if (query) doSomethingWith(query)   // 如翻译插件直接翻译该词
  })
})
```

把目录放到项目 `plugins/` 下（或其构建产物放进 `my-plugin/dist/`），重启应用即可在面板搜索到。

### 安装到用户目录（不改项目源码）

两种方式把插件装进用户目录 `%APPDATA%/quick-launcher/plugins/installed/`：

1. **手动投放**：把含 `plugin.json` 的目录（或其 `dist/`）放进去，重启应用即生效
2. **面板安装**：全部应用页 → "从目录安装" / "从 ZIP 安装"（zip 内支持根目录或 `dist/plugin.json`，安装时会做 manifest 校验、失败回滚；zip 解包过滤路径穿越与 node_modules）

安装后的插件可在 设置 → 插件管理 中停用/启用/卸载/打开目录；内置插件只能停用不能卸载。

## 插件 API（window.appapi）

所有调用经过主进程网关：先校验调用方身份，再校验 `plugin.json` 里声明的权限，未声明会直接 reject。

```ts
// 信息
await appapi.info()                        // { id, name, version, permissions }

// 面板搜索词（无需权限；onQuery 注册前的到达事件会被 preload 缓冲补发）
appapi.onQuery(({ query }) => { /* query 为打开插件时的搜索词，可能为 undefined */ })

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
| `webview` | 在插件页使用 `<webview>` 嵌入第三方网页（v0.2.1 起） |

`window.hide` / `exit` / `info` / `onQuery` 不需要权限。

### 嵌入第三方网页（webview）

声明 `webview` 权限后，插件页可直接使用 Electron 的 `<webview>` 标签内嵌任意网站
（官方翻译页、文档站等）。它不受 X-Frame-Options 限制（独立 guest 进程），
主进程会在 `will-attach-webview` 里校验权限并强制 guest 沙箱。
Vue 插件需在 vite 配置声明自定义元素：

```ts
vue({ compilerOptions: { isCustomElement: (tag) => tag === 'webview' } })
```

参考 `plugins/translator/`（多翻译引擎 + `{q}` URL 模板 + 懒创建 webview 保留状态）。

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
