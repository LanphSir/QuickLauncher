<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useMessage } from 'naive-ui'
import { useLauncherStore } from '../stores/launcher'
import AppTile from './AppTile.vue'
import AppIcon from './AppIcon.vue'
import AppManage from './AppManage.vue'
import ContextMenu, { type ContextMenuItem } from './ContextMenu.vue'
import PluginDetail from './PluginDetail.vue'
import ExternalEdit from './ExternalEdit.vue'
import SettingsView from './SettingsView.vue'

const store = useLauncherStore()
const message = useMessage()
const searchRef = ref<HTMLInputElement | null>(null)

const ctx = ref<{ plugin: PluginSummary; x: number; y: number } | null>(null)
const detail = ref<PluginSummary | null>(null)
const edit = ref<PluginSummary | null>(null)
const pulse = ref(false)
let pulseTimer: ReturnType<typeof setTimeout> | undefined

onMounted(async () => {
  await store.load()
  window.panel.onShown(() => {
    store.resetHome()
    triggerPulse()
    focusSearch()
  })
  window.panel.onPluginExited(() => {
    store.resetHome()
    focusSearch()
  })
  window.panel.onPluginCrashed(({ name }) => {
    store.resetHome()
    focusSearch()
    message.error(`插件「${name}」已崩溃退出，其他功能不受影响`)
  })
  window.panel.onOpenSettings(() => {
    store.view = 'settings'
  })
  // 弹层优先吃掉 Esc（capture 阶段），避免同时触发面板隐藏
  window.addEventListener('keydown', onGlobalKeydown, true)
  triggerPulse()
  focusSearch()
})

onUnmounted(() => {
  window.removeEventListener('keydown', onGlobalKeydown, true)
  if (pulseTimer) clearTimeout(pulseTimer)
})

function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  if (edit.value) {
    e.stopPropagation()
    edit.value = null
  } else if (detail.value) {
    e.stopPropagation()
    detail.value = null
  } else if (ctx.value) {
    e.stopPropagation()
    ctx.value = null
  }
}

function triggerPulse(): void {
  pulse.value = false
  requestAnimationFrame(() => {
    pulse.value = true
    if (pulseTimer) clearTimeout(pulseTimer)
    pulseTimer = setTimeout(() => (pulse.value = false), 220)
  })
}

function focusSearch(): void {
  requestAnimationFrame(() => searchRef.value?.focus())
}

const flat = computed(() => store.visiblePlugins)

watch(
  () => store.query,
  () => {
    store.selIndex = 0
  }
)

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (flat.value.length) store.selIndex = (store.selIndex + 1) % flat.value.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (flat.value.length) store.selIndex = (store.selIndex - 1 + flat.value.length) % flat.value.length
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const target = flat.value[store.selIndex] ?? flat.value[0]
    if (target) void open(target)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    void window.panel.hidePanel()
  } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
    store.selIndex = 0
  }
}

async function open(plugin: PluginSummary): Promise<void> {
  const result = await window.panel.openPlugin(plugin.id, store.query.trim() || undefined)
  if (!result.ok && result.message) message.error(result.message)
}

async function togglePin(plugin: PluginSummary): Promise<void> {
  plugin.pinned = !plugin.pinned
  await window.panel.pin(plugin.id, plugin.pinned)
}

const ctxItems = computed<ContextMenuItem[]>(() => {
  if (!ctx.value) return []
  const p = ctx.value.plugin
  const items: ContextMenuItem[] = [
    { key: 'open', label: '打开', icon: 'play', action: () => void open(p) },
    {
      key: 'pin',
      label: p.pinned ? '取消固定' : '固定到已固定',
      icon: p.pinned ? 'pin-off' : 'pin',
      action: () => void togglePin(p)
    },
    { key: 'detail', label: '应用详情…', icon: 'info', action: () => (detail.value = p) }
  ]
  if (p.type === 'external') {
    items.push({ key: 'edit', label: '编辑启动命令…', icon: 'pencil', action: () => (edit.value = p) })
  }
  items.push({
    key: 'search-web',
    label: '在浏览器搜索此名称',
    icon: 'external-link',
    action: () => {
      const url = `https://www.bing.com/search?q=${encodeURIComponent(p.name)}`
      void window.open(url, '_blank')
    }
  })
  return items
})

function onTileCtx(plugin: PluginSummary, pos: { x: number; y: number }): void {
  ctx.value = { plugin, x: pos.x, y: pos.y }
}
</script>

