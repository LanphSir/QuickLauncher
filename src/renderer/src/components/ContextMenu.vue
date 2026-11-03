<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import AppIcon from './AppIcon.vue'
import type { IconName } from './icons'

/**
 * 宿主侧的浮层菜单（右键 / ···）。
 *
 * 位置不按固定行高估算，而是挂载后测量实际尺寸再定向：
 * 菜单项可能有分隔线、可能换行、将来还可能带副标题，用 `itemCount * 34` 算
 * 迟早会在某个组合下把菜单顶出窗口。
 */

export interface ContextMenuItem {
  key: string
  label?: string
  icon?: IconName
  danger?: boolean
  /** 右侧灰色提示，比如 Enter、Ctrl+Enter */
  hint?: string
  /** 分隔线：为 true 时其余字段忽略 */
  separator?: boolean
  action?: () => void
}

const props = defineProps<{
  x: number
  y: number
  items: ContextMenuItem[]
}>()

const emit = defineEmits<{ close: [] }>()

const el = ref<HTMLElement | null>(null)
/** 先按原坐标渲染一次（不可见），量到尺寸后再定位，避免闪一帧在错误位置 */
const pos = ref({ left: props.x, top: props.y, ready: false })
const origin = ref('top left')

const realItems = computed(() => props.items.filter((item) => !item.separator))

onMounted(() => {
  void nextTick(() => {
    const node = el.value
    if (!node) return
    const rect = node.getBoundingClientRect()
    const pad = 8
    const vw = window.innerWidth
    const vh = window.innerHeight

    let left = props.x
    let top = props.y
    // 右边放不下就翻到光标左侧；翻完还放不下就贴边（贴边总比被裁掉好）
    if (left + rect.width > vw - pad) left = Math.max(pad, props.x - rect.width)
    if (top + rect.height > vh - pad) top = Math.max(pad, props.y - rect.height)

    origin.value = `${top < props.y ? 'bottom' : 'top'} ${left < props.x ? 'right' : 'left'}`
    pos.value = { left, top, ready: true }
  })
})

function run(item: ContextMenuItem): void {
  if (item.separator) return
  item.action?.()
  emit('close')
}
</script>

<template>
  <div
    ref="el"
    class="ctx-menu"
    :class="{ ready: pos.ready }"
    :style="{ left: `${pos.left}px`, top: `${pos.top}px`, transformOrigin: origin }"
    role="menu"
  >
    <template v-for="item in items" :key="item.key">
      <div v-if="item.separator" class="ctx-sep" role="separator" />
      <button
        v-else
        class="ctx-item"
        :class="{ danger: item.danger }"
        role="menuitem"
        @click="run(item)"
      >
        <AppIcon v-if="item.icon" class="ctx-icon" :name="item.icon" :size="15" />
        <span class="ctx-label">{{ item.label }}</span>
        <span v-if="item.hint" class="ctx-hint">{{ item.hint }}</span>
      </button>
    </template>
    <!-- 全是分隔线时不至于渲染出一张空卡片 -->
    <p v-if="!realItems.length" class="ctx-empty">没有可用操作</p>
  </div>
</template>

<style scoped>
.ctx-menu {
  position: fixed;
  min-width: 176px;
  max-width: 280px;
  padding: 5px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-3);
  display: flex;
  flex-direction: column;
  opacity: 0;
}

.ctx-menu.ready {
  opacity: 1;
  animation: ctx-in 0.12s var(--ease);
}

@keyframes ctx-in {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.ctx-item {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 30px;
  padding: 0 9px;
  border-radius: var(--r-sm);
  font-size: 12.5px;
  color: var(--text-2);
  text-align: left;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}

.ctx-item:hover {
  background: var(--bg-hover);
  color: var(--text-1);
}

.ctx-item.danger {
  color: var(--danger);
}

.ctx-item.danger:hover {
  background: var(--danger-soft);
}

.ctx-icon {
  flex: none;
  color: var(--text-3);
  transition: color var(--dur) var(--ease);
}

.ctx-item:hover .ctx-icon {
  color: inherit;
}

.ctx-item.danger .ctx-icon {
  color: inherit;
}

.ctx-label {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ctx-hint {
  flex: none;
  font-size: 10.5px;
  color: var(--text-4);
  font-family: ui-monospace, Consolas, monospace;
}

.ctx-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--line);
}

.ctx-empty {
  padding: 8px 9px;
  font-size: 12px;
  color: var(--text-4);
}
</style>
