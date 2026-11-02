/**
 * `ai/SKILL.md` 的解析（v0.6.2）：渐进披露的第一半。
 *
 * 思路是「目录里只放一句话，正文等模型要」。多插件场景下，如果每个 SKILL.md
 * 全文都拼进 system prompt，十来个插件就能吃掉几千上万 token——还没开始聊，
 * 上下文就没了。所以这里只解析 front-matter 的 name/description，
 * 正文交给 `load_skill` 按需读取（v0.6.3 接工具调用）。
 *
 * front-matter 只支持 `key: value` 这一层，不引 YAML 解析器：
 * 需要嵌套结构的技能文档，用 Markdown 正文表达比 YAML 更自然。
 */
import { MAX_SKILL_DESCRIPTION } from '../../shared/ai'

export interface ParsedSkill {
  name: string
  description: string
  /** front-matter 之后的正文（已 trim），按需加载 */
  body: string
}

/** 正文上限：技能文档是给人读的说明书，不是数据集；超长基本是贴错文件了 */
export const MAX_SKILL_BODY = 20_000

function unquote(value: string): string {
  const text = value.trim()
  if (text.length >= 2) {
    const first = text[0]
    const last = text[text.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return text.slice(1, -1)
  }
  return text
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

interface SplitResult {
  meta: Map<string, string>
  body: string
}

/** 拆出 front-matter 与正文。没有 front-matter 时 meta 为空、body 是全文 */
export function splitFrontMatter(text: string): SplitResult {
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const meta = new Map<string, string>()
  if (!source.startsWith('---\n')) return { meta, body: source.trim() }

  const end = source.indexOf('\n---', 3)
  if (end < 0) return { meta, body: source.trim() }

  const head = source.slice(4, end)
  for (const line of head.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const colon = trimmed.indexOf(':')
    if (colon <= 0) continue
    const key = trimmed.slice(0, colon).trim().toLowerCase()
    const value = unquote(trimmed.slice(colon + 1))
    if (key && value) meta.set(key, value)
  }

  // `\n---` 之后就是正文；紧跟着的换行由 trim 吃掉
  const rest = source.slice(end + 4)
  return { meta, body: rest.trim() }
}

/**
 * 解析技能文档。空文件返回 null（等于没声明，不该在设置页留一行空条目）。
 *
 * name / description 缺失时依次兜底：一级标题 → 首个非空段落。
 * 兜底出来的往往比手写差，但比「工具列表里一行空白」强。
 */
export function parseSkillMd(text: string): ParsedSkill | null {
  if (!text.trim()) return null
  const { meta, body } = splitFrontMatter(text)
  if (!body && meta.size === 0) return null

  const headingMatch = body.match(/^#{1,3}\s+(.+)$/m)
  const heading = headingMatch ? headingMatch[1].trim() : ''

  let description = meta.get('description')?.trim() ?? ''
  if (!description) {
    // 首个非空、非标题、非代码围栏的段落：通常是「这个技能是干什么的」
    for (const block of body.split(/\n{2,}/)) {
      const line = block.trim()
      if (!line || line.startsWith('#') || line.startsWith('```') || line.startsWith('>')) continue
      description = line.replace(/\s+/g, ' ')
      break
    }
  }

  const name = (meta.get('name') ?? heading).trim()
  if (!name && !description) return null

  return {
    name: name || '（未命名技能）',
    description: truncate(description, MAX_SKILL_DESCRIPTION),
    body: truncate(body, MAX_SKILL_BODY)
  }
}
