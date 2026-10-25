<script setup lang="ts">
import type { CSSProperties } from 'vue'
import AppIcon from './AppIcon.vue'
import type { IconName } from './icons'

export interface ContextMenuItem {
  key: string
  label: string
  icon?: IconName
  danger?: boolean
  action: () => void
}

const props = defineProps<{
  x: number
  y: number
  items: ContextMenuItem[]
}>()

const emit = defineEmits<{ close: [] }>()

const MENU_W = 200
const ITEM_H = 34

function run(item: ContextMenuItem): void {
  item.action()
  emit('close')
}

function menuStyle(): CSSProperties {
  return {
    left: `${Math.min(props.x, window.innerWidth - MENU_W - 8)}px`,
    top: `${Math.min(props.y, window.innerHeight - props.items.length * ITEM_H - 24)}px`
  }
}
</script>

<template>
  <div class="ctx-backdrop" @click="emit('close')" @contextmenu.prevent="emit('close')">
    <div class="ctx-menu" :style="menuStyle()">
      <button
        v-for="item in items"
        :key="item.key"
        class="ctx-item"
        :class="{ danger: item.danger }"
        @click="run(item)"
      >
        <AppIcon v-if="item.icon" :name="item.icon" :size="15" />
        <span class="ctx-label">{{ item.label }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.ctx-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
}

.ctx-menu {
  position: fixed;
  width: 200px;
  padding: 5px;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 12px;
  box-shadow: 0 10px 36px rgba(0, 0, 0, 0.16);
  display: flex;
  flex-direction: column;
}

.ctx-item {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 30px;
  padding: 0 10px;
  border-radius: 8px;
  font-size: 13px;
  color: #1f2329;
  text-align: left;
}

.ctx-item:hover {
  background: #f2f3f5;
}

.ctx-item.danger {
  color: #d5304f;
}

.ctx-item.danger:hover {
  background: #fdecef;
}

.ctx-item svg {
  flex: none;
  color: #646a73;
}

.ctx-item.danger svg {
  color: inherit;
}

.ctx-label {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
