import { describe, expect, it } from 'vitest'
import { MAX_SKILL_BODY } from '../src/main/ai/skillFile'
import { parseSkillMd, splitFrontMatter } from '../src/main/ai/skillFile'
import { MAX_SKILL_DESCRIPTION } from '../src/shared/ai'

describe('front-matter 拆分', () => {
  it('拆出键值对与正文，正文不含分隔符', () => {
    const { meta, body } = splitFrontMatter('---\nname: 翻译\ndescription: 中英互译\n---\n正文第一行\n正文第二行')
    expect(meta.get('name')).toBe('翻译')
    expect(meta.get('description')).toBe('中英互译')
    expect(body).toBe('正文第一行\n正文第二行')
  })

  it('没有 front-matter 时 meta 为空、body 是全文', () => {
    const { meta, body } = splitFrontMatter('# 标题\n\n正文')
    expect(meta.size).toBe(0)
    expect(body).toBe('# 标题\n\n正文')
  })

  it('只有开头没有结尾分隔符时按无 front-matter 处理（不去猜）', () => {
    const { meta, body } = splitFrontMatter('---\nname: 半截')
    expect(meta.size).toBe(0)
    expect(body).toContain('name: 半截')
  })

  it('兼容 CRLF 与 BOM', () => {
    const { meta, body } = splitFrontMatter('\uFEFF---\r\nname: 翻译\r\n---\r\n正文')
    expect(meta.get('name')).toBe('翻译')
    expect(body).toBe('正文')
  })

  it('值两边的引号会去掉', () => {
    const { meta } = splitFrontMatter('---\nname: "翻译"\ndescription: \'中英互译\'\n---\n')
    expect(meta.get('name')).toBe('翻译')
    expect(meta.get('description')).toBe('中英互译')
  })
})

describe('SKILL.md 解析', () => {
  it('front-matter 优先', () => {
    const skill = parseSkillMd('---\nname: 翻译\ndescription: 中英互译、术语对照\n---\n# 用法\n更多细节')
    expect(skill).toMatchObject({ name: '翻译', description: '中英互译、术语对照' })
    expect(skill?.body).toContain('更多细节')
  })

  it('没有 front-matter 时用一级标题当名字、首段当说明', () => {
    const skill = parseSkillMd('# 翻译\n\n中英互译，支持术语表。\n\n## 用法\n…')
    expect(skill?.name).toBe('翻译')
    expect(skill?.description).toBe('中英互译，支持术语表。')
  })

  it('跳过围栏与引用块，别把示例代码当说明', () => {
    const skill = parseSkillMd('# 翻译\n\n```js\nconsole.log(1)\n```\n\n> 引用\n\n真正的说明')
    expect(skill?.description).toBe('真正的说明')
  })

  it('空文件返回 null（等于没声明）', () => {
    expect(parseSkillMd('')).toBeNull()
    expect(parseSkillMd('   \n\n ')).toBeNull()
  })

  it('说明过长截断并加省略号', () => {
    const skill = parseSkillMd(`---\nname: 长说明\ndescription: ${'x'.repeat(800)}\n---\n正文`)
    expect(skill?.description.length).toBe(MAX_SKILL_DESCRIPTION)
    expect(skill?.description.endsWith('…')).toBe(true)
  })

  it('正文超过上限也截断（贴错文件的保险）', () => {
    const skill = parseSkillMd(`---\nname: 大文件\n---\n${'y'.repeat(MAX_SKILL_BODY + 500)}`)
    expect(skill?.body.length).toBe(MAX_SKILL_BODY)
  })

  it('只有 front-matter 没有正文也能用（工具目录只要一句话）', () => {
    const skill = parseSkillMd('---\nname: 翻译\ndescription: 中英互译\n---\n')
    expect(skill).toMatchObject({ name: '翻译', description: '中英互译', body: '' })
  })
})
