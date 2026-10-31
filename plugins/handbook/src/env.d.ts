/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

interface QueryPayload {
  query?: string
}

interface DocMeta {
  id: string
  title: string
  size: number
  updatedAt: number
}

interface HandbookApi {
  onQuery(callback: (payload: QueryPayload) => void): void
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<boolean>
    remove(key: string): Promise<boolean>
  }
  clipboard: {
    writeText(text: string): Promise<boolean>
  }
  /** 权限 docs：文档库由主进程代管，插件只拿内容与句柄 */
  docs: {
    list(): Promise<DocMeta[]>
    import(): Promise<{ ok: boolean; added: number; skipped: number; message?: string }>
    read(id: string): Promise<{ ok: boolean; text?: string; message?: string }>
    remove(id: string): Promise<{ ok: boolean; message?: string }>
    reveal(): Promise<{ ok: boolean; message?: string }>
  }
  window: {
    detach(): Promise<{ ok: boolean; message?: string }>
  }
  exit(): Promise<boolean>
}

interface Window {
  appapi: HandbookApi
}
