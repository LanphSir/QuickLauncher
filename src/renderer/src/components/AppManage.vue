<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMessage } from 'naive-ui'
import AppIcon from './AppIcon.vue'
import ContextMenu, { type ContextMenuItem } from './ContextMenu.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import { useLauncherStore } from '../stores/launcher'
import { pluginMatch } from '../utils/match'
import { closeOverlay, openOverlay } from '../composables/useOverlay'

const emit = defineEmits<{
  back: []
  open: [plugin: PluginSummary]
  pin: [plugin: PluginSummary]
  detail: [plugin: PluginSummary]
  edit: [plugin: PluginSummary]
  detach: [plugin: PluginSummary]
}>()

const store = useLauncherStore()
const message = useMessage()
const query = ref('')
const installing = ref(false)

const filtered = computed(() => {
  const q = query.value.trim()
  if (!q) return store.plugins
  return store.plugins.filter((p) => pluginMatch(q, p))
})

async function install(mode: 'dir' | 'zip'): Promise<void> {
  installing.value = true
  try {
    const r = await window.panel.installPlugin(mode)
    if (r.canceled) return
    if (r.ok) message.success(r.message ?? '安装成功')
    else message.error(r.message ?? '安装失败')
  } finally {
    installing.value = false
  }
}

async function uninstall(p: PluginSummary): Promise<void> {
  const r = await window.panel.uninstallPlugin(p.id)
  if (r.ok) message.success(r.message ?? '已卸载')
  else message.error(r.message ?? '卸载失败')
}

async function open(p: PluginSummary): Promise<void> {
  if (p.disabled) {
    message.warning('插件已停用，请在 设置 → 插件管理 中启用')
    return
  }
  emit('open', p)
}

/* ---------------- 操作菜单 ---------------- */

/**
 * 一行里的操作全部收进 ···：直接摆一排图标时，"卸载"和"打开"的点击距离只有 12px，
 * 鼠标一抖就是不可逆操作。收进菜单后每个动作都要两步，误触成本归零；
 * 顺带也放得下编辑、独立窗口这些低频但有用的入口。
 */
function menuItemsFor(p: PluginSummary): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    { key: 'open', label: '打开', icon: 'play', action: () => void open(p) },
    {
      key: 'pin',
      label: p.pinned ? '取消固定' : '固定到已固定',
      icon: p.pinned ? 'pin-off' : 'pin',
      action: () => emit('pin', p)
    },
    { key: 'sep-1', separator: true },
    { key: 'detail', label: '应用详情…', icon: 'info', action: () => emit('detail', p) }
  ]

  if (p.type === 'web') {
    items.push({
      key: 'detach',
      label: '在独立窗口打开',
      icon: 'external-link',
      action: () => emit('detach', p)
    })
  }
  if (p.type === 'external') {
    items.push({
      key: 'edit',
      label: p.source === 'shortcut' ? '编辑应用…' : '编辑启动命令…',
      icon: 'pencil',
      action: () => emit('edit', p)
    })
  }
  if (p.source === 'installed') {
    items.push(
      { key: 'sep-2', separator: true },
      { key: 'uninstall', label: '卸载…', icon: 'trash', danger: true, action: () => askUninstall(p) }
    )
  }
  return items
}

function openMenu(p: PluginSummary, pos: { x: number; y: number }): void {
  let id = 0
  id = openOverlay({
    component: ContextMenu,
    backdrop: 'transparent',
    autoFocus: false,
    label: 'manage-menu',
    props: {
      x: pos.x,
      y: pos.y,
      items: menuItemsFor(p),
      onClose: () => closeOverlay(id)
    }
  })
}

/** 菜单按钮：以按钮右下角为锚点，菜单自然展开在手指下方 */
function openMenuFromButton(p: PluginSummary, event: MouseEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  openMenu(p, { x: rect.right - 176, y: rect.bottom + 5 })
}

/** 卸载不可逆，必须有一次看得懂的确认；原生 confirm 与面板风格差太远 */
function askUninstall(p: PluginSummary): void {
  let id = 0
  id = openOverlay({
    component: ConfirmDialog,
    label: 'confirm-uninstall',
    initialFocus: 'first',
    props: {
      title: '卸载这个应用？',
      message: `「${p.name}」的插件文件会被删除，之后它不会再出现在列表里。`,
      hint: '插件自己存的数据（设置、历史记录）会保留，重新安装同 id 的插件还能接上。',
      confirmLabel: '卸载',
      danger: true,
      onClose: () => closeOverlay(id),
      onConfirm: () => {
        closeOverlay(id)
        void uninstall(p)
      }
    }
  })
}
</script>

