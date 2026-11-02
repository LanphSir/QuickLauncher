import { describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import { capText, classifyFile, decodeText, docxToText, looksBinary } from '../src/main/ai/extract'

/** 造一个只有正文的 docx：docx 本质就是含 word/document.xml 的 zip */
function makeDocx(paragraphs: string[]): Buffer {
  const body = paragraphs
    .map((text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`)
    .join('')
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
  const zip = new AdmZip()
  zip.addFile('word/document.xml', Buffer.from(xml, 'utf-8'))
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>', 'utf-8'))
  return zip.toBuffer()
}

describe('附件类型判定', () => {
  it('认图片', () => {
    expect(classifyFile('截图.PNG')).toEqual({ kind: 'image', ext: '.png' })
    expect(classifyFile('a/b/c.jpg')).toEqual({ kind: 'image', ext: '.jpg' })
  })

  it('认文本与代码', () => {
    expect(classifyFile('app.log')).toEqual({ kind: 'text', ext: '.log' })
    expect(classifyFile('main.ts')).toEqual({ kind: 'text', ext: '.ts' })
    expect(classifyFile('配置.yaml')).toEqual({ kind: 'text', ext: '.yaml' })
  })

  it('无扩展名的常见文本文件按名字认', () => {
    expect(classifyFile('Dockerfile')?.kind).toBe('text')
    expect(classifyFile('LICENSE')?.kind).toBe('text')
  })

  it('不认识的后缀返回 null（由调用方提示不支持）', () => {
    expect(classifyFile('installer.exe')).toBeNull()
    expect(classifyFile('archive.7z')).toBeNull()
  })
})

describe('文本解码', () => {
  it('UTF-8 直接解', () => {
    expect(decodeText(Buffer.from('中文 abc', 'utf-8'))).toEqual({ text: '中文 abc', encoding: 'utf-8' })
  })

  it('跳过 UTF-8 BOM', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('内容', 'utf-8')])
    expect(decodeText(buf).text).toBe('内容')
  })

  it('UTF-16 LE BOM 按 utf-16le 解', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('宽字符', 'utf-16le')])
    expect(decodeText(buf)).toEqual({ text: '宽字符', encoding: 'utf-16le' })
  })

  it('GBK 文件在 UTF-8 下是乱码，回退到 gbk 解出正确中文', () => {
    // GBK 里「中文日志」的字节；用 latin1 塞回去保持字节原样
    const gbkBytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xc8, 0xd5, 0xd6, 0xbe])
    const decoded = decodeText(gbkBytes)
    expect(decoded.encoding).toBe('gbk')
    expect(decoded.text).toBe('中文日志')
  })
})

describe('二进制嗅探', () => {
  it('含 NUL 的判为二进制', () => {
    expect(looksBinary(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))).toBe(true)
  })

  it('正常文本不是二进制', () => {
    expect(looksBinary(Buffer.from('line1\nline2\ttabbed\r\n', 'utf-8'))).toBe(false)
  })
})

describe('docx 抽取', () => {
  it('按段落还原换行，去掉标签', () => {
    const out = docxToText(makeDocx(['第一段', '第二段', '']))
    expect(out.text).toBe('第一段\n第二段')
    expect(out.text).not.toContain('<w:t')
  })

  it('实体被反转义', () => {
    const out = docxToText(makeDocx(['a &lt; b &amp;&amp; c &gt; d']))
    expect(out.text).toBe('a < b && c > d')
  })

  it('不是 docx（缺 document.xml）时返回空，不抛错', () => {
    const zip = new AdmZip()
    zip.addFile('other.xml', Buffer.from('<x/>'))
    expect(docxToText(zip.toBuffer()).text).toBe('')
  })
})

describe('文本上限', () => {
  it('不超限原样返回', () => {
    expect(capText('abc', 10)).toEqual({ text: 'abc', fullLength: 3, truncated: false })
  })

  it('超限截断但记住原始长度', () => {
    const out = capText('a'.repeat(50), 10)
    expect(out.text).toHaveLength(10)
    expect(out.fullLength).toBe(50)
    expect(out.truncated).toBe(true)
  })
})
