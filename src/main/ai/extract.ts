/**
 * 附件文本抽取：把用户丢进来的文件变成一段能进上下文的文字。
 *
 * 三条原则：
 * 1. **能读多少读多少，但要说清读了多少**。截断不是悄悄发生的，`fullLength`
 *    会一路传到界面上，否则用户会以为模型看过整份日志。
 * 2. **不认识就明说**。返回 `error` 而不是空串——空串在界面上看起来像
 *    "这个文件是空的"，而真相是我们压根没解析它。
 * 3. **不做隐式转换**。图片不在这里 OCR，PDF 不在这里排版还原，
 *    只抽纯文本，把能力边界划清楚。
 */
import AdmZip from 'adm-zip'
import { basename, extname } from 'node:path'
import { MAX_ATTACHMENT_TEXT } from '../../shared/ai'

/** 图片扩展名 */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])

/** 纯文本类扩展名。宁可漏掉一个冷门后缀（走"不认识"提示），也不要误判成二进制 */
const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.mdx', '.rst',
  '.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties', '.env',
  '.log', '.csv', '.tsv', '.xml', '.plist',
  '.html', '.htm', '.xhtml', '.css', '.scss', '.less', '.svg',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte',
  '.py', '.go', '.rs', '.java', '.kt', '.kts', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs',
  '.php', '.rb', '.lua', '.dart', '.scala', '.clj', '.ex', '.exs', '.erl', '.hs', '.ml', '.r', '.jl',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.bat', '.cmd',
  '.sql', '.graphql', '.gql', '.proto', '.thrift',
  '.dockerfile', '.gitignore', '.gitattributes', '.editorconfig', '.npmrc'
])

/** 无扩展名但确定是文本的文件名 */
const TEXT_NAMES = new Set([
  'dockerfile', 'makefile', 'rakefile', 'gemfile', 'procfile', 'cmakelists.txt',
  'license', 'readme', 'changelog', 'authors', 'notice'
])

export type AttachKind = 'image' | 'text'

export interface Classified {
  kind: AttachKind
  /** 归一化后的扩展名（小写，含点） */
  ext: string
}

/**
 * 判定一个文件该怎么处理。
 * 只看扩展名与常见文件名：靠 MIME 不可靠（浏览器对 .md 和 .log 都给空串），
 * 靠内容嗅探又太慢（要读完整个文件），而用户拖进来的东西九成有正确后缀。
 */
export function classifyFile(name: string): Classified | null {
  const base = basename(String(name ?? '')).toLowerCase()
  const ext = extname(base)
  if (IMAGE_EXTS.has(ext)) return { kind: 'image', ext }
  if (TEXT_EXTS.has(ext)) return { kind: 'text', ext }
  if (!ext && TEXT_NAMES.has(base)) return { kind: 'text', ext: '' }
  return null
}

export interface ExtractedText {
  text: string
  /** 截断前的字符数 */
  fullLength: number
  truncated: boolean
  /** 识别出的编码，用于界面提示（GBK 文件常被误当成乱码） */
  encoding?: string
}

/**
 * 解码字节为文本。
 *
 * 中文 Windows 上的 .log / .csv 有相当比例是 GBK，直接按 UTF-8 解会得到一串
 * U+FFFD。做法是先用 UTF-8 严格解，失败了再试 GBK——比装一个编码探测库便宜，
 * 也够覆盖真实场景（用户拖进来的基本不是 UTF-16 之外的东西）。
 */
export function decodeText(buf: Buffer): { text: string; encoding: string } {
  if (!buf.length) return { text: '', encoding: 'utf-8' }

  // BOM 优先：有 BOM 就不用猜
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf-8'), encoding: 'utf-8' }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf-16le'), encoding: 'utf-16le' }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // Node 没有 utf-16be，交换字节后按 le 解
    const swapped = Buffer.from(buf.subarray(2))
    swapped.swap16()
    return { text: swapped.toString('utf-16le'), encoding: 'utf-16be' }
  }

  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf)
  const bad = (utf8.match(/\uFFFD/g) ?? []).length
  // 少量替换字符可能只是文件里真有异常字节，占比超过千分之二才认为是编码不对
  if (bad > 0 && bad / Math.max(1, utf8.length) > 0.002) {
    try {
      const gbk = new TextDecoder('gbk', { fatal: false }).decode(buf)
      const gbkBad = (gbk.match(/\uFFFD/g) ?? []).length
      if (gbkBad < bad) return { text: gbk, encoding: 'gbk' }
    } catch {
      // 运行时没带 gbk 解码表（small-icu 构建），保持 utf-8 结果
    }
  }
  return { text: utf8, encoding: 'utf-8' }
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * docx 抽正文：docx 就是个 zip，正文全在 word/document.xml。
 * 不引 mammoth 之类是因为它顺带做 HTML 还原，而那正是我们不需要的——
 * 模型要的是字，不是样式。
 */
export function docxToText(buf: Buffer): ExtractedText {
  let xml = ''
  try {
    const zip = new AdmZip(buf)
    const entry = zip.getEntry('word/document.xml')
    if (!entry) {
      return { text: '', fullLength: 0, truncated: false, encoding: undefined }
    }
    xml = zip.readAsText(entry, 'utf-8')
  } catch (err) {
    throw new Error(`docx 解压失败：${err instanceof Error ? err.message : String(err)}`)
  }

  const text = xml
    // 段落结束 → 换行；表格单元格结束 → 制表符，保留表格的基本可读性
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<w:br\s*\/>/g, '\n')
    .replace(/<w:tab\s*\/>/g, '\t')
    // 只保留文本节点
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((line) => unescapeXml(line).replace(/[ \t]+$/g, ''))
    .join('\n')
    // 连续空行压成一个（Word 的段落标记会制造大量空行）
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return capText(text)
}

/** 按上限截断，并把原始长度带回 */
export function capText(text: string, limit = MAX_ATTACHMENT_TEXT): ExtractedText {
  const fullLength = text.length
  if (fullLength <= limit) return { text, fullLength, truncated: false }
  return { text: text.slice(0, limit), fullLength, truncated: true }
}

/** 纯文本类文件 */
export function plainTextToText(buf: Buffer): ExtractedText {
  const { text, encoding } = decodeText(buf)
  return { ...capText(text), encoding }
}

/** 判断字节流像不像二进制（含 NUL 或大量控制字符） */
export function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 4096))
  let control = 0
  for (const byte of sample) {
    if (byte === 0) return true
    // 允许 \t \n \r \f \v
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control += 1
  }
  return sample.length > 0 && control / sample.length > 0.1
}
