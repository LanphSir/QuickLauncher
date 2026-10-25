# QuickLauncher 插件 API 参考

> 本文档描述 web 型插件在沙箱渲染进程中可用的全部能力（`window.appapi`）。
> 权限校验发生在主进程网关（`src/main/plugin/gateway.ts`），调用方身份由
> webContents.id 锚定，伪造 payload 无效。

## appapi 全量签名

```ts
interface PluginApi {
  info(): Promise<{ id: string; name: string; version?: string; permissions: string[] }>
  /** 打开插件时的面板搜索词；onQuery 注册前到达的事件由 preload 缓冲，注册后补发 */
  onQuery(callback: (payload: { query?: string }) => void): void

  storage: {
    get(key: string): Promise<unknown>          // 无此 key 返回 null
    set(key: string, value: unknown): Promise<boolean>   // value 须可 JSON 序列化
    remove(key: string): Promise<boolean>
    keys(): Promise<string[]>
  }

  clipboard: {
    readText(): Promise<string>
    writeText(text: string): Promise<boolean>
  }

  notify(title: string, body?: string): Promise<boolean>   // 系统通知，title 缺省用插件名

  shell: {
    openExternal(url: string): Promise<boolean> // 仅 http(s)，否则网关抛错
  }

  window: {
    hide(): Promise<boolean>                    // 隐藏整个面板（等同失焦）
  }

  exit(): Promise<boolean>                      // 退出当前插件，回面板主页（视图缓存保留）
}
```

## 权限表

| 权限 | 覆盖 API |
|---|---|
| `storage` | `appapi.storage.*` |
| `clipboard` | `appapi.clipboard.*` |
| `notify` | `appapi.notify` |
| `shell` | `appapi.shell.openExternal` |
| `webview` | 插件页 `<webview>` 嵌入第三方网页（主进程 will-attach-webview 校验，guest 强制沙箱） |
| （无需权限） | `info` / `onQuery` / `window.hide` / `exit` |

权限在 `plugin.json` 的 `permissions` 数组声明，例如 `"permissions": ["storage", "clipboard"]`。

## 生命周期与视图缓存

- 每个插件一个独立 `WebContentsView`（独立渲染进程），首次打开时创建并加载 `entry`。
- **退出插件（exit）不销毁页面**：视图进入缓存，再次打开恢复原状态（输入框内容、滚动位置都在）。
- 面板被再次唤起（快捷键/二次启动）时自动回到主页；插件视图仍在缓存。
- 面板窗口 resize 时插件视图自动跟随全尺寸（MVP 不支持插件自定义窗口大小）。
- 插件渲染进程崩溃：该实例被销毁并从缓存移除，主面板 toast 提示，其余插件不受影响。
- 缓存目前无上限，写插件时避免无限增长的全局状态。

## 数据隔离

storage 落盘在 `%APPDATA%/quick-launcher/data/<pluginId>/store.json`，
插件 id 是主进程根据调用方 webContents 确定的，插件无法读写其他插件的数据，也无法感知路径。

## 关键词高级匹配（manifest.keywords）

- 普通字符串：查询词**包含**该关键词即命中（不区分大小写）
- 通配符：含 `*` / `?` 时与**整个查询词**匹配（`*` 任意串、`?` 单字符）
- 正则：`re:` 前缀，其余部分作为正则对整个查询词 `test`，如 `re:^[a-zA-Z][a-zA-Z0-9@._\- ]{1,120}$`
  让用户输入任意英文都命中（翻译插件即此用法）；非法正则静默跳过

## 范例：接收搜索词 + 翻译（节选自 plugins/translator）

```ts
onMounted(() => {
  // 打开插件时自动翻译面板输入的英文
  window.appapi.onQuery(({ query }) => {
    if (query?.trim()) { input.value = query.trim(); void translate() }
  })
})
```

## 范例：Esc 退出 + 轮询剪贴板（节选自 plugins/clipboard）

```ts
import { onMounted, onUnmounted, ref } from 'vue'

const items = ref<string[]>([])
let last = ''

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  const saved = await window.appapi.storage.get('history')   // 声明了 storage
  if (Array.isArray(saved)) items.value = saved as string[]
  last = await window.appapi.clipboard.readText()            // 声明了 clipboard
  setInterval(async () => {
    const text = await window.appapi.clipboard.readText()
    if (text && text !== last) { last = text; items.value = [text, ...items.value].slice(0, 100) }
  }, 800)
})

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') void window.appapi.exit()
}
```

## manifest 完整字段

```jsonc
{
  "id": "com.launcher.example",        // 必填，/^[\w.-]+$/，全库唯一
  "name": "示例",                       // 必填，面板显示名
  "version": "0.1.0",                  // 可选
  "description": "一句话说明",           // 可选，悬浮提示
  "type": "web",                       // 必填：web | external
  "entry": "index.html",               // web 型必填，相对插件目录（构建后即相对 dist）
  "command": "notepad.exe",            // external 型必填；http(s) 则走默认浏览器
  "args": ["--new-window"],            // external 型可选
  "keywords": ["example", "示例"],      // 建议提供，面板搜索
  "permissions": ["storage"]           // 建议显式声明（即使为空数组）
}
```

校验规则（`src/main/plugin/manager.ts`）：任一必填项缺失或非法 → 打印
`[plugin] 跳过 <dir>: 原因` 并忽略该插件；id 与已有插件冲突 → 后扫到的跳过。
