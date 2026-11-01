import type { InlineReply } from '../../../shared/pluginApi'
import { replyInline } from '../inline'
import { defineApi } from './define'
import { fail } from './validate'

/**
 * 内联结果回传。要求 manifest 声明 `features: ["inline"]`（feature 门禁，不是权限）。
 *
 * items 具体形状交给 shared/inline 的 normalizeInlineItems 裁剪：这里只挡
 * 「不是数组」「seq 不是整数」这类结构性错误，内容细节（超长、类型乱）在那边统一处理，
 * 避免同一套规则写两遍。
 */
export const inlineApi = [
  defineApi('plugin:inline.set', {
    feature: 'inline',
    parse: (payload) => {
      const raw = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
      const seq = raw.seq
      if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) fail('seq 必须是非负整数')
      const items = Array.isArray(raw.items) ? raw.items : []
      return { seq, items: items as InlineReply['items'] }
    },
    handle: ({ rec }, reply) => replyInline(rec, reply)
  })
]
