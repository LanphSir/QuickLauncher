import type { InlineItem, InlineReply } from '../../shared/pluginApi'
import {
  MAX_INLINE_PER_PLUGIN,
  MAX_INLINE_TOTAL,
  normalizeInlineItems,
  type InlineHit
} from '../../shared/inline'
import type { PluginRecord } from './manager'
import { warmPluginContents } from '../windows/pluginHost'
import { getPanelWindow } from '../windows/panel'

/**
 * 内联结果调度：把面板的每次输入推给声明了 `features: ["inline"]` 的插件，
 * 收集它们回的结果，按插件顺序拼在搜索结果最上方。
 *
 * 三条硬约束（都是为了让「输入即得」不变成「输入就卡」）：
 * 1. 有超时：单次查询最多等 120ms，没回就当这次没有，不阻塞面板；
 * 2. 不排队：同一插件上一轮没回就地作废，只认最新一轮（键击比插件快是常态）；
 * 3. 页面没就绪就不问：视图还在加载时直接跳过，避免把首屏加载时间摊到搜索上。
 */

const TIMEOUT_MS = 120

interface Slot {
  seq: number
  resolve: (items: InlineItem[]) => void
  timer: ReturnType<typeof setTimeout>
}

let seq = 0
/** pluginId → 当前等待中的查询（每个插件同时只有一个） */
const pending = new Map<string, Slot>()
/** 已经挂了「加载完通知面板」监听的插件，避免每次键击都叠一个 listener */
const awaitingLoad = new Set<string>()

/**
 * 插件视图还在加载时的兜底：等页面加载完，让面板用当前搜索词重查一次。
 *
 * 否则会出现「第一次输入没结果、再打一个字才出结果」的低级体感：
 * 首屏加载 300~800ms，而用户往往打一个词就停下来了。
 */
function notifyWhenReady(rec: PluginRecord, wc: Electron.WebContents): void {
  const id = rec.manifest.id
  if (awaitingLoad.has(id)) return
  awaitingLoad.add(id)
  wc.once('did-finish-load', () => {
    awaitingLoad.delete(id)
    getPanelWindow()?.webContents.send('panel:inline-ready')
  })
}

function inlinePlugins(plugins: PluginRecord[]): PluginRecord[] {
  return plugins.filter(
    (rec) => !rec.disabled && rec.manifest.type === 'web' && (rec.manifest.features ?? []).includes('inline')
  )
}

function ask(rec: PluginRecord, query: string): Promise<InlineHit[]> {
  const id = rec.manifest.id
  const wc = warmPluginContents(rec)
  if (!wc) return Promise.resolve([])
  if (wc.isLoading()) {
    notifyWhenReady(rec, wc)
    return Promise.resolve([])
  }

  const prev = pending.get(id)
  if (prev) {
    clearTimeout(prev.timer)
    pending.delete(id)
    prev.resolve([])
  }

  const mySeq = ++seq
  return new Promise<InlineHit[]>((resolve) => {
    const timer = setTimeout(() => {
      const cur = pending.get(id)
      if (cur?.seq === mySeq) pending.delete(id)
      resolve([])
    }, TIMEOUT_MS)

    pending.set(id, {
      seq: mySeq,
      timer,
      resolve: (items) => {
        clearTimeout(timer)
        resolve(
          items.map((item) => ({
            ...item,
            pluginId: id,
            pluginName: rec.manifest.name,
            icon: rec.iconDataUrl
          }))
        )
      }
    })

    try {
      wc.send('plugin:inline-query', { seq: mySeq, query })
    } catch {
      // 页面正在销毁：当作这轮没结果
      clearTimeout(timer)
      pending.delete(id)
      resolve([])
    }
  })
}

/**
 * 面板搜索时调用：并发问所有内联插件，超时即放弃。
 * 返回顺序 = 插件扫描顺序，总量由 MAX_INLINE_TOTAL 截断。
 */
export async function queryInline(query: string, plugins: PluginRecord[]): Promise<InlineHit[]> {
  const q = query.trim()
  if (!q) return []
  const targets = inlinePlugins(plugins)
  if (!targets.length) return []

  const groups = await Promise.all(targets.map((rec) => ask(rec, q)))
  const out: InlineHit[] = []
  for (const group of groups) {
    for (const hit of group) {
      if (out.length >= MAX_INLINE_TOTAL) return out
      out.push(hit)
    }
  }
  return out
}

/** 插件回传结果：seq 对不上说明是过期响应，直接丢弃 */
export function replyInline(rec: PluginRecord, reply: InlineReply): number {
  const id = rec.manifest.id
  const slot = pending.get(id)
  if (!slot || slot.seq !== reply.seq) return 0
  pending.delete(id)
  const items = normalizeInlineItems(reply.items).slice(0, MAX_INLINE_PER_PLUGIN)
  slot.resolve(items)
  return items.length
}

/** 插件被卸载/停用：作废等待中的查询，别让面板等满 120ms */
export function forgetInline(pluginId: string): void {
  const slot = pending.get(pluginId)
  if (!slot) return
  pending.delete(pluginId)
  clearTimeout(slot.timer)
  slot.resolve([])
}
