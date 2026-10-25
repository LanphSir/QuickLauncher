import type { IconName } from '../components/icons'

/** 无自定义图标的插件：按名称/关键词/ID 推断一个分类图标 */
export function fallbackIconFor(plugin: { name: string; id: string; keywords: string[] }): IconName {
  const hay = `${plugin.name} ${plugin.keywords.join(' ')} ${plugin.id}`.toLowerCase()
  if (/trans|翻译|translate|globe|词典|dict|语言|fy/.test(hay)) return 'globe'
  if (/calc|计算|数学|math/.test(hay)) return 'calculator'
  if (/clip|剪贴|粘贴|复制|paste/.test(hay)) return 'clipboard'
  if (/note|记事|文本|txt|file|文件|editor|编辑/.test(hay)) return 'file'
  return 'grid'
}

/** 按插件 id 稳定散列到一组渐变色，让默认图标色彩丰富但不闪烁 */
const GRADIENTS = [
  'linear-gradient(135deg, #6366f1, #8b5cf6)',
  'linear-gradient(135deg, #3b82f6, #06b6d4)',
  'linear-gradient(135deg, #10b981, #14b8a6)',
  'linear-gradient(135deg, #f59e0b, #f97316)',
  'linear-gradient(135deg, #ef4444, #ec4899)',
  'linear-gradient(135deg, #64748b, #475569)'
]

export function gradientFor(plugin: { id: string }): string {
  let hash = 0
  for (const ch of plugin.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return GRADIENTS[hash % GRADIENTS.length]
}
