import { app, dialog, shell } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, basename, extname } from 'node:path'

/**
 * 插件文档库：userData/data/<pluginId>/docs/
 *
 * 为什么单独做一层：插件拿不到任何路径能力（铁律 4），但"自定义添加文档"又必须落盘。
 * 折中做法是主进程持有目录，只按 id 收发内容，路径始终不出主进程。
 */

/** 单文件上限，防止把面板拖死（手册类文本远远用不到） */
const MAX_BYTES = 4 * 1024 * 1024
const ALLOWED_EXT = ['.md', '.markdown', '.txt']

export interface PluginDocMeta {
  /** 文件名（已安全化），即后续 read/remove 的句柄 */
  id: string
  title: string
  size: number
  updatedAt: number
}

function safeId(pluginId: string): string {
  return pluginId.replace(/[^\w.-]/g, '_')
}

function docsDir(pluginId: string): string {
  return join(app.getPath('userData'), 'data', safeId(pluginId), 'docs')
}

/** 句柄只允许纯文件名：挡住 ../ 与绝对路径，保证读写落在插件自己的目录内 */
function resolveDoc(pluginId: string, id: string): string | null {
  const name = basename(String(id ?? ''))
  if (!name || name !== String(id) || !ALLOWED_EXT.includes(extname(name).toLowerCase())) return null
  const dir = docsDir(pluginId)
  const target = join(dir, name)
  if (!target.startsWith(dir)) return null
  return target
}

/**
 * 文本解码：优先 UTF-8；UTF-8 解码出现替换字符（说明不是合法 UTF-8，多为 GBK 中文文档）时回退 GBK。
 * 中文技术文档里 GBK 编码相当常见，直接按 utf-8 读会整篇乱码。
 */
function decode(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf-8')
  }
  const utf8 = buf.toString('utf-8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch {
    return utf8
  }
}

export const pluginDocs = {
  list(pluginId: string): PluginDocMeta[] {
    const dir = docsDir(pluginId)
    if (!existsSync(dir)) return []
    const items: PluginDocMeta[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      if (!ALLOWED_EXT.includes(extname(entry.name).toLowerCase())) continue
      try {
        const st = statSync(join(dir, entry.name))
        items.push({
          id: entry.name,
          title: basename(entry.name, extname(entry.name)),
          size: st.size,
          updatedAt: st.mtimeMs
        })
      } catch {
        /* 文件被外部占用/删除，跳过 */
      }
    }
    return items.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'))
  },

  /** 弹系统文件选择框导入（可多选），只拷进插件自己的 docs 目录 */
  async importFromDialog(pluginId: string): Promise<{ ok: boolean; added: number; skipped: number; message?: string }> {
    const picked = await dialog.showOpenDialog({
      title: '导入文档到手册（支持 Markdown / 纯文本）',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Markdown / 文本', extensions: ['md', 'markdown', 'txt'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, added: 0, skipped: 0 }
    const dir = docsDir(pluginId)
    mkdirSync(dir, { recursive: true })
    let added = 0
    let skipped = 0
    for (const src of picked.filePaths) {
      const ext = extname(src).toLowerCase()
      if (!ALLOWED_EXT.includes(ext)) {
        skipped++
        continue
      }
      try {
        if (statSync(src).size > MAX_BYTES) {
          skipped++
          continue
        }
        copyFileSync(src, uniqueTarget(dir, basename(src)))
        added++
      } catch (err) {
        console.error(`[docs] 导入失败 ${src}`, err)
        skipped++
      }
    }
    const message = skipped ? `已导入 ${added} 个，跳过 ${skipped} 个（格式或体积不符）` : `已导入 ${added} 个文档`
    return { ok: added > 0, added, skipped, message }
  },

  read(pluginId: string, id: string): { ok: boolean; text?: string; message?: string } {
    const target = resolveDoc(pluginId, id)
    if (!target || !existsSync(target)) return { ok: false, message: '文档不存在' }
    if (statSync(target).size > MAX_BYTES) return { ok: false, message: '文档过大（上限 4MB）' }
    try {
      return { ok: true, text: decode(readFileSync(target)) }
    } catch (err) {
      return { ok: false, message: `读取失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  },

  remove(pluginId: string, id: string): { ok: boolean; message?: string } {
    const target = resolveDoc(pluginId, id)
    if (!target) return { ok: false, message: '非法的文档标识' }
    try {
      rmSync(target, { force: true })
      return { ok: true }
    } catch (err) {
      return { ok: false, message: `删除失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  },

  /** 打开文档目录（用户在资源管理器里直接拖文件进来也行）；不把路径回传给插件 */
  async reveal(pluginId: string): Promise<{ ok: boolean; message?: string }> {
    const dir = docsDir(pluginId)
    mkdirSync(dir, { recursive: true })
    const err = await shell.openPath(dir)
    return err ? { ok: false, message: err } : { ok: true }
  }
}

function uniqueTarget(dir: string, fileName: string): string {
  const ext = extname(fileName)
  const stem = basename(fileName, ext)
  let target = join(dir, fileName)
  let n = 2
  while (existsSync(target)) target = join(dir, `${stem}-${n++}${ext}`)
  return target
}
