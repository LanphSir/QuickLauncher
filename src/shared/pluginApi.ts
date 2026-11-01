/**
 * 插件能力契约：主进程、preload、渲染层、插件共用同一份定义。
 *
 * 为什么集中在这一个文件：以前加一个 API 要改 4 处（gateway 通道 + PERMS 表 +
 * preload 暴露 + 每个插件的 env.d.ts），漏一处就出现"注册了通道忘了挂权限"或
 * "类型对不上实现"的漂移。现在通道、权限、入参/返回值只在这里声明一次：
 *
 * - 主进程：`src/main/plugin/api/*` 用 defineApi 逐个实现，类型由本表约束；
 * - 网关：权限直接从 PLUGIN_PERMS 取，不再手写第二份映射；
 * - preload：实现受 PluginApiSurface 约束，invoke 走泛型；
 * - 插件：`src/shared/appapi.global.d.ts` 把 PluginApiSurface 挂到 window.appapi。
 *
 * 本文件必须保持"纯数据与类型"：不 import electron / node，四端都能安全引入。
 */

/** 插件可申请的权限；未声明的通道（窗口控制/退出/自述）不需要权限 */
export const PLUGIN_PERMISSIONS = [
  'storage',
  'clipboard',
  'notify',
  'shell',
  'docs',
  'search',
  'webview',
  /** 由主进程转发 HTTP 请求；实际可访问的域由 manifest 的 hosts 再限一层 */
  'net'
] as const

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number]

/**
 * 可选功能声明（manifest `features`）。与 permissions 的区别：
 * 权限是「能调哪些系统能力」，功能是「以哪种形态参与启动器」。
 */
export const PLUGIN_FEATURES = [
  /** 内联结果：面板每敲一次键就把查询推给插件，插件回几条结果直接显示在搜索框下方 */
  'inline'
] as const

export type PluginFeature = (typeof PLUGIN_FEATURES)[number]

export interface PluginInfo {
  id: string
  name: string
  version?: string
  permissions: PluginPermission[]
}

/** 打开插件时透传的上下文（appapi.onQuery 接收） */
export interface PluginQueryPayload {
  /** 面板当前搜索词，可能为 undefined */
  query?: string
  /** 搜索条目携带的意图，结构由插件自己约定 */
  intent?: Record<string, unknown>
}

export interface DocMeta {
  /** 文件名（已安全化），即 read/remove 的句柄 */
  id: string
  title: string
  size: number
  updatedAt: number
}

export interface DocImportResult {
  ok: boolean
  added: number
  skipped: number
  message?: string
}

export interface DocReadResult {
  ok: boolean
  text?: string
  message?: string
}

export interface SimpleResult {
  ok: boolean
  message?: string
}

/**
 * 插件发起的 HTTP 请求。走主进程转发，因此不受插件页 CORS 限制；
 * 但只能访问 manifest `hosts` 里声明的域（逐跳校验重定向）。
 */
export interface NetRequest {
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  headers?: Record<string, string>
  /** 请求体（文本/JSON 字符串），上限 2MB */
  body?: string
  /** 超时毫秒，默认 15000，上限 60000 */
  timeoutMs?: number
}

export interface NetResponse {
  ok: boolean
  status: number
  headers: Record<string, string>
  /** 响应文本（UTF-8 解码），上限 4MB */
  body: string
  /** 响应体超过上限被截断 */
  truncated?: boolean
  /** 跟随重定向后的最终地址 */
  url?: string
}

/**
 * 插件页生命周期：
 * - show / hide：可见性变化（切走、面板收起、分离窗口最小化）
 * - destroy：视图即将被回收（长时间未用、内存紧张时被 LRU 淘汰），页面在数百毫秒后关闭
 */
export type PluginLifecycleState = 'show' | 'hide' | 'destroy'

/** 内联结果上按回车做什么；省略时按 open 处理（打开插件继续操作） */
export type InlineAction =
  /** 复制给定文本到剪贴板（面板保持打开，便于连续取用） */
  | { type: 'copy'; text: string }
  /** 打开插件并把 intent 透传过去（appapi.onQuery 收到） */
  | { type: 'open'; intent?: Record<string, unknown> }

/** 内联结果条目：显示在面板搜索结果最上方的一行 */
export interface InlineItem {
  id: string
  /** 主文本（计算结果、换算值等），第一行大字 */
  title: string
  /** 第二行说明，如原始表达式、单位来源 */
  subtitle?: string
  /** 1~2 字符徽标（如 `=` `¥`），缺省用插件图标 */
  badge?: string
  /** 回车动作，缺省 open */
  action?: InlineAction
}

/** 主进程推给内联插件的一次查询 */
export interface InlineQuery {
  /** 递增序号：回结果时必须原样带回，主进程据此丢弃过期响应 */
  seq: number
  query: string
}

export interface InlineReply {
  seq: number
  items: InlineItem[]
}

/**
 * 通道 → 入参/返回值。这是全项目的单一真相源：
 * 主进程实现、preload 桥、渲染层类型都从这里推，不手写第二份。
 */
export interface PluginApiTypes {
  'plugin:info': { req: undefined; res: PluginInfo }

  'plugin:storage.get': { req: string; res: unknown }
  'plugin:storage.set': { req: { key: string; value: unknown }; res: boolean }
  'plugin:storage.remove': { req: string; res: boolean }
  'plugin:storage.keys': { req: undefined; res: string[] }

