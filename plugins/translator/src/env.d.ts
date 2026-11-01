/// <reference types="vite/client" />
/// <reference path="../../../src/shared/appapi.global.d.ts" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}
