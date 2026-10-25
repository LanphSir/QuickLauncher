<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useMessage } from 'naive-ui'
import { useLauncherStore } from '../stores/launcher'
import AppTile from './AppTile.vue'
import SettingsView from './SettingsView.vue'

const store = useLauncherStore()
const message = useMessage()
const searchRef = ref<HTMLInputElement | null>(null)

onMounted(async () => {
  await store.load()
  window.panel.onShown(() => {
    store.resetHome()
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
  focusSearch()
})

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
  const result = await window.panel.openPlugin(plugin.id)
  if (!result.ok && result.message) message.error(result.message)
}

async function togglePin(plugin: PluginSummary): Promise<void> {
  plugin.pinned = !plugin.pinned
  await window.panel.pin(plugin.id, plugin.pinned)
}
</script>

<template>
  <div class="panel">
    <template v-if="store.view === 'home'">
      <header class="search-row">
        <svg class="search-icon" viewBox="0 0 24 24" width="20" height="20">
          <path
            d="M10.5 3a7.5 7.5 0 0 1 5.96 12.06l4.24 4.24a1 1 0 0 1-1.42 1.42l-4.24-4.24A7.5 7.5 0 1 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z"
            fill="currentColor"
          />
        </svg>
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
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path
              d="M12 8.5A3.5 3.5 0 1 1 8.5 12 3.5 3.5 0 0 1 12 8.5Zm0 2A1.5 1.5 0 1 0 13.5 12 1.5 1.5 0 0 0 12 10.5Zm8.6 3.1-1.8-.5a7 7 0 0 0 0-2.2l1.8-.5a1 1 0 0 0 .7-1.2l-.8-2.1a1 1 0 0 0-1.2-.6l-1.8.6a7 7 0 0 0-1.9-1.1l.2-1.9A1 1 0 0 0 14.9 3h-2.2a1 1 0 0 0-1 1.1l.2 1.9a7 7 0 0 0-1.9 1.1l-1.8-.6a1 1 0 0 0-1.2.6l-.8 2.1a1 1 0 0 0 .7 1.2l1.8.5a7 7 0 0 0 0 2.2l-1.8.5a1 1 0 0 0-.7 1.2l.8 2.1a1 1 0 0 0 1.2.6l1.8-.6a7 7 0 0 0 1.9 1.1l-.2 1.9a1 1 0 0 0 1 1.1h2.2a1 1 0 0 0 1-1.1l-.2-1.9a7 7 0 0 0 1.9-1.1l1.8.6a1 1 0 0 0 1.2-.6l.8-2.1a1 1 0 0 0-.7-1.2Z"
              fill="currentColor"
            />
          </svg>
        </button>
        <div class="avatar" title="QuickLauncher">
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path
              d="M12 12a4.2 4.2 0 1 0-4.2-4.2A4.2 4.2 0 0 0 12 12Zm0 2.1c-3.3 0-8 1.7-8 5V21h16v-1.9c0-3.3-4.7-5-8-5Z"
              fill="currentColor"
            />
          </svg>
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
            />
          </div>
          <p v-if="!flat.length" class="empty">没有匹配的功能，换个关键词试试</p>
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
              />
            </div>
          </section>
          <section>
            <h3 class="section-title">
              全部应用 <span class="muted">· 插件市场即将上线</span>
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
              />
            </div>
          </section>
        </template>
      </main>
    </template>

    <SettingsView v-else @back="store.view = 'home'; focusSearch()" />
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
  padding: 4px 18px 18px;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
  margin: 10px 4px 10px;
}

.section-title .muted {
  font-weight: 400;
  font-size: 12px;
  color: #8f959e;
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
</style>
