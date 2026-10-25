import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: './',
  plugins: [
    vue({
      // <webview> 是 Electron 内置标签，告诉 Vue 不要当作组件解析
      compilerOptions: { isCustomElement: (tag) => tag === 'webview' }
    })
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
