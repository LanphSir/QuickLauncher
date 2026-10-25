import { defineStore } from 'pinia'
import { pluginMatch } from '../utils/match'

export type PanelView = 'home' | 'apps' | 'settings'

export const useLauncherStore = defineStore('launcher', {
  state: () => ({
    plugins: [] as PluginSummary[],
    config: null as LauncherConfig | null,
    query: '',
    view: 'home' as PanelView,
    selIndex: 0
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
    }
  }
})
