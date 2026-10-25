import { contextBridge, ipcRenderer } from 'electron'

const invoke = (channel: string, payload?: unknown) => ipcRenderer.invoke(channel, payload)

// plugin:query 可能在插件页 onMounted 注册回调之前到达（页面加载完成即推送），
// 这里先缓冲，onQuery 注册时一次性补发，保证查询不丢。
interface QueryPayload {
  query?: string
}
let queryHandler: ((payload: QueryPayload) => void) | null = null
const pendingQueries: QueryPayload[] = []
ipcRenderer.on('plugin:query', (_event, payload: QueryPayload) => {
  if (queryHandler) queryHandler(payload)
  else pendingQueries.push(payload)
})

function subscribe<T = unknown>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: unknown) => callback(payload as T)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

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
 * 主进程网关会校验调用方身份与 plugin.json 声明的权限。
 */
contextBridge.exposeInMainWorld('appapi', {
  info: () => invoke('plugin:info'),
  onQuery: (callback: (payload: QueryPayload) => void) => {
    queryHandler = callback
    while (pendingQueries.length) callback(pendingQueries.shift()!)
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
  window: {
    hide: () => invoke('plugin:window.hide'),
    /** 把当前插件分离为独立窗口（状态保留，任务栏可见） */
    detach: () => invoke('plugin:window.detach')
  },
  exit: () => invoke('plugin:exit')
})
