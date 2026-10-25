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
const pinned = ref(false)
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
  window.panel.onPluginsChanged(() => {
    void store.load()
  })
  window.panel.onPinnedChanged((value) => {
    pinned.value = value
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

/** 置顶钉住：点击面板外不自动收起（Esc/快捷键仍可隐藏） */
async function togglePinWindow(): Promise<void> {
  const r = await window.panel.togglePinned()
  pinned.value = r.pinned
}

async function detach(plugin: PluginSummary): Promise<void> {
  const r = await window.panel.detachPlugin(plugin.id)
  if (!r.ok && r.message) message.error(r.message)
}

// —— 自实现窗口缩放：透明无边框窗口不支持系统边缘缩放 ——
const MIN_W = 520
const MIN_H = 400

async function startResize(e: PointerEvent, handle: string): Promise<void> {
  e.preventDefault()
  const el = e.currentTarget as HTMLElement
  const start = await window.panel.getWindowBounds()
  if (!start) return
  const sx = e.screenX
  const sy = e.screenY
  let raf = 0
  const apply = (ev: PointerEvent): void => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      const dx = ev.screenX - sx
      const dy = ev.screenY - sy
      let { x, y, width, height } = start
      if (handle.includes('e')) width = Math.max(MIN_W, start.width + dx)
      if (handle.includes('s')) height = Math.max(MIN_H, start.height + dy)
      if (handle.includes('w')) {
        width = Math.max(MIN_W, start.width - dx)
        x = start.x + (start.width - width)
      }
      if (handle.includes('n')) {
        height = Math.max(MIN_H, start.height - dy)
        y = start.y + (start.height - height)
      }
      void window.panel.setWindowBounds({
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height)
      })
    })
  }
  const up = (): void => {
    el.removeEventListener('pointermove', apply)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('pointercancel', up)
    void window.panel.saveWindowBounds()
  }
  el.setPointerCapture(e.pointerId)
  el.addEventListener('pointermove', apply)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
}

const RESIZE_HANDLES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const

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
    }
  ]
  if (p.type === 'web') {
    items.push({
      key: 'detach',
      label: '在独立窗口打开',
      icon: 'external-link',
      action: () => void detach(p)
    })
  }
  items.push({ key: 'detail', label: '应用详情…', icon: 'info', action: () => (detail.value = p) })
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
  <div class="shell">
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
        <button
          class="icon-btn"
          :class="{ active: pinned }"
          :title="pinned ? '取消置顶' : '置顶固定：点击面板外不自动收起'"
          @click="togglePinWindow"
        >
          <AppIcon name="pin" :size="17" />
        </button>
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
      @detach="detach(detail); detail = null"
    />
    <ExternalEdit v-if="edit" :plugin="edit" @close="edit = null" />
    <!-- 缩放热区必须排在 drag 区元素之后：Electron 按文档顺序做 drag 加/no-drag 减，
         热区放前面会被搜索行后续加回的 drag 矩形覆盖（表现为顶边只能移动不能缩放） -->
    <span
      v-for="h in RESIZE_HANDLES"
      :key="h"
      class="rz"
      :class="`rz-${h}`"
      @pointerdown="startResize($event, h)"
    />
    </div>
  </div>
</template>

<style scoped>
.shell {
  position: relative;
  /* 不能用 height:100%——naive-ui 的 Provider 包裹 div 无高度，会导致卡片比窗口矮、
     底边缩放热区悬空；100vh 直接锚定窗口视口 */
  height: 100vh;
  width: 100%;
}

/* 8 向缩放热区：透明无边框窗口不支持系统边缘缩放，自实现。
   必须显式 no-drag：搜索行的 drag 区从面板 y=0 开始，会把顶边热区吞进"移动窗口"；
   drag region 计算是 drag 矩形减 no-drag 矩形，与层叠顺序无关。 */
.rz {
  position: absolute;
  z-index: 40;
  touch-action: none;
  -webkit-app-region: no-drag;
}

.rz-n,
.rz-s {
  left: 10px;
  right: 10px;
  height: 5px;
  cursor: ns-resize;
}

.rz-e,
.rz-w {
  top: 10px;
  bottom: 10px;
  width: 5px;
  cursor: ew-resize;
}

.rz-n {
  top: 0;
}

.rz-s {
  bottom: 0;
}

.rz-e {
  right: 0;
}

.rz-w {
  left: 0;
}

.rz-ne,
.rz-nw,
.rz-se,
.rz-sw {
  width: 12px;
  height: 12px;
}

.rz-ne {
  top: 0;
  right: 0;
  cursor: nesw-resize;
}

.rz-nw {
  top: 0;
  left: 0;
  cursor: nwse-resize;
}

.rz-se {
  bottom: 0;
  right: 0;
  cursor: nwse-resize;
}

.rz-sw {
  bottom: 0;
  left: 0;
  cursor: nesw-resize;
}

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
  /* 无边框窗口拖拽区：搜索行空白处可拖动窗口 */
  -webkit-app-region: drag;
}

.search-row input,
.search-row button,
.search-row .avatar {
  -webkit-app-region: no-drag;
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

.icon-btn.active {
  background: #eef0fe;
  color: #6366f1;
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
