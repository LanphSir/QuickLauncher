#!/usr/bin/env node
// QuickLauncher 插件脚手架
// 用法（在项目根目录执行）:
//   node skills/quicklauncher-plugin-dev/scripts/scaffold.mjs <目录名> [选项]
// 选项:
//   --name "显示名"        面板显示名（默认用目录名）
//   --keywords "a,b,c"     搜索关键词（默认 [显示名]）
//   --perms "storage,...   web 型默认 ["storage"]
//   --ai                    额外生成 public/ai/{tools.json,SKILL.md} 并打开 ai 权限（仅 web 型）
//   --external "cmd"       创建 external 型插件（cmd 为命令/URL）；缺省创建 web 型
//   --force                目标目录已存在时覆盖
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const name = args[0]
if (!name || name.startsWith('--')) {
  console.error('用法: node scaffold.mjs <目录名> [--name "显示名"] [--keywords "a,b"] [--perms "storage"] [--ai] [--external "cmd"] [--force]')
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
const force = args.includes('--force')
const wantAi = args.includes('--ai')

if (wantAi && externalCmd) {
  // external 型没有页面，主进程发的工具调用没有地方回执，只会一路超时
  console.error('--ai 只能用于 web 型插件：external 型没有页面能接住工具调用')
  process.exit(1)
}

const basePerms = (opt('--perms') ?? (externalCmd ? '' : 'storage')).split(',').map((s) => s.trim()).filter(Boolean)
const perms = wantAi && !basePerms.includes('ai') ? [...basePerms, 'ai'] : basePerms

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

console.log(`创建插件 ${name}（${externalCmd ? 'external' : 'web'} 型${wantAi ? ' + AI 工具' : ''}）→ plugins/${name}`)

// web 型的 manifest 与图标必须放 public/（构建后进 dist/）；放根目录会让扫描器
// 命中源码目录里的 plugin.json，入口指向未被 vite 处理的 index.html → 白屏。
const assetDir = externalCmd ? '' : 'public/'

// 工具名只允许小写字母开头 + a-z0-9_，目录名可能带连字符，转一下
const toolName = name.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z]+/, '') || 'run'

write(`${assetDir}plugin.json`, JSON.stringify({
  id,
  name: displayName,
  version: '0.1.0',
  description: `${displayName}（scaffold 生成，请补充描述）`,
  type: externalCmd ? 'external' : 'web',
  ...(externalCmd ? { command: externalCmd, args: [] } : { entry: 'index.html', apiVersion: 2 }),
  keywords,
  permissions: perms,
  ...(wantAi ? { ai: { tools: 'ai/tools.json', skill: 'ai/SKILL.md' } } : {})
}, null, 2) + '\n')

write(`${assetDir}icon.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect x="4" y="4" width="56" height="56" rx="14" fill="${externalCmd ? '#F59E0B' : '#6366F1'}"/>
  <rect x="20" y="20" width="24" height="24" rx="6" fill="#FFFFFF"/>
</svg>
`)

if (wantAi) {
  write(`${assetDir}ai/tools.json`, JSON.stringify({
    version: 1,
    tools: [
      {
        name: toolName,
        title: displayName,
        // 模型靠这句话决定要不要调用，写清「什么场景用 + 返回什么」，别写「执行操作」
        description: `（占位）${displayName}的能力说明：什么情况下该调用它、返回什么样的结果。`,
        risk: 'read', // read 自动放行 / write 每次确认 / dangerous 每次确认且不可记住
        timeoutMs: 5000,
        parameters: {
          type: 'object',
          properties: { text: { type: 'string', description: '参数说明' } },
          required: []
        }
      }
    ]
  }, null, 2) + '\n')

  write(`${assetDir}ai/SKILL.md`, `---
name: ${displayName}
description: （一句话：什么时候该用这个插件，用户提到哪些词时考虑它）
---

# 用法

（详细规则、示例、注意事项。只有上面的 name/description 会常驻上下文，正文由模型按需读取。）
`)
}

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
// 与主面板共用同一份设计令牌 + reset：漏掉它，body 的 8px margin 会让滚动条常驻
import '../../../src/shared/theme.css'
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
import { onMounted, onUnmounted } from 'vue'

function exit(): void {
  void window.appapi.exit()
}

// 约定：Esc 返回面板。视图退出后只是被摘掉（不销毁），所以卸载时要摘监听
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') exit()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="page">
    <header>
      <button class="ghost" @click="exit"><span class="arrow">‹</span> 返回</button>
      <h1>${displayName}</h1>
      <span class="spacer" />
    </header>
    <p class="tip">骨架已就绪，替换成你的功能 · Esc 返回面板</p>
  </div>
</template>

<style>
/* 颜色/圆角/阴影一律取 src/shared/theme.css 的令牌，不要写字面量色值 */
.page { height: 100%; display: flex; flex-direction: column; padding: 14px 18px; }
header { display: flex; align-items: center; gap: 10px; }
h1 { flex: 1; text-align: center; font-size: 15px; font-weight: 600; color: var(--text-1); }
.spacer { width: 52px; }
.ghost {
  font-size: 13px; color: var(--text-2); padding: 5px 10px;
  border-radius: var(--r-sm); background: none; cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.ghost:hover { background: var(--bg-hover); color: var(--text-1); }
.arrow { font-size: 15px; }
.tip { text-align: center; font-size: 12px; color: var(--text-3); margin-top: 40px; }
</style>
`)
}

const steps = externalCmd
  ? [
      `1. pnpm dev 后按快捷键唤出面板，搜索 "${keywords[0]}" 验证`,
      '2. 验证清单见 skills/quicklauncher-plugin-dev/SKILL.md 第 7 节'
    ]
  : [
      '1. pnpm install（若未安装过依赖）',
      '2. pnpm build:plugins',
      `3. pnpm dev 后按快捷键唤出面板，搜索 "${keywords[0]}" 验证`,
      '4. 验证清单见 skills/quicklauncher-plugin-dev/SKILL.md 第 7 节',
      ...(wantAi
        ? [
            '5. AI 工具：补好 public/ai/tools.json 的 description 与 public/ai/SKILL.md，',
            '   在插件页注册 appapi.ai.onToolCall，再到 设置 → AI → AI 工具 打开开关（默认关闭）'
          ]
        : [])
    ]
console.log(`\n完成。后续步骤:\n  ${steps.join('\n  ')}\n`)
