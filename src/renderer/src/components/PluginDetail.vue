<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NPopconfirm, useMessage } from 'naive-ui'
import AppIcon from './AppIcon.vue'
import { fallbackIconFor, gradientFor } from '../utils/appFallback'

const PERM_LABELS: Record<string, string> = {
  storage: '本地存储',
  clipboard: '剪贴板',
  notify: '系统通知',
  shell: '打开链接'
}
const PERM_ORDER = ['storage', 'clipboard', 'notify', 'shell']

const props = defineProps<{ plugin: PluginSummary }>()
const emit = defineEmits<{ close: []; open: []; edit: []; detach: [] }>()

const message = useMessage()

const perms = computed(() =>
  PERM_ORDER.filter((p) => (props.plugin.permissions ?? []).includes(p))
)

function permLabel(key: string): string {
  return PERM_LABELS[key] ?? key
}

async function clearData(): Promise<void> {
  const r = await window.panel.clearPluginData(props.plugin.id)
  if (r.ok) message.success('插件数据已清除')
  else message.error('清除失败')
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal">
      <header class="head">
        <div class="app-icon">
          <img v-if="plugin.icon" :src="plugin.icon" alt="" draggable="false" />
          <span v-else class="fallback" :style="{ background: gradientFor(plugin) }">
            <AppIcon :name="fallbackIconFor(plugin)" :size="24" :stroke-width="1.8" />
          </span>
        </div>
        <div class="title-wrap">
          <div class="title-row">
            <h2>{{ plugin.name }}</h2>
            <span v-if="plugin.version" class="chip ver">v{{ plugin.version }}</span>
            <span class="chip" :class="plugin.type">
              {{ plugin.type === 'external' ? '外部程序' : '内置应用' }}
            </span>
          </div>
          <p class="desc">{{ plugin.description || '暂无描述' }}</p>
        </div>
        <button class="close" title="关闭" @click="emit('close')">
          <AppIcon name="x" :size="16" />
        </button>
      </header>

      <div class="body">
        <div class="row">
          <span class="label">ID</span>
          <code class="mono">{{ plugin.id }}</code>
        </div>
        <div v-if="plugin.type === 'external' && plugin.command" class="row">
          <span class="label">启动命令</span>
          <code class="mono ellip" :title="`${plugin.command} ${(plugin.args ?? []).join(' ')}`">
            {{ plugin.command }} {{ (plugin.args ?? []).join(' ') }}
          </code>
        </div>
        <div v-if="plugin.type === 'web' && plugin.dir" class="row">
          <span class="label">目录</span>
          <code class="mono ellip" :title="plugin.dir">{{ plugin.dir }}</code>
        </div>
        <div class="row">
          <span class="label">关键词</span>
          <div class="chips">
            <span v-for="kw in plugin.keywords" :key="kw" class="kw">{{ kw }}</span>
            <span v-if="!plugin.keywords.length" class="none">无</span>
          </div>
        </div>
        <div class="row">
          <span class="label">权限</span>
          <div class="chips">
            <span v-for="p in perms" :key="p" class="perm">
              <AppIcon name="check" :size="11" /> {{ permLabel(p) }}
            </span>
            <span v-if="!perms.length" class="none">未申请任何权限</span>
          </div>
        </div>
      </div>

      <footer class="foot">
        <NButton size="small" type="primary" @click="emit('open')">
          <template #icon><AppIcon name="play" :size="13" /></template>
          打开
        </NButton>
        <NButton v-if="plugin.type === 'web'" size="small" @click="emit('detach')">
          <template #icon><AppIcon name="external-link" :size="13" /></template>
          独立窗口打开
        </NButton>
        <NButton v-if="plugin.type === 'external'" size="small" @click="emit('edit')">
          <template #icon><AppIcon name="pencil" :size="13" /></template>
          编辑启动命令
        </NButton>
        <NPopconfirm v-if="plugin.type === 'web'" @positive-click="clearData">
          <template #trigger>
            <NButton size="small" quaternary type="error">
              <template #icon><AppIcon name="trash" :size="13" /></template>
              清除插件数据
            </NButton>
          </template>
          将删除该插件保存在本地的全部数据（历史记录、配置等），确定？
        </NPopconfirm>
        <span class="spacer" />
        <NButton size="small" quaternary @click="emit('close')">关闭</NButton>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 70;
  background: rgba(15, 18, 25, 0.32);
  display: grid;
  place-items: center;
}

.modal {
  width: 470px;
  max-width: calc(100vw - 48px);
  background: #fff;
  border-radius: 16px;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.24);
  overflow: hidden;
  animation: pop 0.16s ease;
}

@keyframes pop {
  from {
    transform: scale(0.96);
    opacity: 0.5;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}

.head {
  display: flex;
  gap: 14px;
  padding: 20px 20px 14px;
}

.app-icon {
  flex: none;
  width: 56px;
  height: 56px;
  border-radius: 14px;
  overflow: hidden;
}

.app-icon img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.fallback {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  color: #fff;
}

.title-wrap {
  flex: 1;
  min-width: 0;
}

.title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.title-row h2 {
  font-size: 17px;
  font-weight: 600;
}

.chip {
  font-size: 11px;
  padding: 1.5px 8px;
  border-radius: 999px;
  background: #f2f3f5;
  color: #646a73;
}

.chip.ver {
  font-family: ui-monospace, Consolas, monospace;
}

.chip.web {
  background: #eef0fe;
  color: #4f46e5;
}

.chip.external {
  background: #fef3e2;
  color: #b25e09;
}

.desc {
  margin-top: 6px;
  font-size: 12.5px;
  color: #646a73;
  line-height: 1.5;
}

.close {
  flex: none;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  color: #a1a6ad;
}

.close:hover {
  background: #f2f3f5;
  color: #1f2329;
}

.body {
  padding: 4px 20px 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.row {
  display: flex;
  align-items: baseline;
  gap: 12px;
  font-size: 12.5px;
}

.label {
  flex: none;
  width: 56px;
  color: #8f959e;
}

.mono {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  color: #1f2329;
  word-break: break-all;
}

.ellip {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.kw {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 6px;
  background: #f5f6f7;
  color: #646a73;
  font-family: ui-monospace, Consolas, monospace;
}

.perm {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 6px;
  background: #e8f7ef;
  color: #0a7d43;
}

.none {
  font-size: 12px;
  color: #b4b8bf;
}

.foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 20px 18px;
}

.spacer {
  flex: 1;
}
</style>
