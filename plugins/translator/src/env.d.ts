/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

interface QueryPayload {
  query?: string
}

interface TranslatorApi {
  onQuery(callback: (payload: QueryPayload) => void): void
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<boolean>
  }
  clipboard: {
    readText(): Promise<string>
    writeText(text: string): Promise<boolean>
  }
  exit(): Promise<boolean>
}

interface Window {
  appapi: TranslatorApi
}
