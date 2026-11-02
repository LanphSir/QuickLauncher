/**
 * 附件接收：字节进 → 可展示、可发送的 AiFilePart 出。
 *
 * 为什么不让插件页直接把解析结果塞进消息：那样「上下文里有什么」就由页面决定，
 * 页面被改一行代码就能把任意文本伪装成附件塞进模型。这里让主进程独占解析权，
 * 页面只能拿到一个 attachId，发送时回传 id，本体由主进程重建。
 *
 * 图片落盘而非内联：4MB 的图 base64 就是 5.3MB，塞进会话文件几次就把
 * 一个 JSON 撑到几十兆（每次保存都要整体重读写）。原图存 files 目录，
 * 消息里只留一张几十 KB 的缩略图。
 */
import { app, nativeImage } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  type AiAttachResult,
  type AiFilePart
} from '../../shared/ai'
import { classifyFile, docxToText, looksBinary, plainTextToText } from './extract'
import { pdfToText } from './pdf'

/** 暂存多久算过期：够用户挑完文件、写完问题，又不至于长期占内存 */
const TTL_MS = 30 * 60 * 1000

interface Entry {
  part: AiFilePart
  at: number
}

const pending = new Map<string, Entry>()

function filesDir(): string {
  return join(app.getPath('userData'), 'ai', 'files')
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}

function mimeOf(ext: string): string {
  return IMAGE_MIME[ext] ?? 'text/plain'
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function dropExpired(): void {
  const now = Date.now()
  for (const [id, entry] of pending) {
    if (now - entry.at > TTL_MS) pending.delete(id)
  }
}

function remember(part: AiFilePart): string {
  dropExpired()
  if (pending.size >= MAX_ATTACHMENTS * 4) {
    // 兜底：用户连拖几十个文件没发出去，丢掉最旧的
    const oldest = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) pending.delete(oldest[0])
  }
  const id = randomUUID()
  pending.set(id, { part, at: Date.now() })
  return id
}

/** 图片：存原图 + 生成缩略图。返回 part 或抛错（由调用方转成人话） */
function prepareImage(buf: Buffer, name: string, ext: string): AiFilePart {
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error(`图片 ${humanSize(buf.length)} 超过 ${humanSize(MAX_IMAGE_BYTES)}，先压缩再试`)
  }
  const image = nativeImage.createFromBuffer(buf)
  if (image.isEmpty()) throw new Error('这个文件不是能识别的图片（可能已损坏或后缀不对）')

  const { width, height } = image.getSize()
  const target = Math.min(width, 360)
  // 缩略图只给界面看：宽 360、质量 68，一张约 20–40KB，几十张也不至于把会话文件撑爆
  const thumb = target < width ? image.resize({ width: target, quality: 'good' }) : image
  const preview = `data:image/jpeg;base64,${thumb.toJPEG(68).toString('base64')}`

  const fileId = `${randomUUID()}${ext}`
  mkdirSync(filesDir(), { recursive: true })
  writeFileSync(join(filesDir(), fileId), buf)

  return {
    type: 'file',
    kind: 'image',
    name,
    mime: mimeOf(ext),
    size: buf.length,
    fileId,
    preview
  }
}

async function prepareText(buf: Buffer, name: string, ext: string): Promise<AiFilePart> {
  const base: AiFilePart = { type: 'file', kind: 'text', name, mime: 'text/plain', size: buf.length }

  if (ext === '.pdf') {
    const result = await pdfToText(buf)
    if (!result.text.trim()) {
      return {
        ...base,
        error: '这份 PDF 没有文字层（多半是扫描件），需要先做 OCR 才能读',
        text: ''
      }
    }
    // 页数/字数的实际情况直接写进正文：模型据此才知道自己看到的是节选，
    // 而不是完整的文档（否则它会自信地总结"全文共分三章"这种瞎话）
    const notes: string[] = []
    if (result.skippedPages > 0) notes.push(`仅解析前 ${result.pages} 页，另有 ${result.skippedPages} 页未读`)
    if (result.truncated) notes.push(`正文约 ${result.fullLength} 字，已截断`)
    const text = notes.length ? `${result.text}\n\n（${notes.join('；')}）` : result.text
    return { ...base, text, fullLength: result.fullLength }
  }

  if (ext === '.docx') {
    const result = docxToText(buf)
    if (!result.text.trim()) {
      return { ...base, error: '这份 docx 里没有可读的文字（可能是纯图片排版）', text: '' }
    }
    return { ...base, text: result.text, fullLength: result.fullLength }
  }

  // 后缀是文本，内容却像二进制：多半是改名过的压缩包 / 数据库文件
  if (looksBinary(buf)) {
    return { ...base, error: '这个文件看起来是二进制内容，不是文本（后缀可能是改过的）', text: '' }
  }

  const result = plainTextToText(buf)
  if (!result.text.trim()) {
    return { ...base, error: '文件是空的，没有可读内容', text: '' }
  }
  return {
    ...base,
    text: result.text,
    fullLength: result.fullLength
  }
}

