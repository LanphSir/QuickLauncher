<script setup lang="ts">
import { ref } from 'vue'

defineProps<{
  plugin: PluginSummary
  selected?: boolean
}>()

const emit = defineEmits<{
  open: []
  hover: []
  pin: []
}>()

const hovering = ref(false)
</script>

<template>
  <div
    class="tile"
    :class="{ selected }"
    @click="emit('open')"
    @mouseenter="hovering = true; emit('hover')"
    @mouseleave="hovering = false"
  >
    <button
      v-if="hovering || plugin.pinned"
      class="pin-btn"
      :class="{ active: plugin.pinned }"
      :title="plugin.pinned ? '取消固定' : '固定到已固定'"
      @click.stop="emit('pin')"
    >
      <svg viewBox="0 0 24 24" width="12" height="12">
        <path
          v-if="plugin.pinned"
          d="M14.2 2.6 21.4 9.8a1 1 0 0 1-.5 1.7l-3.2.6-3.6 3.6.8 4.4a1 1 0 0 1-1.7.9l-4.5-4.5-4.7 4.7-1-1 4.7-4.7L3.2 11a1 1 0 0 1 .9-1.7l4.4.8 3.6-3.6.6-3.2a1 1 0 0 1 1.5-.7Z"
          fill="currentColor"
        />
        <path
          v-else
          d="M14.2 2.6 21.4 9.8a1 1 0 0 1-.5 1.7l-3.2.6-3.6 3.6.8 4.4a1 1 0 0 1-1.7.9l-4.5-4.5-4.7 4.7-1-1 4.7-4.7L3.2 11a1 1 0 0 1 .9-1.7l4.4.8 3.6-3.6.6-3.2a1 1 0 0 1 1.5-.7Zm.4 2.9-.5 2.6a1 1 0 0 1-.3.5l-4.2 4.2a1 1 0 0 1-.9.3l-2.6-.5 8 8-.5-2.6a1 1 0 0 1 .3-.9l4.2-4.2a1 1 0 0 1 .5-.3l2.6-.5Z"
          fill="currentColor"
        />
      </svg>
    </button>
    <div class="tile-icon">
      <img v-if="plugin.icon" :src="plugin.icon" alt="" draggable="false" />
      <span v-else class="fallback">{{ plugin.name.slice(0, 1) }}</span>
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
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: 12px;
  overflow: hidden;
}

.tile-icon img {
  width: 44px;
  height: 44px;
  object-fit: contain;
}

.fallback {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  color: #fff;
  font-size: 20px;
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
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
