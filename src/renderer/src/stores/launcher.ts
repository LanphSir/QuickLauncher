import { defineStore } from 'pinia'
import type { InlineHit } from '../../../shared/inline'
import { pluginMatch } from '../utils/match'

export type PanelView = 'home' | 'apps' | 'settings'

/** 搜索请求序号：异步返回乱序时只认最后一次（快速连打不会闪回旧结果） */
let searchSeq = 0

export const useLauncherStore = defineStore('launcher', {
  state: () => ({
    plugins: [] as PluginSummary[],
    config: null as LauncherConfig | null,
    query: '',
    view: 'home' as PanelView,
    selIndex: 0,
    /** 插件通过搜索贡献协议注册的条目（手册章节等），命中排在应用前面 */
    entries: [] as SearchHit[],
    /** 内联结果：输入即得的一两行，排在条目与应用之前 */
    inline: [] as InlineHit[]
  }),
  getters: {
    /** 搜索命中：名称/id 子串，或任一关键词（支持通配符与 re: 正则）；已停用插件不参与 */
    visiblePlugins(state): PluginSummary[] {
      const pool = state.plugins.filter((p) => !p.disabled)
      const q = state.query.trim()
      if (!q) return pool
      return pool.filter((p) => pluginMatch(q, p))
    },
    pinned(state): PluginSummary[] {
      const ids = state.config?.pinnedIds ?? []
      return ids
        .map((id) => state.plugins.find((p) => p.id === id))
        .filter((p): p is PluginSummary => Boolean(p))
    }
  },
  actions: {
    async load() {
      const [plugins, config] = await Promise.all([
        window.panel.getPlugins(),
        window.panel.getConfig()
      ])
      this.plugins = plugins
      this.config = config
    },
    resetHome() {
      this.query = ''
      this.view = 'home'
      this.selIndex = 0
      this.entries = []
      this.inline = []
    },
    /**
     * 一次查询取两类结果：
     * - entries：插件注册的条目（主进程内存查表，快）；
     * - inline：内联插件实时回话（最多等 120ms）。
     * 两条通道并发，任一失败都只影响自己那一类，不会让整个搜索空掉。
     */
    async search(query: string) {
      const q = query.trim()
      const seq = ++searchSeq
      if (!q) {
        this.entries = []
        this.inline = []
        return
      }
      const [entries, inline] = await Promise.all([
        window.panel.search(q).catch(() => [] as SearchHit[]),
        window.panel.inline(q).catch(() => [] as InlineHit[])
      ])
      if (seq !== searchSeq) return
      this.entries = entries
      this.inline = inline
    }
  }
})