<template>
  <div class="manage">
    <header class="head">
      <button class="back" @click="emit('back')">
        <AppIcon name="chevron-left" :size="16" />
        返回
      </button>
      <h2>全部应用</h2>
      <span class="count">{{ store.plugins.length }} 个</span>
    </header>

    <div class="toolbar">
      <div class="search-row">
        <AppIcon name="search" :size="15" class="search-icon" />
        <input
          v-model="query"
          class="search"
          type="text"
          placeholder="按名称 / 关键词 / 正则过滤"
          spellcheck="false"
        />
        <button v-if="query" class="clear" title="清空" @click="query = ''">
          <AppIcon name="x" :size="12" />
        </button>
      </div>
      <button class="tool-btn" :disabled="installing" @click="install('dir')">
        <AppIcon name="folder" :size="13" />
        从目录
      </button>
      <button class="tool-btn" :disabled="installing" @click="install('zip')">
        <AppIcon name="file" :size="13" />
        从 ZIP
      </button>
    </div>

    <div class="list">
      <div
        v-for="p in filtered"
        :key="p.id"
        class="item"
        :class="{ disabled: p.disabled }"
        @dblclick="open(p)"
        @contextmenu.prevent="openMenu(p, { x: $event.clientX, y: $event.clientY })"
      >
        <div class="icon">
          <img v-if="p.icon" :src="p.icon" alt="" draggable="false" />
          <span v-else class="fallback-icon"><AppIcon name="grid" :size="18" /></span>
        </div>
        <div class="info">
          <div class="name-row">
            <span class="name">{{ p.name }}</span>
            <span class="badge" :class="p.type">{{ p.type === 'external' ? '外部程序' : '应用' }}</span>
            <span v-if="p.source === 'installed'" class="badge installed">已安装</span>
            <span v-if="p.source === 'shortcut'" class="badge shortcut">自定义</span>
            <span v-if="p.disabled" class="badge off">已停用</span>
            <span v-if="p.version" class="ver">v{{ p.version }}</span>
          </div>
          <div class="meta">{{ p.description || p.id }}</div>
        </div>
        <button class="more" title="更多操作" aria-label="更多操作" @click="openMenuFromButton(p, $event)">
          <span class="dots"><i /><i /><i /></span>
        </button>
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
  background: var(--bg);
  border-radius: var(--r-xl);
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 18px 8px;
}

.head h2 {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.count {
  flex: 1;
  text-align: right;
  font-size: 11.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.back {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 28px;
  padding: 0 10px 0 6px;
  border-radius: var(--r-sm);
  font-size: 12.5px;
  color: var(--text-2);
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}

.back:hover {
  background: var(--bg-hover);
  color: var(--text-1);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 4px 18px 10px;
}

.search-row {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--bg);
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}

.search-row:focus-within {
  border-color: var(--accent-line);
  box-shadow: var(--ring);
}

.search-icon {
  flex: none;
  color: var(--text-3);
}

.search {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font-size: 12.5px;
  color: var(--text-1);
}

/* 焦点指示由外层 .search-row:focus-within 负责，这里再来一圈就重了 */
.search:focus-visible {
  box-shadow: none;
}

.search::placeholder {
  color: var(--text-4);
}

.clear {
  flex: none;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  color: var(--text-3);
}

.clear:hover {
  background: var(--bg-hover);
  color: var(--text-1);
}

.tool-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 9px;
  font-size: 12px;
  color: var(--text-2);
  transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.tool-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  border-color: var(--line-strong);
  color: var(--text-1);
}

.tool-btn:disabled {
  opacity: 0.45;
}

.list {
  flex: 1;
  overflow-y: auto;
  padding: 0 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.item {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 7px 8px;
  border-radius: var(--r-md);
  cursor: default;
  transition: background var(--dur) var(--ease);
}

.item:hover {
  background: var(--bg-hover);
}

.item.disabled {
  opacity: 0.55;
}

.icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  overflow: hidden;
}

.icon img {
  width: 28px;
  height: 28px;
  object-fit: contain;
}

.fallback-icon {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  color: #fff;
  background: linear-gradient(135deg, var(--accent), #8b5cf6);
}

.info {
  flex: 1;
  min-width: 0;
}

.name-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-1);
}

.badge {
  flex: none;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-size: 10px;
  line-height: 16px;
}

.badge.external {
  background: var(--warn-soft);
  color: var(--warn);
}

.badge.installed {
  background: var(--ok-soft);
  color: var(--ok);
}

.badge.shortcut {
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.badge.off {
  background: var(--bg-active);
  color: var(--text-3);
}

.ver {
  font-size: 10px;
  color: var(--text-4);
  font-family: ui-monospace, Consolas, monospace;
}

.meta {
  margin-top: 1px;
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ···：常驻但很淡，hover/聚焦才变实——完全隐藏会让"这里有操作"这件事没人发现 */
.more {
  flex: none;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  color: var(--text-3);
  opacity: 0.35;
  transition: opacity var(--dur) var(--ease), background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.item:hover .more,
.more:focus-visible {
  opacity: 1;
}

.more:hover {
  background: var(--bg-active);
  color: var(--text-1);
}

.dots {
  display: flex;
  gap: 1.5px;
}

.dots i {
  width: 2.5px;
  height: 2.5px;
  border-radius: 50%;
  background: currentColor;
}

.empty {
  padding: 40px 0;
  text-align: center;
  font-size: 12.5px;
  color: var(--text-3);
}
</style>
