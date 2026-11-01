import { computed, onUnmounted, watch } from 'vue'
import { useMessage } from 'naive-ui'
import type { InlineHit } from '../../../shared/inline'
import { useLauncherStore } from '../stores/launcher'

/**
 * 搜索：查询防抖、三段结果（内联 / 条目 / 应用）的光标模型、回车分发。
 *
 * 从 PanelShell 抽出来的原因：视图状态（弹层、外框、缩放）和"查询→结果→动作"
 * 是两件事，混在一个 800 行的组件里改任一侧都要先读懂另一侧。
 */

/** 输入防抖：内联插件要实时算，逐键请求会白跑；140ms 是「打字停顿」的经验值 */
const QUERY_DEBOUNCE_MS = 140

export function useSearch() {
  const store = useLauncherStore()
  const message = useMessage()

  /** 搜索态下的应用网格（与 home 的「全部应用」共用一份过滤结果） */
  const flat = computed(() => store.visiblePlugins)
  /** 三段共用一套 ↑↓ 光标：内联结果 → 条目 → 应用 */
  const inlineCount = computed(() => store.inline.length)
  const resultCount = computed(() => store.inline.length + store.entries.length + flat.value.length)

  let timer: ReturnType<typeof setTimeout> | undefined

  watch(
    () => store.query,
    (q) => {
      store.selIndex = 0
      if (timer) clearTimeout(timer)
      const text = q.trim()
      if (!text) {
        void store.search('')
        return
      }
      timer = setTimeout(() => void store.search(text), QUERY_DEBOUNCE_MS)
    },
    { immediate: true }
  )

  onUnmounted(() => {
    if (timer) clearTimeout(timer)
  })

  async function open(plugin: PluginSummary): Promise<void> {
    const result = await window.panel.openPlugin(plugin.id, store.query.trim() || undefined)
    if (!result.ok && result.message) message.error(result.message)
  }

  async function openEntry(hit: SearchHit): Promise<void> {
    // Pinia 里的 intent 是响应式 Proxy，过 contextBridge 会被判不可克隆，先转成纯数据
    const intent = hit.intent ? (JSON.parse(JSON.stringify(hit.intent)) as Record<string, unknown>) : undefined
    try {
      const result = await window.panel.openPlugin(hit.pluginId, store.query.trim() || undefined, intent)
      if (!result.ok && result.message) message.error(result.message)
    } catch (err) {
      message.error(`打开失败：${(err as Error).message}`)
    }
  }

  /**
   * 内联结果的动作：copy 只写剪贴板（面板留着，方便连续取用），
   * open 打开插件并把 intent 透传过去。没写 action 时按 open 处理。
   */
  async function runInline(hit: InlineHit | undefined): Promise<void> {
    if (!hit) return
    const action = hit.action
    if (action?.type === 'copy') {
      const ok = await window.panel.copyText(action.text)
      if (ok) {
        message.success(`已复制：${action.text.length > 40 ? action.text.slice(0, 40) + '…' : action.text}`)
      } else {
        message.error('复制失败')
      }
      return
    }
    const intent = action?.type === 'open' && action.intent ? JSON.parse(JSON.stringify(action.intent)) : undefined
    try {
      const result = await window.panel.openPlugin(hit.pluginId, store.query.trim() || undefined, intent)
      if (!result.ok && result.message) message.error(result.message)
    } catch (err) {
      message.error(`打开失败：${(err as Error).message}`)
    }
  }

  /** 回车：内联结果 → 条目 → 应用，按光标所在段决定动作 */
  function openCurrent(): void {
    const i = store.selIndex
    if (i < inlineCount.value) {
      void runInline(store.inline[i])
      return
    }
    const entryIndex = i - inlineCount.value
    if (entryIndex < store.entries.length) {
      void openEntry(store.entries[entryIndex])
      return
    }
    const plugin = flat.value[entryIndex - store.entries.length] ?? flat.value[0]
    if (plugin) void open(plugin)
  }

  return { flat, inlineCount, resultCount, open, openEntry, runInline, openCurrent }
}
