// 打包前收集内置插件到 out-plugins/<id>/，供 electron-builder extraResources 使用
// - plugins/<name>/plugin.json   （external 型等免构建插件：整个目录拷贝）
// - plugins/<name>/dist/plugin.json（web 型：构建产物目录拷贝）
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'plugins')
const OUT = join(ROOT, 'out-plugins')

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const skip = (p) => /node_modules|(^|[/\\])src([/\\]|$)|\.vite/.test(p)

let count = 0
for (const name of readdirSync(SRC)) {
  const base = join(SRC, name)
  if (!statSync(base).isDirectory()) continue
  let from = null
  if (existsSync(join(base, 'plugin.json'))) from = base
  else if (existsSync(join(base, 'dist', 'plugin.json'))) from = join(base, 'dist')
  if (!from) {
    console.warn(`[collect-plugins] 跳过 ${name}（未找到 plugin.json）`)
    continue
  }
  const to = join(OUT, name)
  cpSync(from, to, { recursive: true, filter: (s) => !skip(s) || s === from })
  count++
  console.log(`[collect-plugins] ${name} -> out-plugins/${name}`)
}
console.log(`[collect-plugins] 共收集 ${count} 个内置插件`)
