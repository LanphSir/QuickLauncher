import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { planPluginWatches } from '../src/main/plugin/watchPlan'

let root = ''

const manifest = (dir: string) => writeFileSync(join(dir, 'plugin.json'), '{"id":"x","name":"x","type":"web"}')

describe('planPluginWatches', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ql-watch-'))
    // a：manifest 就在根，无 dist
    mkdirSync(join(root, 'a'))
    manifest(join(root, 'a'))
    // b：典型构建产物布局，manifest 只在 dist 里
    mkdirSync(join(root, 'b', 'dist'), { recursive: true })
    manifest(join(root, 'b', 'dist'))
    // c：目录刚建、还没构建
    mkdirSync(join(root, 'c'))
    // .hidden：不算插件
    mkdirSync(join(root, '.hidden'))
    manifest(join(root, '.hidden'))
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('不存在的根目录不监听', () => {
    expect(planPluginWatches([join(root, 'nope')])).toEqual([])
  })

  it('根目录总是监听（新建/删除插件目录靠它）', () => {
    const targets = planPluginWatches([root])
    expect(targets[0]).toEqual({ dir: root })
  })

  it('每个插件目录都监听，含尚未构建的空目录', () => {
    const dirs = planPluginWatches([root]).map((t) => t.dir)
    for (const name of ['a', 'b', 'c']) expect(dirs).toContain(join(root, name))
  })

  it('dist 存在时额外监听它（构建完成的那一刻要能感知）', () => {
    const dirs = planPluginWatches([root]).map((t) => t.dir)
    expect(dirs).toContain(join(root, 'b', 'dist'))
    expect(dirs).not.toContain(join(root, 'a', 'dist'))
  })

  it('点开头的目录不算插件', () => {
    const dirs = planPluginWatches([root]).map((t) => t.dir)
    expect(dirs.some((d) => d.includes('.hidden'))).toBe(false)
  })

  it('插件目录只认 manifest 与 dist，避免构建时被 JS/CSS 写入刷屏', () => {
    const plugin = planPluginWatches([root]).find((t) => t.dir === join(root, 'a'))
    expect(plugin?.match?.test('plugin.json')).toBe(true)
    expect(plugin?.match?.test('dist')).toBe(true)
    expect(plugin?.match?.test('index.js')).toBe(false)
  })

  it('多个根目录合并成一张监听表', () => {
    const other = mkdtempSync(join(tmpdir(), 'ql-watch2-'))
    mkdirSync(join(other, 'z'))
    manifest(join(other, 'z'))
    try {
      const dirs = planPluginWatches([root, other]).map((t) => t.dir)
      expect(dirs).toContain(root)
      expect(dirs).toContain(other)
      expect(dirs).toContain(join(other, 'z'))
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})
