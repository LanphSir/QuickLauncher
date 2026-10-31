import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: './',
  plugins: [vue()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 手册正文以 `?raw` 打进主 chunk（file:// 下不能 code-split 拉取），体积天然偏大
    chunkSizeWarningLimit: 2000
  }
})
