/**
 * 对话正文的极轻 markdown 渲染。
 *
 * 不引 markdown 库：引进来就要背一整棵 AST、插件包体积和 HTML 清洗的口径，
 * 而这里真正需要「比纯文本好看」的只有几样——代码块、表格、列表、标题。
 * 剩下的（脚注、数学、嵌套引用）放在对话里出现频率极低，不做。
 *
 * 三条必须守住的规矩：
 * 1. **先转义再拼标签**。模型输出里出现 `<script>` 只能是字面量。
 * 2. **输出里不能有换行**。正文容器是 `white-space: pre-wrap`，标签之间多一个
 *    换行就会多出一条空行；段落内部的换行要靠 pre-wrap 保留，也不额外插 `<br>`。
 * 3. **流式要能看**。没闭合的围栏、写了一半的表格，都要渲染成"能读的东西"，
 *    不能等结构完整才显示——否则生成过程中会先闪一段原始符号。
 *
 * 纯函数、无 DOM 依赖，`tests/markdown.test.ts` 直接跑。
 */

export interface TextSeg {
  code: boolean
  text: string
  lang: string
}

/**
 * 把正文按 ``` 围栏切段。
 *
 * 没闭合的围栏也按代码块处理——流式输出时首尾围栏不是同时到的，
 * 不这样会先闪一段带 ``` 的纯文本。
 */