/**
 * 接收一个附件。`bytes` 由渲染层读文件后传上来，或由主进程自己读路径后传入。
 * 无论哪条路，判定与解析都只发生在这里。
 */
export async function attachBytes(input: {
  name: string
  bytes: Buffer
  mime?: string
}): Promise<AiAttachResult> {
  const name = String(input?.name ?? '').trim() || '未命名文件'
  const bytes = input?.bytes
  if (!bytes || !bytes.length) return { ok: false, message: '文件是空的' }
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      message: `${humanSize(bytes.length)} 超过单文件上限 ${humanSize(MAX_ATTACHMENT_BYTES)}`
    }
  }

  const classified = classifyFile(name)
  if (!classified) {
    return {
      ok: false,
      message: `暂不支持 ${extname(name) || '这类'} 文件，可试试文本、代码、PDF、docx 或图片`
    }
  }

  try {
    const part =
      classified.kind === 'image'
        ? prepareImage(bytes, name, classified.ext)
        : await prepareText(bytes, name, classified.ext)
    const attachId = remember(part)
    return { ok: true, attachId, part }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/** 从磁盘路径接收（原生对话框与拖拽拿到路径时用） */
export async function attachPath(path: string): Promise<AiAttachResult> {
  const value = String(path ?? '')
  if (!existsSync(value)) return { ok: false, message: '文件不存在或已被移动' }
  try {
    const bytes = readFileSync(value)
    const name = value.split(/[\\/]/).pop() ?? value
    return await attachBytes({ name, bytes })
  } catch (err) {
    return {
      ok: false,
      message: `读不了这个文件：${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/** 按 id 取回附件（不删除：发送失败重试时还要用，TTL 到期会自己清） */
export function getAttachments(ids: string[] | undefined): AiFilePart[] {
  if (!Array.isArray(ids) || !ids.length) return []
  dropExpired()
  const out: AiFilePart[] = []
  for (const id of ids.slice(0, MAX_ATTACHMENTS)) {
    const entry = pending.get(String(id))
    if (entry) out.push(entry.part)
  }
  return out
}

/** 图片原图读成 data URL，供请求体使用 */
export function readImageDataUrl(fileId: string, mime: string): string | null {
  // 只允许单纯的文件名，挡住 `../` 这类越界
  if (!/^[\w.-]+$/.test(fileId)) return null
  const file = join(filesDir(), fileId)
  if (!existsSync(file)) return null
  try {
    return `data:${mime || 'image/png'};base64,${readFileSync(file).toString('base64')}`
  } catch {
    return null
  }
}

/** 删掉一条消息里的图片文件（删除消息/会话时调用） */
export function dropImageFiles(fileIds: string[]): void {
  for (const id of fileIds) {
    if (!/^[\w.-]+$/.test(id)) continue
    try {
      rmSync(join(filesDir(), id), { force: true })
    } catch {
      // 删不掉不影响主流程，下次启动的清理会再试
    }
  }
}

/**
 * 清理没有被任何会话引用的图片。
 * 会话删除、附件中途取消都会留下孤儿文件，不清就是磁盘上一堆再也读不到的图片。
 */
export function pruneOrphanFiles(referenced: Set<string>): number {
  const dir = filesDir()
  if (!existsSync(dir)) return 0
  let removed = 0
  try {
    for (const name of readdirSync(dir)) {
      if (referenced.has(name)) continue
      try {
        rmSync(join(dir, name), { force: true })
        removed += 1
      } catch {
        // 正在被读的文件删不掉，忽略
      }
    }
  } catch {
    // 目录读不了就跳过，不值得为清理把启动拖挂
  }
  return removed
}
