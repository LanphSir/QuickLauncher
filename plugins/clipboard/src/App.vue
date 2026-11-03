<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import PopMenu from '../../../src/shared/ui/PopMenu.vue'
import ConfirmDialog from '../../../src/shared/ui/ConfirmDialog.vue'
import { MENU_W, type MenuItem } from '../../../src/shared/ui/menu'

interface ClipItem {
  text: string
  ts: number
}

/** 一次待确认的破坏性操作：把「要做什么」连同文案一起存下来，确认后才执行 */
interface PendingConfirm {
  title: string
  message: string
  hint?: string
  confirmLabel: string
  run: () => void
}

const MAX_ITEMS = 100
const items = ref<ClipItem[]>([])
const copiedTs = ref<number | null>(null)
const menu = ref<{ x: number; y: number; item: ClipItem | null } | null>(null)
const confirm = ref<PendingConfirm | null>(null)
let timer: ReturnType<typeof setInterval> | undefined
let last = ''

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  const saved = await window.appapi.storage.get('history')
  if (Array.isArray(saved)) items.value = saved as ClipItem[]
  last = (await window.appapi.clipboard.readText()) ?? ''
  // 视图退出后只缓存不销毁，onUnmounted 不会再触发；轮询改由可见性事件控制，
  // 切走/收起面板时立刻停（不空转、不读剪贴板），回来时补一次并继续。
  window.appapi.onShow(() => {
    void poll()
    startPolling()
  })
  window.appapi.onHide(stopPolling)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  stopPolling()
})

function startPolling(): void {
  if (timer) return
  timer = setInterval(poll, 800)
}

function stopPolling(): void {
  if (!timer) return
  clearInterval(timer)
  timer = undefined
}

function onKeydown(e: KeyboardEvent): void {
  // 菜单/确认框自己处理 Esc（捕获阶段），这里只负责「没有浮层时退出插件」
  if (e.key !== 'Escape') return
  if (menu.value || confirm.value) return
  void window.appapi.exit()
}

function exit(): void {
  void window.appapi.exit()
}

async function poll(): Promise<void> {
  try {
    const text = await window.appapi.clipboard.readText()
    if (text && text !== last) {
      last = text
      push(text)
    }
  } catch {
    /* 剪贴板权限异常时静默 */
  }
}

function push(text: string): void {
  if (items.value[0]?.text === text) return
  items.value = [{ text, ts: Date.now() }, ...items.value].slice(0, MAX_ITEMS)
  void save()
}

/** contextBridge 传参会结构化克隆，Vue Proxy 不能直接传，先转纯数据 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

async function save(): Promise<void> {
  try {
    await window.appapi.storage.set('history', plain(items.value))
  } catch {
    /* ignore */
  }
}

async function copy(item: ClipItem): Promise<void> {
  await window.appapi.clipboard.writeText(item.text)
  copiedTs.value = item.ts
  void window.appapi.notify('剪贴板历史', '内容已复制到剪贴板')
  setTimeout(() => {
    copiedTs.value = null
  }, 800)
}

async function removeItem(item: ClipItem): Promise<void> {
  items.value = items.value.filter((x) => x.ts !== item.ts)
  await save()
}

async function clearAll(): Promise<void> {
  items.value = []
  await save()
}

function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > 90 ? oneLine.slice(0, 90) + '…' : oneLine
}

// ---------- 浮层菜单 ----------

/** 同一套菜单给 `···` 按钮和右键共用：按钮按右边缘对齐，右键跟随光标 */
function openMenu(item: ClipItem, event: MouseEvent): void {
  const isContextMenu = event.type === 'contextmenu'
  if (isContextMenu) {
    menu.value = { x: event.clientX, y: event.clientY, item }
    return
  }
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const rightAligned = rect.right - MENU_W
  menu.value = { x: rightAligned < 8 ? rect.left : rightAligned, y: rect.bottom + 5, item }
}

/** 页面级 `···`：只有「清空全部」这一个破坏性动作，不占页头按钮位 */
function openPageMenu(event: MouseEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const rightAligned = rect.right - MENU_W
  menu.value = { x: rightAligned < 8 ? rect.left : rightAligned, y: rect.bottom + 5, item: null }
}

function menuItems(item: ClipItem | null): MenuItem[] {
  if (!item) {
    return [{ key: 'clear', label: '清空全部记录', icon: 'delete', danger: true, disabled: items.value.length === 0 }]
  }
  return [
    { key: 'copy', label: '复制这一条', icon: 'copy' },
    { key: 'delete', label: '删除这一条', icon: 'delete', danger: true }
  ]
}

function onMenuPick(key: string): void {
  const target = menu.value?.item ?? null
  menu.value = null
  if (key === 'clear') {
    askConfirm({
      title: '清空剪贴板历史？',
      message: `将删除全部 ${items.value.length} 条记录。`,
      hint: '只清空本应用记录的历史，系统剪贴板当前内容不受影响。',
      confirmLabel: '清空',
      run: () => void clearAll()
    })
    return
  }
  if (!target) return
  if (key === 'copy') {
    void copy(target)
    return
  }
  if (key === 'delete') {
    askConfirm({
      title: '删除这条记录？',
      message: preview(target.text),
      confirmLabel: '删除',
      run: () => void removeItem(target)
    })
  }
}

function askConfirm(state: PendingConfirm): void {
  confirm.value = state
}

function runConfirm(): void {
  const state = confirm.value
  confirm.value = null
  state?.run()
}
</script>

<template>
  <div class="pl-page">
    <header class="pl-head">
      <button class="pl-btn" @click="exit"><span class="arrow">‹</span> 返回</button>
      <h1 class="pl-title">剪贴板历史</h1>
      <button class="pl-icon-btn" title="更多操作" @click.stop="openPageMenu($event)">
        <span class="pl-dots">···</span>
      </button>
    </header>

    <p class="hint">自动记录复制的文本（最近 {{ MAX_ITEMS }} 条）· 点击条目重新复制 · Esc 返回</p>

    <ul v-if="items.length" class="pl-list">
      <li
        v-for="item in items"
        :key="item.ts"
        class="pl-row tile clip-item"
        :class="{ copied: copiedTs === item.ts }"
        @click="copy(item)"
        @contextmenu.prevent="openMenu(item, $event)"
      >
        <span class="pl-row-main">{{ preview(item.text) }}</span>
        <button class="pl-icon-btn" title="更多操作" @click.stop="openMenu(item, $event)">
          <span class="pl-dots">···</span>
        </button>
      </li>
    </ul>
    <p v-else class="pl-empty">
      暂无记录
      <span class="sub">去别的窗口复制点内容，这里会自动收进来</span>
    </p>

    <PopMenu v-if="menu" :x="menu.x" :y="menu.y" :items="menuItems(menu.item)" @pick="onMenuPick" @close="menu = null" />
    <ConfirmDialog
      v-if="confirm"
      :title="confirm.title"
      :message="confirm.message"
      :hint="confirm.hint"
      :confirm-label="confirm.confirmLabel"
      danger
      @confirm="runConfirm"
      @cancel="confirm = null"
    />
  </div>
</template>

<style>
/* 骨架与控件来自 plugin-ui.css，这里只写剪贴板特有的部分 */
.hint {
  flex: none;
  margin: 2px 0 8px;
  text-align: center;
  font-size: 11px;
  color: var(--text-3);
}

.clip-item.copied {
  background: var(--accent-soft);
  border-color: var(--accent-line);
}

.pl-row-main {
  font-size: 13px;
  line-height: 1.5;
}
</style>
