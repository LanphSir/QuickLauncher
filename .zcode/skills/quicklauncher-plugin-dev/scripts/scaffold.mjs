#!/usr/bin/env node
// QuickLauncher 插件脚手架
// 用法（在项目根目录执行）:
//   node .zcode/skills/quicklauncher-plugin-dev/scripts/scaffold.mjs <目录名> [选项]
// 选项:
//   --name "显示名"        面板显示名（默认用目录名）
//   --keywords "a,b,c"     搜索关键词（默认 [显示名]）
//   --perms "storage,...   web 型默认 ["storage"]
//   --external "cmd"       创建 external 型插件（cmd 为命令/URL）；缺省创建 web 型
//   --force                目标目录已存在时覆盖
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const name = args[0]
if (!name || name.startsWith('--')) {
  console.error('用法: node scaffold.mjs <目录名> [--name "显示名"] [--keywords "a,b"] [--perms "storage"] [--external "cmd"] [--force]')
  process.exit(1)
}
if (!/^[\w-]+$/.test(name)) {
  console.error(`目录名非法: ${name}（只允许字母数字下划线连字符）`)
  process.exit(1)
}

const opt = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}
const displayName = opt('--name') ?? name
const keywords = (opt('--keywords') ?? displayName).split(',').map((s) => s.trim()).filter(Boolean)
const externalCmd = opt('--external')
const perms = (opt('--perms') ?? (externalCmd ? '' : 'storage')).split(',').map((s) => s.trim()).filter(Boolean)
const force = args.includes('--force')

const dir = join(process.cwd(), 'plugins', name)
const id = `com.launcher.${name}`
if (!/^[\w.-]+$/.test(id)) {
  console.error(`生成的 id 非法: ${id}`)
  process.exit(1)
}
if (existsSync(dir) && !force) {
  console.error(`目录已存在: ${dir}（加 --force 覆盖）`)
  process.exit(1)
}
mkdirSync(dir, { recursive: true })

const write = (rel, content) => {
  const file = join(dir, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content, 'utf-8')
  console.log(`  + ${rel}`)
}

console.log(`创建插件 ${name}（${externalCmd ? 'external' : 'web'} 型）→ plugins/${name}`)

write('plugin.json', JSON.stringify({
  id,
  name: displayName,
  version: '0.1.0',
  description: `${displayName}（scaffold 生成，请补充描述）`,
  type: externalCmd ? 'external' : 'web',
  ...(externalCmd ? { command: externalCmd, args: [] } : { entry: 'index.html' }),
  keywords,
  permissions: perms
}, null, 2) + '\n')

write('icon.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect x="4" y="4" width="56" height="56" rx="14" fill="${externalCmd ? '#F59E0B' : '#6366F1'}"/>
  <rect x="20" y="20" width="24" height="24" rx="6" fill="#FFFFFF"/>
</svg>
`)

if (!externalCmd) {
  write('package.json', JSON.stringify({
    name: `@launcher/plugin-${name}`,
    version: '0.1.0',
    private: true,
    description: `${displayName}（QuickLauncher 内置插件）`,
    scripts: { build: 'vite build' },
    devDependencies: { '@vitejs/plugin-vue': '^6.0.0', vite: '^7.1.0' },
    dependencies: { vue: '^3.5.0' }
  }, null, 2) + '\n')

  write('vite.config.ts', `import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: './',
  plugins: [vue()],
  build: { outDir: 'dist', emptyOutDir: true }
})
`)

  write('index.html', `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${displayName}</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`)

  write('src/main.ts', `import { createApp } from 'vue'
import App from './App.vue'

createApp(App).mount('#app')
`)

  write('src/env.d.ts', `/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}
`)

  write('src/App.vue', `<script setup lang="ts">
function exit(): void {
  void window.appapi.exit()
}
</script>

<template>
  <div class="page">
    <header>
      <button class="ghost" @click="exit"><span class="arrow">‹</span> 返回</button>
      <h1>${displayName}</h1>
      <span class="spacer" />
    </header>
    <p class="tip">插件骨架已就绪，替换成你的功能 · Esc 返回面板</p>
  </div>
</template>

<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body, #app { height: 100%; }
body {
  font-family: 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
  color: #1f2329; background: #fff; user-select: none;
}
.page { height: 100%; display: flex; flex-direction: column; padding: 14px 18px; }
header { display: flex; align-items: center; gap: 10px; }
h1 { flex: 1; text-align: center; font-size: 15px; font-weight: 600; }
.spacer { width: 52px; }
.ghost {
  font-size: 13px; color: #646a73; padding: 5px 10px;
  border-radius: 8px; border: none; background: none; cursor: pointer;
}
.ghost:hover { background: #f2f3f5; color: #1f2329; }
.arrow { font-size: 15px; }
.tip { text-align: center; font-size: 12px; color: #a1a6ad; margin-top: 40px; }
</style>
`)
}

const steps = externalCmd
  ? [
      `1. pnpm dev 后按 Alt+Space，搜索 "${keywords[0]}" 验证`,
      '2. 验证清单见 .zcode/skills/quicklauncher-plugin-dev/SKILL.md 第 5 节'
    ]
  : [
      '1. pnpm install（若未安装过依赖）',
      '2. pnpm build:plugins',
      `3. pnpm dev 后按 Alt+Space，搜索 "${keywords[0]}" 验证`,
      '4. 验证清单见 .zcode/skills/quicklauncher-plugin-dev/SKILL.md 第 5 节'
    ]
console.log(`\n完成。后续步骤:\n  ${steps.join('\n  ')}\n`)
