<script setup lang="ts">
import { computed, ref } from 'vue'
import AppIcon from './AppIcon.vue'
import { fallbackIconFor, gradientFor } from '../utils/appFallback'

const props = defineProps<{
  plugin: PluginSummary
  selected?: boolean
}>()

const emit = defineEmits<{
  open: []
  hover: []
  pin: []
  ctx: [pos: { x: number; y: number }]
}>()

const hovering = ref(false)
const fallbackName = computed(() => fallbackIconFor(props.plugin))
const fallbackBg = computed(() => gradientFor(props.plugin))
</script>

<template>
  <div
    class="tile"
    :class="{ selected }"
    @click="emit('open')"
    @mouseenter="hovering = true; emit('hover')"
    @mouseleave="hovering = false"
    @contextmenu.prevent="emit('ctx', { x: $event.clientX, y: $event.clientY })"
  >
    <button
      v-if="hovering || plugin.pinned"
      class="pin-btn"
      :class="{ active: plugin.pinned }"
      :title="plugin.pinned ? '取消固定' : '固定到已固定'"
      @click.stop="emit('pin')"
    >
      <AppIcon name="pin" :size="12" />
    </button>
    <div class="tile-icon">
      <img v-if="plugin.icon" :src="plugin.icon" alt="" draggable="false" />
      <span v-else class="fallback" :style="{ background: fallbackBg }">
        <AppIcon :name="fallbackName" :size="26" :stroke-width="1.8" />
      </span>
      <span v-if="plugin.type === 'external'" class="ext-badge" title="外部程序">
        <AppIcon name="external-link" :size="9" :stroke-width="2.6" />
      </span>
    </div>
    <div class="tile-label" :title="plugin.description || plugin.name">{{ plugin.name }}</div>
  </div>
</template>

<style scoped>
.tile {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  padding: 12px 4px 10px;
  border-radius: 12px;
  cursor: pointer;
}

.tile:hover,
.tile.selected {
  background: #f2f3f5;
}

.pin-btn {
  position: absolute;
  top: 6px;
  right: 8px;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  color: #a1a6ad;
  background: transparent;
}

.pin-btn:hover {
  background: rgba(0, 0, 0, 0.06);
  color: #1f2329;
}

.pin-btn.active {
  color: #6366f1;
}

.tile-icon {
  position: relative;
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: 12px;
  overflow: visible;
}

.tile-icon > img {
  width: 44px;
  height: 44px;
  object-fit: contain;
  border-radius: 10px;
}

.fallback {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  color: #fff;
  box-shadow: 0 3px 8px rgba(0, 0, 0, 0.12);
}

.ext-badge {
  position: absolute;
  right: -3px;
  bottom: -2px;
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  color: #b25e09;
  border: 1px solid #f0e2cf;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.tile-label {
  width: 100%;
  font-size: 12px;
  line-height: 1.35;
  text-align: center;
  color: #1f2329;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
}
</style>
