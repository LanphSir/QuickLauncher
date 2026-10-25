<script setup lang="ts">
import { computed, ref } from 'vue'
import AppIcon from './AppIcon.vue'
import { useLauncherStore } from '../stores/launcher'
import { pluginMatch } from '../utils/match'

const emit = defineEmits<{
  back: []
  open: [plugin: PluginSummary]
  pin: [plugin: PluginSummary]
  detail: [plugin: PluginSummary]
}>()

const store = useLauncherStore()
const query = ref('')

const filtered = computed(() => {
  const q = query.value.trim()
  if (!q) return store.plugins
  return store.plugins.filter((p) => pluginMatch(q, p))
})
</script>

<template>
  <div class="manage">
    <header class="head">
      <button class="back" @click="emit('back')">
        <AppIcon name="chevron-left" :size="16" />
        返回
      </button>
      <h2>全部应用</h2>
      <span class="count">共 {{ store.plugins.length }} 个 · 插件市场即将上线</span>
    </header>

    <div class="search-row">
      <AppIcon name="search" :size="16" class="search-icon" />
      <input
        v-model="query"
        class="search"
        type="text"
        placeholder="按名称 / 关键词 / 正则过滤"
        spellcheck="false"
      />
    </div>

    <div class="list">
      <div v-for="p in filtered" :key="p.id" class="item" @dblclick="emit('open', p)">
        <div class="icon">
          <img v-if="p.icon" :src="p.icon" alt="" draggable="false" />
          <span v-else class="fallback-icon"><AppIcon name="grid" :size="18" /></span>
        </div>
        <div class="info">
          <div class="name-row">
            <span class="name">{{ p.name }}</span>
            <span class="badge" :class="p.type">{{ p.type === 'external' ? '外部程序' : '应用' }}</span>
            <span v-if="p.version" class="ver">v{{ p.version }}</span>
          </div>
          <div class="meta">{{ p.description || p.id }}</div>
        </div>
        <div class="actions">
          <button class="act primary" title="打开" @click="emit('open', p)">
            <AppIcon name="play" :size="14" />
          </button>
          <button
            class="act"
            :class="{ active: p.pinned }"
            :title="p.pinned ? '取消固定' : '固定'"
            @click="emit('pin', p)"
          >
            <AppIcon :name="p.pinned ? 'pin' : 'pin-off'" :size="14" />
          </button>
          <button class="act" title="应用详情" @click="emit('detail', p)">
            <AppIcon name="info" :size="14" />
          </button>
        </div>
      </div>
      <p v-if="!filtered.length" class="empty">没有匹配的应用</p>
    </div>
  </div>
</template>

<style scoped>
.manage {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 16px;
  border: 1px solid rgba(0, 0, 0, 0.06);
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.2);
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 20px 10px;
}

.head h2 {
  font-size: 17px;
  font-weight: 600;
}

.count {
  flex: 1;
  text-align: right;
  font-size: 12px;
  color: #8f959e;
}

.back {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 13px;
  color: #646a73;
  padding: 5px 10px 5px 6px;
  border-radius: 8px;
}

.back:hover {
  background: #f2f3f5;
  color: #1f2329;
}

.search-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 20px 10px;
  padding: 0 12px;
  height: 34px;
  border: 1px solid #eceeef;
  border-radius: 10px;
}

.search-row:focus-within {
  border-color: #6366f1;
}

.search-icon {
  color: #a1a6ad;
  flex: none;
}

.search {
  flex: 1;
  border: none;
  outline: none;
  font-size: 13px;
  background: transparent;
  color: #1f2329;
}

.list {
  flex: 1;
  overflow-y: auto;
  padding: 2px 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border-radius: 10px;
  cursor: default;
}

.item:hover {
  background: #f5f6f7;
}

.icon {
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: 9px;
  display: grid;
  place-items: center;
  overflow: hidden;
}

.icon img {
  width: 30px;
  height: 30px;
  object-fit: contain;
}

.fallback-icon {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 9px;
  color: #fff;
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
}

.info {
  flex: 1;
  min-width: 0;
}

.name-row {
  display: flex;
  align-items: center;
  gap: 7px;
}

.name {
  font-size: 13.5px;
  font-weight: 500;
}

.badge {
  font-size: 10.5px;
  padding: 1px 7px;
  border-radius: 999px;
  background: #eef0fe;
  color: #4f46e5;
}

.badge.external {
  background: #fef3e2;
  color: #b25e09;
}

.ver {
  font-size: 10.5px;
  color: #a1a6ad;
  font-family: ui-monospace, Consolas, monospace;
}

.meta {
  margin-top: 2px;
  font-size: 11.5px;
  color: #8f959e;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.actions {
  flex: none;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.12s;
}

.item:hover .actions {
  opacity: 1;
}

.act {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  color: #646a73;
}

.act:hover {
  background: #e9eaec;
  color: #1f2329;
}

.act.primary {
  color: #4f46e5;
}

.act.active {
  color: #6366f1;
  background: #eef0fe;
}

.empty {
  text-align: center;
  color: #a1a6ad;
  font-size: 13px;
  padding: 40px 0;
}
</style>
