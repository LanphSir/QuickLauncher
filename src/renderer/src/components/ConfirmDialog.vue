<script setup lang="ts">
import { onMounted, ref } from 'vue'

/**
 * 通用确认框（宿主侧）。走 OverlayHost，所以遮罩、Esc、焦点还原都是既有规则。
 *
 * 与 naive 的 popconfirm 不同：它占的是独立一层，能给"会连带删掉什么"留出行距，
 * 也能把默认焦点放到取消上。回车就通过的删除确认等于没有确认。
 */
const props = withDefaults(
  defineProps<{
    title: string
    message: string
    /** 补充说明：写"会连带影响什么"，不确定的事不要写进去 */
    hint?: string
    confirmLabel?: string
    cancelLabel?: string
    danger?: boolean
    onClose?: () => void
    onConfirm?: () => void
  }>(),
  { hint: '', confirmLabel: '确定', cancelLabel: '取消', danger: false }
)

const cancelRef = ref<HTMLButtonElement | null>(null)

onMounted(() => {
  // OverlayHost 也会给容器聚焦；这里再抢一次，保证"安全按钮"先到手
  requestAnimationFrame(() => cancelRef.value?.focus())
})
</script>

<template>
  <div class="modal confirm-dialog" role="alertdialog" aria-modal="true">
    <h2 class="title">{{ props.title }}</h2>
    <p class="msg">{{ props.message }}</p>
    <p v-if="props.hint" class="hint">{{ props.hint }}</p>
    <div class="acts">
      <button ref="cancelRef" class="btn ghost" @click="props.onClose?.()">
        {{ props.cancelLabel }}
      </button>
      <button class="btn" :class="props.danger ? 'danger' : 'primary'" @click="props.onConfirm?.()">
        {{ props.confirmLabel }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.confirm-dialog {
  width: min(380px, calc(100vw - 48px));
  padding: 18px 18px 14px;
  background: var(--bg);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-3);
  animation: confirm-in 0.16s var(--ease);
}

@keyframes confirm-in {
  from {
    opacity: 0;
    transform: scale(0.97) translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.title {
  font-size: 14.5px;
  font-weight: 600;
  line-height: 1.5;
  color: var(--text-1);
}

.msg {
  margin-top: 7px;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--text-2);
  word-break: break-word;
}

.hint {
  margin-top: 6px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-3);
}

.acts {
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
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
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
  color: #fff;
  background: var(--accent);
}

.btn.primary:hover {
  background: var(--accent-hover);
}

.btn.danger {
  color: #fff;
  background: var(--danger);
}

.btn.danger:hover {
  background: var(--danger-strong);
}
</style>
