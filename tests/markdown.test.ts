import { describe, expect, it } from 'vitest'
import { escapeHtml, renderMarkdown, textSegs } from '../plugins/ai/src/markdown'

/** 去掉所有标签，用于断言「文字还在、没被吃掉」 */
const textOf = (html: string): string => html.replace(/<[^>]+>/g, '')

describe('正文分段（围栏代码）', () => {
  it('普通段落与代码块交替', () => {
    const segs = textSegs('看这里\n```ts\nconst a = 1\n```\n结束')
    expect(segs.map((s) => s.code)).toEqual([false, true, false])
    expect(segs[1]).toEqual({ code: true, text: 'const a = 1', lang: 'ts' })
    expect(segs[2].text).toBe('\n结束')
  })

  it('没闭合的围栏也按代码块处理：流式时不能先闪一段反引号', () => {
    const segs = textSegs('先说一句\n```js\nlet x =')
    expect(segs.at(-1)).toMatchObject({ code: true, lang: 'js', text: 'let x =' })
  })

  it('没有围栏时整段是正文', () => {
    expect(textSegs('就一句话')).toEqual([{ code: false, text: '就一句话', lang: '' }])
  })
})

describe('转义', () => {
  it('尖括号先转义，标签不会被注入', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;')
    const html = renderMarkdown('<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('行内格式', () => {
  it('代码、粗体、删除线', () => {
    const html = renderMarkdown('调用 `run()` 然后 **完成**，~~废弃~~')
    expect(html).toContain('<code>run()</code>')
    expect(html).toContain('<strong>完成</strong>')
    expect(html).toContain('<del>废弃</del>')
  })

  it('代码里的星号不当成粗体', () => {
    expect(renderMarkdown('`a ** b`')).toContain('<code>a ** b</code>')
  })

  it('算式里的星号不当成斜体', () => {
    expect(renderMarkdown('2*3*4 等于 24')).not.toContain('<em>')
    expect(renderMarkdown('这是 *强调* 的文字')).toContain('<em>强调</em>')
  })
})

describe('块级结构', () => {
  it('标题按级别出不同的类名', () => {
    const html = renderMarkdown('# 一级\n## 二级')
    expect(html).toContain('md-h1')
    expect(html).toContain('md-h2')
    expect(html).toContain('一级')
  })

  it('段落之间各自成段，行内换行保留在原处', () => {
    const html = renderMarkdown('第一行\n第二行\n\n另一段')
    expect(html.match(/class="md-p"/g)).toHaveLength(2)
    expect(html).toContain('第一行\n第二行')
  })

  it('分隔线与引用', () => {
    expect(renderMarkdown('---')).toContain('<hr class="md-hr" />')
    const quote = renderMarkdown('> 引用一\n> 引用二')
    expect(quote).toContain('<blockquote class="md-quote">')
    expect(textOf(quote)).toContain('引用一\n引用二')
  })

  it('输出里不留换行（容器是 pre-wrap，多一个换行就多一条空行）', () => {
    const html = renderMarkdown('# 标题\n\n- 一\n- 二\n\n| a | b |\n| --- | --- |\n| 1 | 2 |')
    expect(html.replace(/\n/g, '')).toBe(html)
  })
})

describe('表格', () => {
  const table = [
    '| 名称 | 数量 | 备注 |',
    '| :--- | ---: | :---: |',
    '| 苹果 | 3 | 红 |',
    '| 梨 | 12 | 黄 |'
  ].join('\n')

  it('表头、表体与对齐', () => {
    const html = renderMarkdown(table)
    expect(html).toContain('<table>')
    expect(html.match(/<th[ >]/g)).toHaveLength(3)
    expect(html.match(/<td[ >]/g)).toHaveLength(6)
    expect(html).toContain('<th style="text-align:right">数量</th>')
    expect(html).toContain('<th style="text-align:center">备注</th>')
    // 左对齐是默认值，不写内联样式
    expect(html).toContain('<th>名称</th>')
  })

  it('只有表头也成立', () => {
    const html = renderMarkdown('| a | b |\n| --- | --- |')
    expect(html).toContain('<table>')
    expect(html).not.toContain('<tbody>')
  })

  it('缺格子的行补空、多出来的忽略', () => {
    const html = renderMarkdown('| a | b |\n| --- | --- |\n| 1 |')
    expect(html.match(/<td[ >]/g)).toHaveLength(2)
    expect(html).toContain('<td></td>')
  })

  it('单元格里的反引号代码照常渲染', () => {
    const html = renderMarkdown('| 命令 | 说明 |\n| --- | --- |\n| `ls` | 列目录 |')
    expect(html).toContain('<code>ls</code>')
  })

  it('不是表格的竖线段落原样当文字', () => {
    const html = renderMarkdown('a | b 只是排版')
    expect(html).not.toContain('<table>')
    expect(textOf(html)).toContain('a | b 只是排版')
  })
})

describe('列表', () => {
  it('无序与有序列表', () => {
    expect(renderMarkdown('- 甲\n- 乙')).toContain('<ul><li>甲</li><li>乙</li></ul>')
    expect(renderMarkdown('1. 甲\n2. 乙')).toContain('<ol><li>甲</li><li>乙</li></ol>')
  })

  it('按缩进嵌套，父项把子列表包在里面', () => {
    const html = renderMarkdown('- 父\n  - 子一\n  - 子二\n- 兄弟')
    expect(html).toBe('<ul><li>父<ul><li>子一</li><li>子二</li></ul></li><li>兄弟</li></ul>')
  })

  it('三层嵌套也只开一层子列表', () => {
    const html = renderMarkdown('- a\n  - b\n    - c')
    expect(html).toBe('<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>')
  })

  it('松散列表（项之间有空行）算同一张', () => {
    const html = renderMarkdown('- 甲\n\n- 乙')
    expect(html).toBe('<ul><li>甲</li><li>乙</li></ul>')
  })

  it('缩进的续行并到上一条里', () => {
    const html = renderMarkdown('- 第一句\n  接着上一句')
    expect(textOf(html)).toBe('第一句\n接着上一句')
    expect(html.match(/<li>/g)).toHaveLength(1)
  })

  it('列表结束后回到段落', () => {
    const html = renderMarkdown('- 项\n\n正文')
    expect(html).toBe('<ul><li>项</li></ul><p class="md-p">正文</p>')
  })

  it('同一层换列表类型会另起一张', () => {
    const html = renderMarkdown('- 甲\n1. 乙')
    expect(html).toBe('<ul><li>甲</li></ul><ol><li>乙</li></ol>')
  })
})
