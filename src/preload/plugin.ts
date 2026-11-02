import { contextBridge, ipcRenderer } from 'electron'
import {
  AI_DELTA_CHANNEL,
  type InlineQuery,
  type PluginApiSurface,
  type PluginApiTypes,
  type PluginChannel,
  type PluginQueryPayload
} from '../shared/pluginApi'
import type { AiStreamEvent } from '../shared/ai'

/** 通道与入参/返回值都由 shared/pluginApi 的契约约束，桥这一层不再手写类型 */
function invoke<C extends PluginChannel>(
  channel: C,
  payload?: PluginApiTypes[C]['req']
): Promise<PluginApiTypes[C]['res']> {
  return ipcRenderer.invoke(channel, payload)
}

// plugin:query 可能在插件页 onMounted 注册回调之前到达（页面加载完成即推送），
// 这里先缓冲，onQuery 注册时一次性补发，保证查询不丢。
let queryHandler: ((payload: PluginQueryPayload) => void) | null = null
const pendingQueries: PluginQueryPayload[] = []
ipcRenderer.on('plugin:query', (_event, payload: PluginQueryPayload) => {
  if (queryHandler) queryHandler(payload)
  else pendingQueries.push(payload)
})

/**
 * 可见性状态：视图是懒创建的，页面加载完就是可见状态。
 * 主进程只在"真正变化"时推送（重复 show 不会触发），preload 这里再挡一层重复。
 */
let visible = true
const showHandlers = new Set<() => void>()
const hideHandlers = new Set<() => void>()
const destroyHandlers = new Set<() => void>()
ipcRenderer.on('plugin:lifecycle', (_event, payload: { state?: string }) => {
  // destroy 优先：视图马上要被回收，先让插件收尾，后面不再补 show/hide
  if (payload?.state === 'destroy') {
    visible = false
    for (const cb of destroyHandlers) {
      try {
        cb()
      } catch (err) {
        console.error('[appapi] onDestroy 回调异常', err)
      }
    }
    return
  }
  const next = payload?.state !== 'hide'
  if (next === visible) return
  visible = next
  for (const cb of next ? showHandlers : hideHandlers) cb()
})

/**
 * 内联查询：只缓冲最新一条。这类请求有时效性，注册回调时补发一堆过期查询
 * 既没用也会让插件重复计算，不如只认最后一条。
 */
let inlineHandler: ((payload: InlineQuery) => void) | null = null
let pendingInline: InlineQuery | null = null
ipcRenderer.on('plugin:inline-query', (_event, payload: InlineQuery) => {
  if (inlineHandler) inlineHandler(payload)
  else pendingInline = payload
})

/**
 * AI 流式增量：与内联查询不同，这里不能"只留最后一条"——每个 token 都要拼进消息。
 * 但缓冲要封顶：页面还没注册回调时来了上万条事件，攒着也没用（那多半是上一个
 * 会话的残流），超过 500 条丢最旧的。
 */
let aiDeltaHandler: ((event: AiStreamEvent) => void) | null = null
const pendingAiDeltas: AiStreamEvent[] = []
ipcRenderer.on(AI_DELTA_CHANNEL, (_event, payload: AiStreamEvent) => {
  if (!payload || typeof payload !== 'object') return
  if (aiDeltaHandler) aiDeltaHandler(payload)
  else {
    pendingAiDeltas.push(payload)
    if (pendingAiDeltas.length > 500) pendingAiDeltas.shift()
  }
})

/**
 * 二次保险：桥传参（contextBridge）已要求纯数据，这里再防一次
 * 插件侧漏传的可克隆性存疑值。注意：Proxy 在桥传参时就会被拒，
 * 插件必须在调用前自行转纯数据（见插件开发指南）。
 */
function plain<T>(value: T): T {
  try {
    return structuredClone(value)
  } catch {
    return JSON.parse(JSON.stringify(value ?? null))
  }
}

/**
 * 插件可用的受控 API（window.appapi）。
 * 标注成 PluginApiSurface：实现与插件侧类型由同一个来源约束，少一个方法就编译不过。
 */
const api: PluginApiSurface = {
  info: () => invoke('plugin:info'),
  onQuery: (callback: (payload: PluginQueryPayload) => void) => {
    queryHandler = callback
    while (pendingQueries.length) callback(pendingQueries.shift()!)
  },
  onShow: (callback: () => void) => {
    showHandlers.add(callback)
    // 注册时页面已经可见：立刻回调一次，插件可以把"启动轮询"直接写在这里
    if (visible) callback()
  },
  onHide: (callback: () => void) => {
    hideHandlers.add(callback)
  },
  onDestroy: (callback: () => void) => {
    destroyHandlers.add(callback)
  },
  onInlineQuery: (callback: (payload: InlineQuery) => void) => {
    inlineHandler = callback
    if (pendingInline) {
      const payload = pendingInline
      pendingInline = null
      callback(payload)
    }
  },
  storage: {
    get: (key: string) => invoke('plugin:storage.get', key),
    set: (key: string, value: unknown) => invoke('plugin:storage.set', { key, value: plain(value) }),
    remove: (key: string) => invoke('plugin:storage.remove', key),
    keys: () => invoke('plugin:storage.keys')
  },
  clipboard: {
    readText: () => invoke('plugin:clipboard.readText'),
    writeText: (text: string) => invoke('plugin:clipboard.writeText', text)
  },
  notify: (title: string, body?: string) => invoke('plugin:notify', { title, body }),
  shell: {
    openExternal: (url: string) => invoke('plugin:shell.openExternal', url)
  },
  docs: {
    list: () => invoke('plugin:docs.list'),
    import: () => invoke('plugin:docs.import'),
    read: (id: string) => invoke('plugin:docs.read', id),
    remove: (id: string) => invoke('plugin:docs.remove', id),
    reveal: () => invoke('plugin:docs.reveal')
  },
  search: {
    set: (entries: unknown) => invoke('plugin:search.set', plain(entries)),
    clear: () => invoke('plugin:search.clear')
  },
  net: {
    request: (request) => invoke('plugin:net.request', plain(request))
  },
  inline: {
    set: (reply) => invoke('plugin:inline.set', plain(reply))
  },
  ai: {
    onDelta: (callback: (event: AiStreamEvent) => void) => {
      aiDeltaHandler = callback
      while (pendingAiDeltas.length) callback(pendingAiDeltas.shift()!)
    },
    send: (request) => invoke('plugin:ai.chat.send', plain(request)),
    stop: (sessionId: string) => invoke('plugin:ai.chat.stop', { sessionId }),
    models: () => invoke('plugin:ai.models'),
    sessions: {
      list: () => invoke('plugin:ai.session.list'),
      get: (id: string) => invoke('plugin:ai.session.get', id),
      create: (model?: string) => invoke('plugin:ai.session.create', { model }),
      rename: (id: string, title: string) => invoke('plugin:ai.session.rename', { id, title }),
      remove: (id: string) => invoke('plugin:ai.session.delete', id)
    }
  },
  window: {
    hide: () => invoke('plugin:window.hide'),
    detach: () => invoke('plugin:window.detach')
  },
  exit: () => invoke('plugin:exit')
}

contextBridge.exposeInMainWorld('appapi', api)
