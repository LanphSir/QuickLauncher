/**
 * PDF 抽正文。
 *
 * 用 unpdf（pdfjs 的 serverless 构建）而不是 pdfjs 全家桶：后者带 worker、canvas、
 * 字体渲染，几十 MB 只为了读几段文字。unpdf 是 ESM-only，所以走动态 import——
 * 主进程产物是 CJS，但 CJS 里 `import()` 加载 ESM 是合法的，Node 会处理。
 *
 * 页数设上限是刻意的：一份 600 页的规范 PDF 抽出来的字远超任何上下文窗口，
 * 抽它是纯浪费。用户真需要整本，应该先自己截取。
 */
import type { ExtractedText } from './extract'
import { capText } from './extract'

/** 最多解析多少页 */
export const MAX_PDF_PAGES = 80

/** 单份 PDF 的解析超时：超过就放弃，避免一个坏文件挂住整个附件流程 */
export const PDF_TIMEOUT_MS = 20_000

export interface PdfResult extends ExtractedText {
  pages: number
  /** 因页数上限被跳过的页数 */
  skippedPages: number
}

function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`PDF 解析超过 ${Math.round(ms / 1000)} 秒，已放弃`)), ms)
    task.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/**
 * 抽 PDF 文本。抽不出字（扫描件、纯图片 PDF）时返回空串而不是报错——
 * 这是"文件本身没有文字层"，与"解析失败"是两件事，界面要能区分。
 */
export async function pdfToText(buf: Buffer): Promise<PdfResult> {
  const run = async (): Promise<PdfResult> => {
    const { getDocumentProxy } = await import('unpdf')
    const doc = await getDocumentProxy(new Uint8Array(buf))
    const total = doc.numPages
    const limit = Math.min(total, MAX_PDF_PAGES)

    const chunks: string[] = []
    for (let i = 1; i <= limit; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      let line = ''
      for (const item of content.items) {
        // TextItem 有 str；TextMarkedContent 没有，跳过
        if (!('str' in item)) continue
        line += item.str
        if (item.hasEOL) line += '\n'
      }
      chunks.push(line.trim())
      page.cleanup()
    }

    const text = chunks.filter(Boolean).join('\n\n')
    return { ...capText(text), pages: limit, skippedPages: total - limit }
  }

  return withTimeout(run(), PDF_TIMEOUT_MS)
}
