<script setup lang="ts">
import { computed, ref } from 'vue'

/**
 * 快捷键捕获框：聚焦后直接按组合键即可。
 *
 * 只负责"把按键翻译成 accelerator"，校验与冲突判断都不在这里做——
 * 主进程才知道 system 里哪个键被占了，这里提前判会造成两套标准。
 */
const props = withDefaults(
  defineProps<{
    modelValue: string
    placeholder?: string
    /** 允许按退格/删除清除（默认允许） */
    clearable?: boolean
    disabled?: boolean
  }>(),
  { placeholder: '未设置', clearable: true, disabled: false }
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  /** 组合键不合法（比如只按了 Shift）时提示，由父组件弹 toast */
  invalid: [message: string]
}>()

const focused = ref(false)
const parts = computed(() => (props.modelValue ? props.modelValue.split('+') : []))

/**
 * 界面上显示的名字。accelerator 里存的是 `CommandOrControl`，
 * 直接画出来像一句代码；用户认的是键帽上的字。
 */
const KEY_LABEL: Record<string, string> = {
  CommandOrControl: 'Ctrl',
  Super: 'Win',
  Alt: 'Alt',
  Shift: 'Shift'
}
const shownParts = computed(() => parts.value.map((part) => KEY_LABEL[part] ?? part))

/** 单独按下的修饰键不算组合键，等主键 */
const KEY_MODIFIERS = new Set(['Alt', 'Control', 'Shift', 'Meta', 'Dead', 'Unidentified'])

function onKeydown(e: KeyboardEvent): void {
  if (props.disabled) return
  e.preventDefault()
  e.stopPropagation()

  // Esc 只用来退出捕获：别让它顺手把面板也收了
  if (e.key === 'Escape') {
    ;(e.target as HTMLElement | null)?.blur()
    return
  }
  if (props.clearable && (e.key === 'Backspace' || e.key === 'Delete')) {
    emit('update:modelValue', '')
    return
  }
  if (KEY_MODIFIERS.has(e.key)) return

  const mods: string[] = []
  if (e.altKey) mods.push('Alt')
  if (e.ctrlKey) mods.push('CommandOrControl')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Super')
  if (!mods.length) {
    emit('invalid', '快捷键需至少包含一个修饰键（Alt / Ctrl / Shift / Win）')
    return
  }

  let key = e.key
  if (key === ' ') key = 'Space'
  else if (key.length === 1) key = key.toUpperCase()
  emit('update:modelValue', [...new Set(mods), key].join('+'))
}
</script>

<template>
  <div
    class="hotkey-input"
    :class="{ focused, empty: !modelValue, disabled }"
    tabindex="0"
    :title="disabled ? '先启用插件再设置快捷键' : '点击后按下新的组合键；退格清除'"
    @keydown="onKeydown"
    @focus="focused = true"
    @blur="focused = false"
  >
    <template v-if="modelValue">
      <kbd v-for="part in shownParts" :key="part">{{ part }}</kbd>
    </template>
    <span v-else class="placeholder">{{ placeholder }}</span>
  </div>
</template>

<style scoped>
.hotkey-input {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 108px;
  max-width: 100%;
  min-height: 32px;
  padding: 4px 10px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  outline: none;
  cursor: pointer;
  transition: border-color 0.12s, box-shadow 0.12s;
}

.hotkey-input:hover {
  border-color: var(--line-strong);
}

.hotkey-input.focused {
  border-color: var(--accent);
  box-shadow: var(--ring);
}

.hotkey-input.disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.hotkey-input.disabled:focus {
  border-color: var(--line);
  box-shadow: none;
}

.placeholder {
  font-size: 12px;
  color: var(--text-3);
}

kbd {
  font-family: inherit;
  font-size: 11.5px;
  padding: 1px 7px;
  border-radius: 5px;
  color: var(--text-1);
  background: var(--bg);
  border: 1px solid var(--line);
  /* 一条 1px 的实心投影 = 键帽的下沿，比纯描边更像"可以按" */
  box-shadow: 0 1px 0 var(--line-strong);
}
</style>
