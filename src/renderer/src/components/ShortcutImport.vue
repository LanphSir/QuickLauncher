<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, useMessage } from 'naive-ui'
import AppIcon from './AppIcon.vue'

/**
 * 从开始菜单/桌面导入（内容组件，遮罩/焦点由 OverlayHost 统一管）。
 *
 * 默认一个都不勾：候选动辄几十个，全选等于把开始菜单复制一遍，
 * 用户还得回头一个个删——"先挑想要的"比"先全要"省事。
 */
const emit = defineEmits<{ close: []; imported: [count: number] }>()

const message = useMessage()
const loading = ref(true)
const importing = ref(false)
const candidates = ref<ShortcutCandidate[]>([])
const checked = ref<Set<string>>(new Set())
const query = ref('')

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return candidates.value
  return candidates.value.filter(
    (c) => c.name.toLowerCase().includes(q) || c.group.toLowerCase().includes(q)
  )
})

/** 分组顺序沿用主进程给的（已按名称排过），只保留过滤后非空的组 */
const groups = computed(() => {
  const map = new Map<string, ShortcutCandidate[]>()
  for (const c of filtered.value) {
    const list = map.get(c.group)
    if (list) list.push(c)
    else map.set(c.group, [c])
  }
  return [...map.entries()].map(([group, items]) => ({ group, items }))
})

const checkedCount = ref(0)
function syncCount(): void {
  checkedCount.value = checked.value.size
}

function toggle(item: ShortcutCandidate): void {
  const next = new Set(checked.value)
  if (next.has(item.path)) next.delete(item.path)
  else next.add(item.path)
  checked.value = next
  syncCount()
}

function toggleGroup(items: ShortcutCandidate[]): void {
  const allOn = items.every((i) => checked.value.has(i.path))
  const next = new Set(checked.value)
  for (const item of items) {
    if (allOn) next.delete(item.path)
    else next.add(item.path)
  }
  checked.value = next
  syncCount()
}

function selectAll(): void {
  checked.value = new Set(filtered.value.map((c) => c.path))
  syncCount()
}

function clearAll(): void {
  checked.value = new Set()
  syncCount()
}

async function load(): Promise<void> {
  loading.value = true
  try {
    candidates.value = await window.panel.scanShortcutCandidates()
  } catch (err) {
    message.error(`扫描失败：${(err as Error).message}`)
  } finally {
    loading.value = false
  }
}

async function doImport(): Promise<void> {
  if (!checkedCount.value || importing.value) return
  importing.value = true
  try {
    const items = candidates.value
      .filter((c) => checked.value.has(c.path))
      .map((c) => ({ path: c.path, name: c.name }))
    const r = await window.panel.importShortcuts(items)
    if (r.ok) {
      message.success(`已导入 ${r.created} 个应用${r.skipped ? `，${r.skipped} 个跳过` : ''}`)
      emit('imported', r.created)
      emit('close')
    } else {
      message.error(r.message ?? '导入失败')
    }
  } finally {
    importing.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="modal">
    <header class="head">
      <h2>从系统导入</h2>
      <button class="close" title="关闭" @click="emit('close')">
        <AppIcon name="x" :size="16" />
      </button>
    </header>
    <p class="desc">扫描开始菜单与桌面里的快捷方式。已导入过的不会重复出现。</p>

    <div class="toolbar">
      <div class="search-row">
        <AppIcon name="search" :size="14" class="search-icon" />
        <input v-model="query" class="search" type="text" placeholder="过滤名称" spellcheck="false" />
      </div>
      <button class="link" @click="selectAll">全选</button>
      <button class="link" @click="clearAll">清空</button>
    </div>

    <div class="body">
      <p v-if="loading" class="empty">正在扫描开始菜单与桌面…</p>
      <p v-else-if="!candidates.length" class="empty">
        没找到可导入的快捷方式（开始菜单/桌面里没有 .lnk 或 .url）。
      </p>
      <p v-else-if="!groups.length" class="empty">没有匹配「{{ query }}」的项。</p>
      <div v-for="g in groups" :key="g.group" class="group">
        <div class="group-head">
          <span class="group-name">{{ g.group }}</span>
          <button class="link small" @click="toggleGroup(g.items)">
            {{ g.items.every((i) => checked.has(i.path)) ? '取消本组' : '选本组' }}
          </button>
        </div>
        <label v-for="item in g.items" :key="item.path" class="item">
          <input type="checkbox" :checked="checked.has(item.path)" @change="toggle(item)" />
          <span class="name">{{ item.name }}</span>
          <span v-if="item.kind === 'url'" class="tag">网址</span>
          <span class="path">{{ item.path }}</span>
        </label>
      </div>
    </div>

    <footer class="foot">
      <NButton
        size="small"
        type="primary"
        :disabled="!checkedCount"
        :loading="importing"
        @click="doImport"
      >
        导入{{ checkedCount ? ` ${checkedCount} 个` : '' }}
      </NButton>
      <NButton size="small" quaternary @click="emit('close')">取消</NButton>
      <span class="spacer" />
      <span class="count">共 {{ candidates.length }} 个候选</span>
    </footer>
  </div>
</template>

<style scoped>
.modal {
  width: 560px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 80px);
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 16px;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.24);
  padding: 20px;
  animation: pop 0.16s ease;
}

@keyframes pop {
  from {
    transform: scale(0.96);
    opacity: 0.5;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}

.head {
  display: flex;
  align-items: center;
}

.head h2 {
  flex: 1;
  font-size: 16px;
  font-weight: 600;
}

.close {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  color: #a1a6ad;
}

.close:hover {
  background: #f2f3f5;
  color: #1f2329;
}

.desc {
  margin-top: 8px;
  font-size: 12.5px;
  color: #8f959e;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.search-row {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 9px;
  border: 1px solid #dfe1e4;
  border-radius: 8px;
}

.search-row:focus-within {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
}

.search-icon {
  color: #a1a6ad;
}

.search {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  font-size: 12.5px;
  background: transparent;
}

.link {
  flex: none;
  font-size: 12px;
  color: #6366f1;
  padding: 4px 6px;
  border-radius: 6px;
}

.link:hover {
  background: #eef0ff;
}

.link.small {
  font-size: 11px;
}

.body {
  flex: 1;
  min-height: 180px;
  max-height: 46vh;
  overflow-y: auto;
  margin-top: 10px;
  border: 1px solid #eceeef;
  border-radius: 10px;
  padding: 6px 10px;
}

.empty {
  padding: 22px 0;
  text-align: center;
  font-size: 12.5px;
  color: #a1a6ad;
}

.group + .group {
  margin-top: 8px;
  border-top: 1px solid #f5f6f7;
  padding-top: 6px;
}

.group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}

.group-name {
  flex: 1;
  font-size: 11.5px;
  color: #8f959e;
}

.item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 4px;
  border-radius: 7px;
  cursor: pointer;
}

.item:hover {
  background: #f7f8f9;
}

.item input {
  accent-color: #6366f1;
}

.name {
  font-size: 12.5px;
  color: #1f2329;
  flex: none;
  max-width: 240px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tag {
  flex: none;
  font-size: 10px;
  padding: 0.5px 6px;
  border-radius: 999px;
  background: #eef0ff;
  color: #4f46e5;
}

.path {
  flex: 1;
  min-width: 0;
  font-size: 10.5px;
  color: #b8bcc2;
  font-family: ui-monospace, Consolas, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}

.foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}

.spacer {
  flex: 1;
}

.count {
  font-size: 11.5px;
  color: #a1a6ad;
}
</style>
