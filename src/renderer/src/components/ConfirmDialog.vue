<script setup lang="ts">
import SharedConfirmDialog from '../../../shared/ui/ConfirmDialog.vue'

/**
 * 宿主侧的确认框——`src/shared/ui/ConfirmDialog.vue` 的适配层。
 *
 * 为什么还要这一层：宿主通过 `OverlayHost` 打开浮层，靠 props 传 `onClose/onConfirm`
 * 回调；插件页直接 `@confirm/@cancel` 用组件。适配层把回调翻译成事件，
 * 于是"确认框长什么样、按钮顺序、默认焦点在哪"全项目只有一份实现。
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
</script>

<template>
  <SharedConfirmDialog
    managed
    :title="props.title"
    :message="props.message"
    :hint="props.hint"
    :confirm-label="props.confirmLabel"
    :cancel-label="props.cancelLabel"
    :danger="props.danger"
    @cancel="props.onClose?.()"
    @confirm="props.onConfirm?.()"
  />
</template>
