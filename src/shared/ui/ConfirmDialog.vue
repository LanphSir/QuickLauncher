<script lang="ts">
/**
 * 插件页确认框（替代 window.confirm）。
 *
 * 原生对话框在这个圆角浮窗里像另一个程序弹出来的：字体、圆角、按钮顺序全都对不上，
 * 而且它会阻塞渲染进程。自己画一个，顺便把"默认焦点在取消"这条安全规则固定下来——
 * 回车就能通过的删除确认等于没有确认。
 *
 * 所有插件共用这一份，别再各自复制：确认框是"全项目只有一种长相"的东西，
 * 复制第三份之后必然有一份按钮顺序是反的。
 */
</script>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    title: string
    message: string
    /** 额外一行灰色说明，用来写"会连带删除什么" */
    hint?: string
    confirmLabel?: string
    cancelLabel?: string
    danger?: boolean
  }>(),
  { hint: '', confirmLabel: '确定', cancelLabel: '取消', danger: false }
)

const emit = defineEmits<{ confirm: []; cancel: [] }>()

const cancelRef = ref<HTMLButtonElement | null>(null)

function onKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  // capture 拦下：插件页的全局 Esc 会把整个插件退掉，这里只关对话框
  event.preventDefault()
  event.stopPropagation()
  emit('cancel')
}

onMounted(() => {
  window.addEventListener('keydown', onKey, true)
  requestAnimationFrame(() => cancelRef.value?.focus())
})
onUnmounted(() => window.removeEventListener('keydown', onKey, true))
</script>

<template>
  <Teleport to="body">
    <div class="dlg-mask" @click.self="emit('cancel')">
      <div class="dlg" role="alertdialog" aria-modal="true">
        <div class="dlg-title">{{ props.title }}</div>
        <p class="dlg-msg">{{ props.message }}</p>
        <p v-if="props.hint" class="dlg-hint">{{ props.hint }}</p>
        <div class="dlg-actions">
          <button ref="cancelRef" class="btn ghost" @click="emit('cancel')">{{ props.cancelLabel }}</button>
          <button class="btn" :class="props.danger ? 'danger' : 'primary'" @click="emit('confirm')">
            {{ props.confirmLabel }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.dlg-mask {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: grid;
  place-items: center;
  padding: 20px;
  background: var(--scrim);
  animation: mask-in 0.12s var(--ease);
}

@keyframes mask-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.dlg {
  width: min(360px, 100%);
  padding: 18px 18px 14px;
  background: var(--bg);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-3);
  animation: dlg-in 0.16s var(--ease);
}

@keyframes dlg-in {
  from {
    opacity: 0;
    transform: scale(0.96) translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.dlg-title {
  font-size: 14.5px;
  font-weight: 600;
  color: var(--text-1);
  line-height: 1.5;
}

.dlg-msg {
  margin-top: 6px;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--text-2);
  word-break: break-word;
}

.dlg-hint {
  margin-top: 6px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-3);
}

.dlg-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.btn {
  height: 30px;
  padding: 0 14px;
  border-radius: var(--r-sm);
  font-size: 12.5px;
  font-weight: 500;
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.btn.ghost {
  color: var(--text-2);
  background: var(--bg-hover);
}

.btn.ghost:hover {
  background: var(--bg-active);
  color: var(--text-1);
}

.btn.primary {
  color: var(--on-accent);
  background: var(--accent);
}

.btn.primary:hover {
  background: var(--accent-hover);
}

.btn.danger {
  color: var(--on-accent);
  background: var(--danger);
}

.btn.danger:hover {
  background: var(--danger-strong);
}
</style>
