<script setup lang="ts">
import AppIcon from './AppIcon.vue'
import { PLUGIN_FRAME } from '../../../shared/pluginFrame'

/**
 * 插件页外框：由启动器（而不是插件自己）提供"返回主界面 / 独立窗口 / 关闭"。
 * 好处是所有插件行为一致，插件也不用把按钮画在窗口边缘、跟缩放热区抢点击。
 */
defineProps<{ plugin: { id: string; name: string; icon: string | null } }>()
const emit = defineEmits<{ (e: 'exit'): void; (e: 'detach'): void }>()

const frameStyle = {
  '--pf-header': `${PLUGIN_FRAME.header}px`,
  '--pf-inset': `${PLUGIN_FRAME.inset}px`,
  '--pf-radius': `${PLUGIN_FRAME.radius}px`
}
</script>

<template>
  <div class="frame" :style="frameStyle">
    <header class="bar">
      <button class="back" title="返回主界面" @click="emit('exit')">
        <AppIcon name="chevron-left" :size="15" />
        <span>主界面</span>
      </button>

      <div class="title" :title="plugin.name">
        <img v-if="plugin.icon" class="icon" :src="plugin.icon" alt="" />
        <span class="name">{{ plugin.name }}</span>
      </div>

      <div class="spacer" />

      <button class="act" title="在独立窗口打开" @click="emit('detach')">
        <AppIcon name="external-link" :size="15" />
      </button>
      <button class="act" title="关闭插件，返回主界面" @click="emit('exit')">
        <AppIcon name="x" :size="16" />
      </button>
    </header>

    <!-- 插件视图由主进程按同一套尺寸叠在上方，这里只负责画卡片底与留白 -->
    <div class="slot" />
  </div>
</template>

<style scoped>
.frame {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  background: #f1f3f6;
  border-radius: 16px;
  overflow: hidden;
}

.bar {
  flex: none;
  height: var(--pf-header);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px 0 8px;
  /* 窗口拖拽区：工具条空白处可拖动整个面板 */
  -webkit-app-region: drag;
}

.bar button {
  -webkit-app-region: no-drag;
}

.back {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 30px;
  padding: 0 10px 0 6px;
  border-radius: 8px;
  font-size: 12.5px;
  color: #4e5969;
}

.back:hover {
  background: #e4e7ec;
  color: #1f2329;
}

.title {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: #1f2329;
}

.icon {
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  object-fit: contain;
}

.name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.spacer {
  flex: 1;
  min-width: 8px;
}

.act {
  flex: none;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 7px;
  color: #646a73;
}

.act:hover {
  background: #e4e7ec;
  color: #1f2329;
}

.slot {
  flex: 1;
  margin: 0 var(--pf-inset) var(--pf-inset);
  border-radius: var(--pf-radius);
  background: #fff;
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08);
}
</style>
