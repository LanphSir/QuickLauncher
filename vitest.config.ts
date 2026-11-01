import { defineConfig } from 'vitest/config'

/**
 * 单测只跑纯逻辑（校验器、归一化、路径命名、契约表）。
 * 触及 electron / fs 运行时的模块不在这里测——那属于 scripts/smoke.mjs 的活。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: 'dot'
  }
})
