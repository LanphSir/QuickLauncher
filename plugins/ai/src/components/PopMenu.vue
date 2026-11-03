<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { MENU_W, type MenuItem } from '../menu'

const ITEM_H = 32
/** 上下内边距 + 菜单边框，给翻转计算留够余量 */
const PAD = 12

const props = defineProps<{
  x: number
  y: number
  items: MenuItem[]
}>()

const emit = defineEmits<{
  pick: [key: string]
  close: []
}>()

const height = computed(() => props.items.length * ITEM_H + PAD)

const style = computed(() => {
  const vw = window.innerWidth
  const vh = window.innerHeight
  // 贴边时整体平移而不是裁掉：菜单被切一半比位置不完美糟得多
  const left = Math.max(8, Math.min(props.x, vw - MENU_W - 8))
  const top = props.y + height.value > vh - 8 ? Math.max(8, props.y - height.value) : props.y
  return { left: `${left}px`, top: `${top}px`, width: `${MENU_W}px` }
})

const PATHS: Record<string, string> = {
  rename: 'M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z M13.5 6.5l3 3',
  delete: 'M4 7h16 M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2 M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12',
  chat: 'M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z'
}

function pick(item: MenuItem): void {
  emit('pick', item.key)
  emit('close')
}

/** 点外面关闭。用捕获阶段：菜单项自己的 click 先执行完，再轮到这里的判定 */
function onDocPointer(event: PointerEvent): void {
  const target = event.target as HTMLElement | null
  if (target?.closest('.pop-menu')) return
  emit('close')
}

function onKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  // capture 拦下：AI 页自己的 Esc 处理会把插件一起退掉
  event.preventDefault()
  event.stopPropagation()
  emit('close')
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointer, true)
  window.addEventListener('keydown', onKey, true)
})
onUnmounted(() => {
  document.removeEventListener('pointerdown', onDocPointer, true)
  window.removeEventListener('keydown', onKey, true)
})
</script>

<template>
  <Teleport to="body">
    <div class="pop-menu" :style="style" role="menu">
      <button
        v-for="item in items"
        :key="item.key"
        class="pop-item"
        :class="{ danger: item.danger }"
        role="menuitem"
        @click="pick(item)"
      >
        <svg v-if="item.icon" class="pop-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path :d="PATHS[item.icon]" />
        </svg>
        <span class="pop-label">{{ item.label }}</span>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.pop-menu {
  position: fixed;
  z-index: 60;
  padding: 5px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-3);
  animation: pop-in 0.12s var(--ease);
  transform-origin: top left;
}

@keyframes pop-in {
  from {
    opacity: 0;
    transform: scale(0.96) translateY(-2px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.pop-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  height: 30px;
  padding: 0 9px;
  border-radius: var(--r-sm);
  font-size: 12.5px;
  color: var(--text-2);
  text-align: left;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}

.pop-item:hover {
  background: var(--bg-hover);
  color: var(--text-1);
}

.pop-item.danger {
  color: var(--danger);
}

.pop-item.danger:hover {
  background: var(--danger-soft);
  color: var(--danger);
}

.pop-icon {
  flex: none;
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.85;
}

.pop-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
</style>
