/**
 * 极简 Markdown → 结构化块。
 *
 * 为什么不引第三方库：项目约定"不引入新的运行时依赖除非确有必要"；
 * 手册只需要标题/段落/列表/代码/表格/引用这几种块，自己解析可控且没有 XSS 面。
 *
 * 安全策略：所有文本先转义再拼接，只在确定安全的位置插入我们自己生成的标签；
 * 链接 href 只放行 http(s) / mailto / 页内锚点，其余原样当文本。
 */

export interface ListItem {
  html: string
  depth: number
  ordered: boolean
  marker: string
}

export type Block =
  | { type: 'heading'; level: number; html: string; line: number; anchor: string }
  | { type: 'paragraph'; html: string; line: number }
  | { type: 'code'; lang: string; code: string; line: number }
  | { type: 'list'; items: ListItem[]; line: number }
  | { type: 'quote'; blocks: Block[]; line: number }
  | { type: 'table'; headers: string[]; rows: string[][]; line: number }
  | { type: 'hr'; line: number }

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => ESCAPES[ch])
}

/** 去掉内联 HTML 标签（很多手册由网页转出来，正文里夹着 <div>/<span>） */
function stripTags(input: string): string {
  return input.replace(/<\/?[a-zA-Z][^>]*>/g, '')
}

function safeHref(raw: string): string | null {
  const href = raw.trim()
  if (/^https?:\/\//i.test(href)) return href
  if (/^mailto:/i.test(href)) return href
  if (/^#[\w-]+$/.test(href)) return href
  return null
}

/** 行内解析：先摘出 `code`，避免代码里的 * _ < 被当成语法 */
export function inlineHtml(source: string): string {
  const codes: string[] = []
  let text = source.replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(code)
    return `\u0000${codes.length - 1}\u0000`
  })
  text = escapeHtml(stripTags(text))
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (whole, label: string, href: string) => {
    const safe = safeHref(href.replace(/&amp;/g, '&'))
    if (!safe) return label
    return `<a href="${safe}" target="_blank" rel="noreferrer noopener">${label}</a>`
  })
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  // 中文正文里 *强调* 两侧常常直接贴着汉字（"许多*地方*，"），不能用 \s 做边界；
  // JS 的 \w 只含 ASCII，所以 [^*\w] 能覆盖中日韩字符
  text = text.replace(/(^|[^*\w])\*([^\s*][^*\n]*?)\*(?=$|[^*\w])/g, '$1<em>$2</em>')
  text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  return text.replace(/\u0000(\d+)\u0000/g, (_m, idx: string) => `<code>${escapeHtml(codes[Number(idx)])}</code>`)
}

const RE_HEADING = /^(#{1,6})\s+(.*)$/
const RE_FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/
const RE_HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const RE_QUOTE = /^\s*>\s?(.*)$/
const RE_LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/
const RE_TABLE_SEP = /^\s*\|?[\s:|-]+\|?\s*$/

function isBlank(line: string): boolean {
  return line.trim() === ''
}

function splitRow(line: string): string[] {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
  return cells.map((c) => c.trim())
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  let anchorSeq = 0

  while (i < lines.length) {
    const line = lines[i]
    if (isBlank(line)) {
      i++
      continue
    }

    // 代码块
    const fence = RE_FENCE.exec(line)
    if (fence) {
      const mark = fence[1][0]
      const lang = fence[2] ?? ''
      const start = i
      const buf: string[] = []
      i++
      while (i < lines.length && !new RegExp(`^\\s*${mark}{3,}\\s*$`).test(lines[i])) {
        buf.push(lines[i])
        i++
      }
      i++ // 跳过结束围栏
      blocks.push({ type: 'code', lang, code: buf.join('\n'), line: start })
      continue
    }

    // 标题
    const heading = RE_HEADING.exec(line)
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        html: inlineHtml(heading[2]),
        line: i,
        anchor: `h-${anchorSeq++}`
      })
      i++
      continue
    }

    // setext 标题（下一行是 ==== 或 ----）：Linux 命令手册整篇都是这种写法
    if (i + 1 < lines.length && /^\s*(={2,}|-{2,})\s*$/.test(lines[i + 1]) && !RE_LIST.test(line)) {
      blocks.push({
        type: 'heading',
        level: lines[i + 1].trim().startsWith('=') ? 1 : 2,
        html: inlineHtml(line),
        line: i,
        anchor: `h-${anchorSeq++}`
      })
      i += 2
      continue
    }

    // 分隔线
    if (RE_HR.test(line)) {
      blocks.push({ type: 'hr', line: i })
      i++
      continue
    }

    // 引用：收集连续行后递归解析
    if (RE_QUOTE.test(line)) {
      const start = i
      const buf: string[] = []
      while (i < lines.length && RE_QUOTE.test(lines[i])) {
        buf.push(RE_QUOTE.exec(lines[i])![1])
        i++
      }
      blocks.push({ type: 'quote', blocks: parseMarkdown(buf.join('\n')), line: start })
      continue
    }

    // 表格
    if (line.includes('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const start = i
      const headers = splitRow(line).map((c) => inlineHtml(c))
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && !isBlank(lines[i])) {
        rows.push(splitRow(lines[i]).map((c) => inlineHtml(c)))
        i++
      }
      blocks.push({ type: 'table', headers, rows, line: start })
      continue
    }

    // 列表
    if (RE_LIST.test(line)) {
      const start = i
      const items: ListItem[] = []
      while (i < lines.length && RE_LIST.test(lines[i])) {
        const m = RE_LIST.exec(lines[i])!
        const indent = m[1].replace(/\t/g, '  ').length
        let text = m[3]
        i++
        // 缩进的续行并入当前条目
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !RE_LIST.test(lines[i]) && !isBlank(lines[i])) {
          text += ` ${lines[i].trim()}`
          i++
        }
        items.push({
          html: inlineHtml(text),
          depth: Math.min(Math.floor(indent / 2), 4),
          ordered: /\d/.test(m[2]),
          marker: /\d/.test(m[2]) ? m[2].replace(/[.)]/, '') : '•'
        })
      }
      blocks.push({ type: 'list', items, line: start })
      continue
    }

    // 段落：吃到空行或下一个块级结构为止
    const start = i
    const buf: string[] = []
    while (i < lines.length && !isBlank(lines[i])) {
      const cur = lines[i]
      if (buf.length > 0 && (RE_HEADING.test(cur) || RE_FENCE.test(cur) || RE_LIST.test(cur) || RE_QUOTE.test(cur) || RE_HR.test(cur))) {
        break
      }
      buf.push(cur.trim())
      i++
    }
    const html = inlineHtml(buf.join(' '))
    if (html.trim()) blocks.push({ type: 'paragraph', html, line: start })
  }

  return blocks
}

/** 从 Markdown 里抽纯文本，用于搜索（去掉围栏标记与行内标记，代码正文保留——搜命令常常就是搜代码块） */
export function plainText(source: string): string {
  return source
    .replace(/^\s*(?:`{3,}|~{3,})[\w+-]*\s*$/gm, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[#>*_~|-]+/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
