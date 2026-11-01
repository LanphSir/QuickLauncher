#!/usr/bin/env node
// 插件开发热更新：给单个插件起 vite dev server，并把入口登记到仓库根 .dev-plugins.json。
//
// 用法:
//   pnpm dev:plugin handbook            # 自动挑端口
//   pnpm dev:plugin handbook --port 5273
//
// 主进程（未打包时）会读这个文件，把该插件的入口从 dist/index.html 换成 dev server 地址，
// 于是插件页拿到 vite HMR；启停脚本时主进程还会自动重载已打开的视图。
// 注意：manifest（plugin.json）不参与 HMR，改了要 pnpm build:plugins 并重开插件。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const name = args.find((a) => !a.startsWith('--'))
if (!name) {
  console.error('用法: pnpm dev:plugin <插件目录名> [--port 5273]')
  process.exit(1)
}
const portIdx = args.indexOf('--port')
const port = portIdx >= 0 ? args[portIdx + 1] : ''

const root = process.cwd()
const pluginDir = join(root, 'plugins', name)
const devFile = join(root, '.dev-plugins.json')
const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js')

if (!existsSync(pluginDir)) {
  console.error(`插件目录不存在: plugins/${name}`)
  process.exit(1)
}
if (!existsSync(viteBin)) {
  console.error('未找到 vite，请先在项目根执行 pnpm install')
  process.exit(1)
}

// manifest 取源码那份（public/plugin.json）；external 型没有 vite 工程，走不了热更新
const manifestCandidates = ['public/plugin.json', 'plugin.json', 'dist/plugin.json']
let manifest = null
for (const rel of manifestCandidates) {
  const file = join(pluginDir, rel)
  if (!existsSync(file)) continue
  try {
    manifest = JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    console.error(`manifest 解析失败: ${rel}`)
    process.exit(1)
  }
  break
}
if (!manifest) {
  console.error(`未找到 plugin.json: plugins/${name}/public/plugin.json`)
  process.exit(1)
}
if (manifest.type !== 'web') {
  console.error(`「${manifest.name}」是 ${manifest.type} 型插件，没有渲染进程，无需 dev server`)
  process.exit(1)
}
const id = manifest.id

if (!existsSync(join(pluginDir, 'dist', 'plugin.json'))) {
  console.warn('[dev-plugin] 注意: dist/plugin.json 不存在，扫描器还看不到这个插件；先跑一次 pnpm build:plugins')
}

function updateMap(mutate) {
  let map = {}
  try {
    map = JSON.parse(readFileSync(devFile, 'utf-8'))
  } catch {
    /* 首次运行或文件损坏：重建，不影响其他插件的登记 */
  }
  mutate(map)
  writeFileSync(devFile, `${JSON.stringify(map, null, 2)}\n`, 'utf-8')
}

const child = spawn(process.execPath, [viteBin, ...(port ? ['--port', String(port)] : [])], {
  cwd: pluginDir,
  stdio: ['ignore', 'pipe', 'pipe']
})

let registered = false
let cleaned = false

function cleanup() {
  if (cleaned) return
  cleaned = true
  try {
    updateMap((map) => {
      if (map[id]) delete map[id]
    })
    console.log(`[dev-plugin] 已移除 ${id} 的开发期入口`)
  } catch (err) {
    console.error('[dev-plugin] 清理 .dev-plugins.json 失败:', err.message)
  }
}

function register(url) {
  updateMap((map) => {
    map[id] = url
    // 时间戳让"同端口重启"也能触发主进程重载：内容不变时 watch 不会回调
    map._updatedAt = new Date().toISOString()
  })
  console.log(`\n[dev-plugin] ${id} → ${url}`)
  console.log('[dev-plugin] 已登记，主进程会自动重载该插件；改代码即时热更新')
  console.log('[dev-plugin] manifest 改动不在 HMR 范围：pnpm build:plugins 后重开插件\n')
}

// vite 打印的 Local 地址才是真实端口（默认端口被占用时会自增）。
// 注意：vite 7 即使输出到管道也会加 ANSI 颜色码，URL 会被拆成
// "http://localhost:" + 转义 + "5173" + 转义 + "/"，必须先剥掉颜色码再匹配。
const ANSI = /\u001b\[[0-9;]*m/g
child.stdout.on('data', (chunk) => {
  const text = String(chunk)
  process.stdout.write(text)
  if (registered) return
  const match = text.replace(ANSI, '').match(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)\/?/)
  if (!match) return
  registered = true
  register(`http://localhost:${match[1]}/`)
})
child.stderr.on('data', (chunk) => process.stderr.write(chunk))

child.on('error', (err) => {
  console.error('[dev-plugin] 启动 vite 失败:', err.message)
  cleanup()
  process.exit(1)
})
child.on('exit', (code) => {
  cleanup()
  process.exit(code ?? 0)
})

const stop = () => {
  cleanup()
  try {
    child.kill()
  } catch {
    /* 已退出 */
  }
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