export function textSegs(text: string): TextSeg[] {
  const out: TextSeg[] = []
  let i = 0
  while (i < text.length) {
    const open = text.indexOf('```', i)
    if (open < 0) {
      out.push({ code: false, text: text.slice(i), lang: '' })
      break
    }
    if (open > i) out.push({ code: false, text: text.slice(i, open), lang: '' })
    const nl = text.indexOf('\n', open + 3)
    const lang = (nl < 0 ? text.slice(open + 3) : text.slice(open + 3, nl)).trim()
    const bodyStart = nl < 0 ? text.length : nl + 1
    const close = text.indexOf('```', bodyStart)
    out.push({
      code: true,
      text: text.slice(bodyStart, close < 0 ? text.length : close).replace(/\n$/, ''),
      lang
    })
    i = close < 0 ? text.length : close + 3
  }
  return out
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/* ---------------------------------------------------------------- 行内 */

/**
 * 行内格式：`代码`、**粗体**、*斜体*、~~删除线~~。
 *
 * 先按反引号切开，奇数下标一定在代码里——这样 `**` 出现在代码里不会被当粗体。
 * 反引号个数是奇数（流式写了一半）时，尾巴会短暂变成代码块样式，比原样显示反引号好。
 */
function inline(text: string): string {
  return text
    .split('`')
    .map((part, i) => (i % 2 === 1 ? `<code>${part}</code>` : emphasis(part)))
    .join('')
}

function emphasis(text: string): string {
  return text
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
    // 斜体只在两侧是空白/标点时才认：`2*3*4` 这种不该变成 2<em>3</em>4
    .replace(
      /(^|[\s(（【[>"'])\*(?=\S)([^*\n]*?\S)\*(?=$|[\s)）】\]"',.!?，。！？；：])/g,
      '$1<em>$2</em>'
    )
}

/* ---------------------------------------------------------------- 块级 */

const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/
const HEADING = /^[ \t]*(#{1,6})[ \t]+(.*)$/
/** 引用：`>` 已被转义成 `&gt;`，两种写法都认 */
const QUOTE = /^[ \t]*(?:>|&gt;)[ \t]?(.*)$/
const RULE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const FENCE = /^[ \t]*```/
/** 表格分隔行：`---`、`:--`、`:-:`、`--:`，可带竖线 */
const TABLE_SEP = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/

/** 拆表格行：去掉首尾竖线，按未转义的 `|` 切 */
function splitRow(line: string): string[] {
  let body = line.trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|')) body = body.slice(0, -1)
  return body.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

function alignOf(cell: string): string {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  // 左对齐是默认值，不写 style，省得每格都带一串内联样式
  return ''
}

function alignAttr(align: string): string {
  return align ? ` style="text-align:${align}"` : ''
}

/** 当前行 + 下一行构成表格头（下一行必须是列数一致的分隔行） */
function isTableStart(lines: string[], i: number): boolean {
  const head = lines[i]
  const sep = lines[i + 1]
  if (!sep || !head.includes('|') || !TABLE_SEP.test(sep)) return false
  return splitRow(head).length === splitRow(sep).length
}

function tableBlock(lines: string[], start: number): { html: string; next: number } {
  const head = splitRow(lines[start])
  const aligns = splitRow(lines[start + 1]).map(alignOf)
  const rows: string[][] = []
  let i = start + 2
  // 表格到空行或没有竖线的行为止；列数不齐的行照样收，缺的格子留空
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
    rows.push(splitRow(lines[i]))
    i++
  }
  const th = head.map((cell, c) => `<th${alignAttr(aligns[c] ?? '')}>${inline(cell)}</th>`).join('')
  const trs = rows
    .map(
      (row) =>
        `<tr>${head
          .map((_, c) => `<td${alignAttr(aligns[c] ?? '')}>${inline(row[c] ?? '')}</td>`)
          .join('')}</tr>`
    )
    .join('')
  return {
    // 外面再包一层：窄窗口里表格要能横向滚，而不是把正文撑爆
    html: `<div class="md-table"><table><thead><tr>${th}</tr></thead>${
      trs ? `<tbody>${trs}</tbody>` : ''
    }</table></div>`,
    next: i
  }
}

/**
 * 列表：按缩进嵌套。
 *
 * 缩进按"两个空格一层"算（tab 先展开成两个空格）——模型输出的缩进从 2 到 4 空格都有，
 * 按"每两个空格算一层"能把它们都归到同一棵树上，不至于出现一格一个层级的畸形结构。
 */
function listBlock(lines: string[], start: number): { html: string; next: number } {
  const out: string[] = []
  const stack: { indent: number; tag: 'ul' | 'ol' }[] = []
  let i = start

  /** 关掉最深的一层；每层都要先闭合那一格 `<li>` */
  const closeTop = (): void => {
    const level = stack.pop()
    if (level) out.push(`</li></${level.tag}>`)
  }

  while (i < lines.length) {
    const line = lines[i]
    const m = LIST_ITEM.exec(line)
    if (!m) {
      // 松散列表：空行之后还是列表项，视为同一张列表
      if (!line.trim() && i + 1 < lines.length && LIST_ITEM.test(lines[i + 1])) {
        i++
        continue
      }
      // 缩进的续行属于上一条：模型经常把一句话折成几行
      if (line.trim() && /^[ \t]+\S/.test(line) && stack.length) {
        out.push(`\n${inline(line.trim())}`)
        i++
        continue
      }
      break
    }
    const indent = m[1].replace(/\t/g, '  ').length
    const tag: 'ul' | 'ol' = /^\d/.test(m[2]) ? 'ol' : 'ul'
    const content = inline(m[3])

    // 回到不比上一项更深的层
    while (stack.length && indent < stack[stack.length - 1].indent) closeTop()

    if (!stack.length || indent > stack[stack.length - 1].indent) {
      // 新列表，或者比上一层更深 = 子列表（父级 `<li>` 保持打开，正好包住它）
      out.push(`<${tag}>`)
      stack.push({ indent, tag })
      out.push(`<li>${content}`)
    } else if (stack[stack.length - 1].tag === tag) {
      out.push(`</li><li>${content}`)
    } else {
      // 同缩进换了类型（`-` 接 `1.`）：这一层结束，另起一层
      closeTop()
      out.push(`<${tag}>`)
      stack.push({ indent, tag })
      out.push(`<li>${content}`)
    }
    i++
  }
  while (stack.length) closeTop()
  return { html: out.join(''), next: i }
}

/**
 * 渲染一段正文（不含围栏代码块——那部分由 `textSegs` 拆出去单独渲染）。
 *
 * 输出里所有标签紧挨着，不留换行：正文容器是 pre-wrap，多一个换行就多一条空行。
 */
export function renderMarkdown(text: string): string {
  const lines = escapeHtml(text).split('\n')
  const out: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }

    // 兜底：围栏没被拆出来（例如调用方直接喂了整段），按代码块渲染
    if (FENCE.test(line)) {
      const body: string[] = []
      i++
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++])
      i++
      out.push(`<pre class="md-code">${body.join('\n')}</pre>`)
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      const level = heading[1].length
      out.push(`<span class="md-h md-h${level}">${inline(heading[2].trim())}</span>`)
      i++
      continue
    }

    if (isTableStart(lines, i)) {
      const table = tableBlock(lines, i)
      out.push(table.html)
      i = table.next
      continue
    }

    if (LIST_ITEM.test(line)) {
      const list = listBlock(lines, i)
      out.push(list.html)
      i = list.next
      continue
    }

    if (QUOTE.test(line)) {
      const body: string[] = []
      while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])![1])
      out.push(`<blockquote class="md-quote">${inline(body.join('\n'))}</blockquote>`)
      continue
    }

    if (RULE.test(line)) {
      out.push('<hr class="md-hr" />')
      i++
      continue
    }

    // 段落：一路收到空行或下一个块的开头
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !HEADING.test(lines[i]) &&
      !LIST_ITEM.test(lines[i]) &&
      !QUOTE.test(lines[i]) &&
      !RULE.test(lines[i]) &&
      !FENCE.test(lines[i]) &&
      !isTableStart(lines, i)
    ) {
      para.push(lines[i++])
    }
    out.push(`<p class="md-p">${inline(para.join('\n'))}</p>`)
  }

  return out.join('')
}
