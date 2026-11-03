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
/** 徽标的悬浮说明：告诉用户「它到底能和 AI 干什么」，不是一个没有含义的小图标 */
const aiTitle = computed(() => {
  const ai = props.plugin.ai
  if (!ai) return ''
  const parts: string[] = []
  if (ai.tools > 0) parts.push(`${ai.tools} 个工具`)
  if (ai.skill) parts.push('技能说明')
  const what = parts.join(' + ') || 'AI 能力'
  return ai.granted ? `可被 AI 调用：${what}` : `支持 ${what}（未授权给 AI，去 设置 → AI 打开）`
})
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
      <span
        v-if="plugin.ai"
        class="ai-badge"
        :class="{ 'made-way': hovering || plugin.pinned }"
        :title="aiTitle"
      >
        <AppIcon name="spark" :size="9" :stroke-width="2.8" />
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
  padding: 11px 4px 9px;
  border-radius: var(--r-md);
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}

.tile:hover {
  background: var(--bg-hover);
}

.tile.selected {
  background: var(--accent-soft);
}

.pin-btn {
  position: absolute;
  top: 5px;
  right: 6px;
  display: grid;
  place-items: center;
  width: 19px;
  height: 19px;
  border-radius: 6px;
  color: var(--text-3);
  background: transparent;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}

.pin-btn:hover {
  background: var(--bg-active);
  color: var(--text-1);
}

.pin-btn.active {
  color: var(--accent);
}

.tile-icon {
  position: relative;
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: 12px;
  overflow: visible;
  /* 悬浮时图标轻轻上浮一格：比整块变色的反馈更轻，也不会让网格显得在抖 */
  transition: transform var(--dur) var(--ease);
}

.tile:hover .tile-icon {
  transform: translateY(-1px);
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
  box-shadow: 0 3px 8px rgba(15, 23, 42, 0.16);
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
  background: var(--bg);
  color: var(--warn);
  border: 1px solid var(--warn-soft);
  box-shadow: var(--shadow-1);
}

/*
 * AI 徽标默认在图标右上角。但那里正是固定按钮出现的位置（悬停/已固定），
 * 所以徽标要"让位"——滑到右下角。直接隐藏会让已固定的应用永远看不到 AI 标记，
 * 而固定恰恰是最常用的状态。
 */
.ai-badge {
  position: absolute;
  right: -3px;
  top: -3px;
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--bg);
  color: #7c3aed;
  border: 1px solid #e4dcfb;
  box-shadow: var(--shadow-1);
  transition: top 0.12s var(--ease), bottom 0.12s var(--ease);
}

.ai-badge.made-way {
  top: auto;
  bottom: -3px;
}

.tile-label {
  width: 100%;
  font-size: 12px;
  line-height: 1.35;
  text-align: center;
  color: var(--text-1);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
}

.tile.selected .tile-label {
  color: var(--accent-strong);
  font-weight: 500;
}
</style>