<template>
  <div class="panel" :class="{ pulse }">
    <template v-if="store.view === 'home'">
      <header class="search-row">
        <AppIcon class="search-icon" name="search" :size="20" />
        <input
          ref="searchRef"
          v-model="store.query"
          class="search"
          type="text"
          placeholder="搜索功能 / 粘贴文件、图片"
          spellcheck="false"
          @keydown="onKeydown"
        />
        <button class="icon-btn" title="设置" @click="store.view = 'settings'">
          <AppIcon name="settings" :size="19" />
        </button>
        <div class="avatar" title="QuickLauncher">
          <AppIcon name="user" :size="19" />
        </div>
      </header>

      <main class="body">
        <template v-if="store.query.trim()">
          <h3 class="section-title">搜索结果</h3>
          <div class="grid">
            <AppTile
              v-for="(p, i) in flat"
              :key="p.id"
              :plugin="p"
              :selected="i === store.selIndex"
              @open="open(p)"
              @hover="store.selIndex = i"
              @pin="togglePin(p)"
              @ctx="(pos) => onTileCtx(p, pos)"
            />
          </div>
          <p v-if="!flat.length" class="empty">没有匹配的功能，换个关键词试试（支持通配符 * 与 re: 正则）</p>
        </template>
        <template v-else>
          <section v-if="store.pinned.length">
            <h3 class="section-title">已固定</h3>
            <div class="grid">
              <AppTile
                v-for="p in store.pinned"
                :key="'pin-' + p.id"
                :plugin="p"
                :selected="false"
                @open="open(p)"
                @pin="togglePin(p)"
                @ctx="(pos) => onTileCtx(p, pos)"
              />
            </div>
          </section>
          <section>
            <h3 class="section-title between">
              <span>全部应用</span>
              <button class="manage-link" title="查看全部应用" @click="store.view = 'apps'">
                全部
                <AppIcon name="chevron-right" :size="13" />
              </button>
            </h3>
            <div class="grid">
              <AppTile
                v-for="(p, i) in flat"
                :key="p.id"
                :plugin="p"
                :selected="i === store.selIndex"
                @open="open(p)"
                @hover="store.selIndex = i"
                @pin="togglePin(p)"
                @ctx="(pos) => onTileCtx(p, pos)"
              />
            </div>
          </section>
        </template>
      </main>

      <footer class="foot">↑↓ 选择 · Enter 打开 · 右键 更多操作 · Esc 隐藏</footer>
    </template>

    <AppManage
      v-else-if="store.view === 'apps'"
      @back="store.view = 'home'; focusSearch()"
      @open="open($event)"
      @pin="togglePin($event)"
      @detail="detail = $event"
    />

    <SettingsView v-else @back="store.view = 'home'; focusSearch()" />

    <ContextMenu v-if="ctx" :x="ctx.x" :y="ctx.y" :items="ctxItems" @close="ctx = null" />
    <PluginDetail
      v-if="detail"
      :plugin="detail"
      @close="detail = null"
      @open="open(detail); detail = null"
      @edit="edit = detail; detail = null"
    />
    <ExternalEdit v-if="edit" :plugin="edit" @close="edit = null" />
  </div>
</template>

<style scoped>
.panel {
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 16px;
  border: 1px solid rgba(0, 0, 0, 0.06);
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.2);
  overflow: hidden;
}

.panel.pulse {
  animation: panel-pop 0.2s ease;
}

@keyframes panel-pop {
  from {
    transform: scale(0.97);
    opacity: 0.55;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}

.search-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 20px 20px 14px;
}

.search-icon {
  color: #8f959e;
  flex: none;
}

.search {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  font-size: 20px;
  color: #1f2329;
  background: transparent;
}

.search::placeholder {
  color: #b4b8bf;
}

.icon-btn {
  flex: none;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  color: #646a73;
}

.icon-btn:hover {
  background: #f2f3f5;
  color: #1f2329;
}

.avatar {
  flex: none;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  color: #fff;
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: 4px 18px 8px;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
  margin: 10px 4px 10px;
}

.section-title.between {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.manage-link {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 12px;
  font-weight: 400;
  color: #8f959e;
  padding: 3px 8px;
  border-radius: 7px;
}

.manage-link:hover {
  background: #f2f3f5;
  color: #4f46e5;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(86px, 1fr));
  gap: 6px 4px;
  margin-bottom: 10px;
}

.empty {
  color: #8f959e;
  font-size: 13px;
  text-align: center;
  padding: 40px 0;
}

.foot {
  flex: none;
  text-align: center;
  font-size: 11px;
  color: #b4b8bf;
  padding: 7px 0 9px;
  border-top: 1px solid #f5f6f7;
  user-select: none;
}
</style>
