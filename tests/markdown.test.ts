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

describe('任务列表', () => {
  it('未完成与已完成各带自己的方框类名', () => {
    const html = renderMarkdown('- [ ] 待办\n- [x] 已完成\n- [X] 也已完成')
    expect(html).toContain('<li class="task"><span class="task-box" aria-hidden="true"></span>待办')
    expect(html).toContain('<li class="task task-on"><span class="task-box" aria-hidden="true"></span>已完成')
    expect(html.match(/task-on/g)).toHaveLength(2)
  })

  it('方框之后的文字照常渲染行内格式', () => {
    const html = renderMarkdown('- [x] 跑 `pnpm test`')
    expect(html).toContain('<code>pnpm test</code>')
    expect(textOf(html)).toBe('跑 pnpm test')
  })

  it('嵌套的任务列表跟着父项走', () => {
    const html = renderMarkdown('- [ ] 父\n  - [x] 子')
    expect(html).toContain('<ul><li class="task"><span class="task-box" aria-hidden="true"></span>父')
    expect(html).toContain('<li class="task task-on">')
  })

  it('普通列表项不会被当成任务项', () => {
    const html = renderMarkdown('- 普通\n- [不是勾选] 方括号开头')
    expect(html).not.toContain('task-box')
    expect(textOf(html)).toContain('[不是勾选] 方括号开头')
  })
})

describe('引用嵌套', () => {
  it('第二层再包一层 blockquote', () => {
    const html = renderMarkdown('> 外层\n> > 内层')
    expect(html.match(/<blockquote/g)).toHaveLength(2)
    expect(textOf(html)).toContain('外层')
    expect(textOf(html)).toContain('内层')
  })

  it('三层也不会丢字，且转义不会被逃第二次', () => {
    const html = renderMarkdown('> > > a & b')
    expect(html.match(/<blockquote/g)).toHaveLength(3)
    // 只该逃一次：再逃一次会变成 &amp;amp;
    expect(html).toContain('a &amp; b')
    expect(html).not.toContain('&amp;amp;')
  })

  it('行中间出现的 > 不算嵌套', () => {
    const html = renderMarkdown('> a > b')
    expect(html.match(/<blockquote/g)).toHaveLength(1)
  })
})

describe('图片', () => {
  it('http(s) 图片出 img，alt 与 title 带上', () => {
    const html = renderMarkdown('![架构图](https://example.com/a.png "标题")')
    expect(html).toContain('<img class="md-img" src="https://example.com/a.png" alt="架构图"')
    expect(html).toContain('title="标题"')
    expect(html).toContain('loading="lazy"')
  })

  it('非 http(s) 协议退化成原始文字（不在正文里开读本地文件的口子）', () => {
    for (const src of ['file:///c:/secret.png', 'data:image/png;base64,AAA', 'javascript:alert(1)']) {
      const html = renderMarkdown(`![x](${src})`)
      expect(html).not.toContain('<img')
      expect(textOf(html)).toContain(src)
    }
  })

  it('alt 里的引号不会把属性截断', () => {
    const html = renderMarkdown('![a" onerror="x](https://e.com/a.png)')
    expect(html).toContain('alt="a&quot; onerror=&quot;x"')
    expect(html).not.toContain('onerror="x"')
  })

  it('代码里的图片语法保持原样', () => {
    expect(renderMarkdown('`![x](https://e.com/a.png)`')).toContain('<code>![x](https://e.com/a.png)</code>')
  })
})

describe('单元格换行', () => {
  it('模型写的 <br> 变成真换行（表格里不能留换行符）', () => {
    const html = renderMarkdown('| 列 |\n| --- |\n| 上<br>下 |')
    expect(html).toContain('上<br>下')
    expect(html.replace(/\n/g, '')).toBe(html)
  })

  it('转义过的尖括号不会被当成 HTML 注入', () => {
    const html = renderMarkdown('<br onclick="x">')
    // 只有裸的 `<br>` 才认；带属性的整段仍是文字
    expect(html).not.toContain('<br onclick')
    expect(html).toContain('&lt;br onclick="x"&gt;')
  })
})
