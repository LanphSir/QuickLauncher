import { describe, expect, it } from 'vitest'
import {
  baseName,
  buildShortcut,
  dedupeCandidates,
  groupCandidates,
  makeShortcutId,
  normalizeIcon,
  normalizeKeywords,
  parseShortcutList,
  parseUrlFile,
  slugify,
  splitArgs,
  type ShortcutCandidate,
  type ShortcutEntry
} from '../src/main/services/shortcutModel'

const entry = (patch: Partial<ShortcutEntry> = {}): ShortcutEntry => ({
  id: 'com.launcher.shortcut.code',
  name: 'VS Code',
  command: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
  args: [],
  keywords: ['vscode'],
  icon: { kind: 'auto' },
  createdAt: 1,
  ...patch
})

describe('baseName / slugify：从路径里取个好认的 id 片段', () => {
  it('同时认 / 与 \\，并去掉扩展名', () => {
    expect(baseName('C:\\Program Files\\App\\Code.exe')).toBe('Code')
    expect(baseName('/Applications/Code.app/Code')).toBe('Code')
    expect(baseName('notepad')).toBe('notepad')
  })

  it('中文路径折叠后为空（由调用方回退到序号）', () => {
    expect(slugify('微信')).toBe('')
    expect(slugify('Visual Studio Code')).toBe('visual-studio-code')
  })
})

describe('makeShortcutId：撞了自动加序号', () => {
  it('优先用命令文件名', () => {
    expect(makeShortcutId('随便起的名字', 'C:/x/Code.exe', new Set())).toBe('com.launcher.shortcut.code')
  })

  it('重复时依次加 -2 / -3', () => {
    const taken = new Set(['com.launcher.shortcut.code', 'com.launcher.shortcut.code-2'])
    expect(makeShortcutId('x', 'code.exe', taken)).toBe('com.launcher.shortcut.code-3')
  })

  it('全中文且无扩展名时落到 app', () => {
    expect(makeShortcutId('微信', '微信', new Set())).toBe('com.launcher.shortcut.app')
  })
})

describe('splitArgs：认引号', () => {
  it('带空格的路径不会被切碎', () => {
    expect(splitArgs('"C:/My App/a.txt" --flag')).toEqual(['C:/My App/a.txt', '--flag'])
  })

  it('空串得到空数组', () => {
    expect(splitArgs('   ')).toEqual([])
  })
})

describe('normalizeKeywords / normalizeIcon', () => {
  it('关键词支持逗号顿号空格分隔并去重', () => {
    expect(normalizeKeywords('vscode, 编辑器、code  VSCODE')).toEqual(['vscode', '编辑器', 'code'])
  })

  it('图标类型非法时回落 auto，file 缺路径也回落', () => {
    expect(normalizeIcon('nope')).toEqual({ kind: 'auto' })
    expect(normalizeIcon({ kind: 'file' })).toEqual({ kind: 'auto' })
    expect(normalizeIcon({ kind: 'file', path: 'C:/a.png' })).toEqual({ kind: 'file', path: 'C:/a.png' })
    expect(normalizeIcon({ kind: 'none' })).toEqual({ kind: 'none' })
  })
})

describe('buildShortcut：表单 → 记录', () => {
  it('名称/命令为空直接拒', () => {
    expect(buildShortcut({ name: '  ', command: 'a.exe' }, new Set()).ok).toBe(false)
    expect(buildShortcut({ name: 'a', command: ' ' }, new Set()).ok).toBe(false)
  })

  it('参数与关键词接受字符串形式', () => {
    const r = buildShortcut(
      { name: 'App', command: 'app.exe', args: '--a "b c"', keywords: 'x y' },
      new Set()
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.entry.args).toEqual(['--a', 'b c'])
    expect(r.entry.keywords).toEqual(['x', 'y'])
    expect(r.entry.id).toBe('com.launcher.shortcut.app')
  })

  it('编辑时保留 id 与创建时间（固定/快捷键都按 id 挂）', () => {
    const old = entry({ createdAt: 123 })
    const r = buildShortcut({ id: old.id, name: '改名', command: 'code.exe' }, new Set([old.id]), old)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.entry.id).toBe(old.id)
    expect(r.entry.createdAt).toBe(123)
  })
})

describe('parseShortcutList：坏一条不拖垮整个文件', () => {
  it('丢掉缺字段与重复 id 的项', () => {
    const list = parseShortcutList({
      schemaVersion: 1,
      items: [
        { id: 'a', name: 'A', command: 'a.exe', args: '--x', keywords: 'ka' },
        { id: 'a', name: '重复', command: 'b.exe' },
        { id: 'c', name: '', command: 'c.exe' },
        { name: '没有 id', command: 'd.exe' },
        'garbage'
      ]
    })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: 'a', args: ['--x'], keywords: ['ka'] })
  })

  it('接受裸数组（早期手写文件）', () => {
    expect(parseShortcutList([{ id: 'x', name: 'X', command: 'x.exe' }])).toHaveLength(1)
  })

  it('非数组非对象返回空', () => {
    expect(parseShortcutList(null)).toEqual([])
    expect(parseShortcutList('oops')).toEqual([])
  })
})

describe('parseUrlFile：.url 是 INI', () => {
  it('取 URL= 那行', () => {
    expect(parseUrlFile('[InternetShortcut]\r\nURL=https://example.com/a\r\nIconIndex=0')).toBe(
      'https://example.com/a'
    )
  })

  it('非 http(s) 视为无效', () => {
    expect(parseUrlFile('[InternetShortcut]\nURL=file:///C:/x.html')).toBe(null)
    expect(parseUrlFile('no url here')).toBe(null)
  })
})

describe('dedupeCandidates：候选去重', () => {
  const c = (path: string, name: string, group = '桌面'): ShortcutCandidate => ({
    path,
    name,
    group,
    kind: 'lnk'
  })

  it('已经导入过的命令不再出现', () => {
    const list = dedupeCandidates([c('C:/a.lnk', 'A'), c('C:/b.lnk', 'B')], ['c:/A.lnk'])
    expect(list.map((x) => x.name)).toEqual(['B'])
  })

  it('同名同目标只留一条', () => {
    const list = dedupeCandidates([c('C:/a.lnk', 'A'), c('C:/a.lnk', 'A')], [])
    expect(list).toHaveLength(1)
  })
})

describe('groupCandidates：按来源分组', () => {
  it('组内保序、组间按名称排序', () => {
    const list: ShortcutCandidate[] = [
      { path: 'a', name: 'A', group: '开始菜单', kind: 'lnk' },
      { path: 'b', name: 'B', group: '桌面', kind: 'lnk' },
      { path: 'c', name: 'C', group: '开始菜单', kind: 'lnk' }
    ]
    const groups = groupCandidates(list)
    expect(groups.map((g) => g.group)).toEqual(['开始菜单', '桌面'])
    expect(groups[0].items.map((i) => i.name)).toEqual(['A', 'C'])
  })
})
