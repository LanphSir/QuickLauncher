import { defineStore } from 'pinia'

export const useLauncherStore = defineStore('launcher', {
  state: () => ({
    plugins: [] as PluginSummary[],
    config: null as LauncherConfig | null,
    query: '',
    view: 'home' as 'home' | 'settings',
    selIndex: 0
  }),
  getters: {
    visiblePlugins(state): PluginSummary[] {
      const q = state.query.trim().toLowerCase()
      if (!q) return state.plugins
      return state.plugins.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.id.toLowerCase().includes(q) ||
          p.keywords.some((k) => k.toLowerCase().includes(q))
      )
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