  'plugin:clipboard.readText': { req: undefined; res: string }
  'plugin:clipboard.writeText': { req: string; res: boolean }

  'plugin:notify': { req: { title?: string; body?: string }; res: boolean }
  'plugin:shell.openExternal': { req: string; res: boolean }

  'plugin:docs.list': { req: undefined; res: DocMeta[] }
  'plugin:docs.import': { req: undefined; res: DocImportResult }
  'plugin:docs.read': { req: string; res: DocReadResult }
  'plugin:docs.remove': { req: string; res: SimpleResult }
  'plugin:docs.reveal': { req: undefined; res: SimpleResult }

  'plugin:search.set': { req: unknown; res: number }
  'plugin:search.clear': { req: undefined; res: boolean }

  'plugin:net.request': { req: NetRequest; res: NetResponse }

  /** 内联结果回传；实际可用性由 manifest 的 features 决定（不是权限） */
  'plugin:inline.set': { req: InlineReply; res: number }

  'plugin:window.hide': { req: undefined; res: boolean }
  'plugin:window.detach': { req: undefined; res: SimpleResult }
  'plugin:exit': { req: undefined; res: boolean }
}

export type PluginChannel = keyof PluginApiTypes

/**
 * 通道所需权限（null = 无需权限）。
 * 网关唯一依据：新增通道必须在此声明，否则注册表编译不过（Record 要求穷尽）。
 */
export const PLUGIN_PERMS: Record<PluginChannel, PluginPermission | null> = {
  'plugin:info': null,
  'plugin:storage.get': 'storage',
  'plugin:storage.set': 'storage',
  'plugin:storage.remove': 'storage',
  'plugin:storage.keys': 'storage',
  'plugin:clipboard.readText': 'clipboard',
  'plugin:clipboard.writeText': 'clipboard',
  'plugin:notify': 'notify',
  'plugin:shell.openExternal': 'shell',
  'plugin:docs.list': 'docs',
  'plugin:docs.import': 'docs',
  'plugin:docs.read': 'docs',
  'plugin:docs.remove': 'docs',
  'plugin:docs.reveal': 'docs',
  'plugin:search.set': 'search',
  'plugin:search.clear': 'search',
  'plugin:net.request': 'net',
  'plugin:inline.set': null,
  'plugin:window.hide': null,
  'plugin:window.detach': null,
  'plugin:exit': null
}

/**
 * window.appapi 的形状。preload 用 `satisfies`/显式标注来保证实现与声明一致，
 * 插件拿到的类型也来自这里——桥与类型不可能再各说一套。
 */
export interface PluginApiSurface {
  info(): Promise<PluginInfo>
  /** 打开插件时推送搜索词/意图；注册前到达的事件会被 preload 缓冲补发 */
  onQuery(callback: (payload: PluginQueryPayload) => void): void
  /**
   * 插件页重新可见（面板切回该插件、分离窗口从最小化/隐藏恢复）。
   * 注册时若页面已可见会立即回调一次，可安全地在这里启动轮询/动画。
   */
  onShow(callback: () => void): void
  /** 插件页被切走（返回主界面、换到别的插件、面板收起）——定时器应在这里暂停 */
  onHide(callback: () => void): void
  /**
   * 视图即将被回收（长期未打开被 LRU 淘汰）：页面还能再活约 400ms，
   * 需要把内存里的草稿落盘就趁现在（`storage.set` 在这个窗口内仍然可用）。
   * 没有注册任何收尾逻辑也没关系——再次打开会重新加载页面。
   */
  onDestroy(callback: () => void): void
  /**
   * 内联查询（需 manifest `features: ["inline"]`）：面板每次输入把查询推来，
   * 插件用 `inline.set({ seq, items })` 回结果，直接显示在搜索结果最上方。
   * 必须在 ~120ms 内回，超时本次查询就只显示其他来源的结果。
   */
  onInlineQuery(callback: (payload: InlineQuery) => void): void

  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<boolean>
    remove(key: string): Promise<boolean>
    keys(): Promise<string[]>
  }

  clipboard: {
    readText(): Promise<string>
    writeText(text: string): Promise<boolean>
  }

  notify(title: string, body?: string): Promise<boolean>

  shell: {
    /** 仅允许 http(s) */
    openExternal(url: string): Promise<boolean>
  }

  docs: {
    list(): Promise<DocMeta[]>
    import(): Promise<DocImportResult>
    read(id: string): Promise<DocReadResult>
    remove(id: string): Promise<SimpleResult>
    reveal(): Promise<SimpleResult>
  }

  search: {
    /** 全量覆盖本插件的可搜条目 */
    set(entries: unknown): Promise<number>
    clear(): Promise<boolean>
  }

  net: {
    /** 主进程转发 HTTP 请求，仅限 manifest `hosts` 声明的域；网络错误/超时会 reject */
    request(request: NetRequest): Promise<NetResponse>
  }

  inline: {
    /** 回传内联查询结果（seq 必须原样带回 query 里的序号），返回实际采纳条数 */
    set(reply: InlineReply): Promise<number>
  }

  window: {
    hide(): Promise<boolean>
    detach(): Promise<SimpleResult>
  }

  exit(): Promise<boolean>
}
