#!/usr/bin/env node
/**
 * 手册打包：manuals/<id>/ → src/data/manuals.generated.ts
 *
 * 为什么在构建期做：插件页跑在 file:// 下，运行时 fetch 本地 json/md 会被 CORS 拦掉；
 * 用 vite 的 `?raw` 静态导入把正文打进 bundle，既免 fetch 又能离线。
 *
 * 加一本手册 = 建一个目录 + 写 manual.json + 扔 md，然后 pnpm build:plugins。
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const manualsRoot = join(root, 'manuals')
const outFile = join(root, 'src', 'data', 'manuals.generated.ts')

const REQUIRED = ['id', 'title']
const problems = []

function stripFrontMatter(text) {
  if (!text.startsWith('---')) return text
  const end = text.indexOf('\n---', 3)
  if (end < 0) return text
  return text.slice(text.indexOf('\n', end + 1) + 1)
}

function titleFromFile(file, content) {
  const m = /^#\s+(.+)$/m.exec(content.slice(0, 2000))
  if (m) return m[1].trim()
  return file.replace(/\.(md|markdown)$/i, '').replace(/^\d+[-_.]?/, '')
}

function chapterId(file) {
  return file.replace(/\.(md|markdown)$/i, '').replace(/[^\w.-]+/g, '-').toLowerCase()
}

function toImportPath(abs) {
  const rel = relative(join(root, 'src', 'data'), abs).replace(/\\/g, '/')
  return rel.startsWith('.') ? rel : `./${rel}`
}

function readManual(dirName) {
  const dir = join(manualsRoot, dirName)
  const metaFile = join(dir, 'manual.json')
  if (!existsSync(metaFile)) {
    problems.push(`${dirName}: 缺少 manual.json，已跳过`)
    return null
  }
  let meta
  try {
    meta = JSON.parse(readFileSync(metaFile, 'utf-8'))
  } catch (err) {
    problems.push(`${dirName}: manual.json 不是合法 JSON（${err.message}）`)
    return null
  }
  for (const key of REQUIRED) {
    if (!meta[key] || typeof meta[key] !== 'string') {
      problems.push(`${dirName}: manual.json 缺少 ${key}`)
      return null
    }
  }

  const mdFiles = readdirSync(dir).filter((f) => /\.(md|markdown)$/i.test(f))
  // chapters 显式声明则按声明顺序；否则按文件名排序自动收录
  const declared = Array.isArray(meta.chapters) && meta.chapters.length > 0
    ? meta.chapters
    : [...mdFiles].sort().map((file) => ({ file }))

  const chapters = []
  for (const item of declared) {
    const file = item?.file
    if (!file) {
      problems.push(`${dirName}: chapters 里有条目缺少 file`)
      continue
    }
    const abs = join(dir, file)
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      problems.push(`${dirName}: 章节文件不存在 ${file}`)
      continue
    }
    const content = stripFrontMatter(readFileSync(abs, 'utf-8'))
    chapters.push({
      id: item.id || chapterId(file),
      title: item.title || titleFromFile(file, content),
      abs,
      content
    })
  }
  if (chapters.length === 0) {
    problems.push(`${dirName}: 没有任何可用章节，已跳过`)
    return null
  }

  return {
    id: meta.id,
    title: meta.title,
    description: meta.description,
    keywords: Array.isArray(meta.keywords) ? meta.keywords.filter((k) => typeof k === 'string') : [],
    order: Number.isFinite(meta.order) ? meta.order : 100,
    source: typeof meta.source === 'string' ? meta.source : undefined,
    license: typeof meta.license === 'string' ? meta.license : undefined,
    chapters
  }
}

if (!existsSync(manualsRoot)) {
  console.warn('[manuals] 未找到 manuals 目录，生成空手册集')
}

const dirs = existsSync(manualsRoot)
  ? readdirSync(manualsRoot).filter((name) => {
      const p = join(manualsRoot, name)
      return statSync(p).isDirectory() && !name.startsWith('.')
    })
  : []

const manuals = dirs.map(readManual).filter(Boolean).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, 'zh-CN'))

if (problems.length) {
  console.warn('[manuals] 校验告警：')
  for (const p of problems) console.warn(`  - ${p}`)
}

const lines = []
lines.push('// 由 plugins/handbook/scripts/build-manuals.mjs 生成，请勿手改（改 manuals/ 后重新 build）')
lines.push("import type { Manual } from '../types'")
manuals.forEach((m, mi) => {
  m.chapters.forEach((c, ci) => {
    lines.push(`import m${mi}c${ci} from '${toImportPath(c.abs)}?raw'`)
  })
})
lines.push('')
lines.push('export const MANUALS: Manual[] = [')
manuals.forEach((m, mi) => {
  lines.push('  {')
  lines.push(`    id: ${JSON.stringify(m.id)},`)
  lines.push(`    title: ${JSON.stringify(m.title)},`)
  if (m.description) lines.push(`    description: ${JSON.stringify(m.description)},`)
  lines.push(`    keywords: ${JSON.stringify(m.keywords)},`)
  lines.push(`    order: ${m.order},`)
  if (m.source) lines.push(`    source: ${JSON.stringify(m.source)},`)
  if (m.license) lines.push(`    license: ${JSON.stringify(m.license)},`)
  lines.push('    chapters: [')
  m.chapters.forEach((c, ci) => {
    lines.push(`      { id: ${JSON.stringify(c.id)}, title: ${JSON.stringify(c.title)}, content: m${mi}c${ci} },`)
  })
  lines.push('    ]')
  lines.push('  },')
})
lines.push(']')
lines.push('')

writeFileSync(outFile, lines.join('\n'), 'utf-8')

/**
 * 同时产出主面板的「冷启动搜索索引」：public/search-index.json 会随 vite build
 * 复制到 dist 根目录，主进程扫描插件时直接读取。
 *
 * 为什么需要它：插件没被打开过时，运行时条目还不存在，主面板搜 "linux" 就找不到
 * 这本手册。静态索引补上这一段；插件一旦运行，会用自己的动态条目（含停用状态与
 * 用户改过的匹配词）整体覆盖。
 */
const searchEntries = []
for (const m of manuals) {
  searchEntries.push({
    id: `manual:${m.id}`,
    title: m.title,
    subtitle: `${m.chapters.length} 章`,
    keywords: [...m.keywords, m.title, ...m.chapters.map((c) => c.title).slice(0, 40)],
    group: '程序员手册',
    weight: 0,
    intent: { manualId: m.id }
  })
  for (const c of m.chapters) {
    searchEntries.push({
      id: `chapter:${m.id}/${c.id}`,
      title: c.title,
      subtitle: m.title,
      keywords: [c.title],
      group: '程序员手册',
      weight: 10,
      intent: { manualId: m.id, chapterId: c.id }
    })
  }
}
writeFileSync(join(root, 'public', 'search-index.json'), `${JSON.stringify(searchEntries, null, 2)}\n`, 'utf-8')
console.log(`[manuals] 搜索索引 ${searchEntries.length} 条 → public/search-index.json`)

const totalCh = manuals.reduce((n, m) => n + m.chapters.length, 0)
console.log(`[manuals] 打包 ${manuals.length} 本手册 / ${totalCh} 个章节 → src/data/manuals.generated.ts`)
for (const m of manuals) console.log(`  - ${m.title}（${m.id}，${m.chapters.length} 章）`)
