<script lang="ts">
/**
 * 浮层菜单（宿主与插件页共用的唯一实现）。
 *
 * 为什么不用 naive-ui / 原生右键菜单：原生菜单在这个圆角浮窗里像另一个程序的，
 * 而且拿不到"危险操作变红、图标对齐、Esc 只关菜单"这些细节。
 *
 * 两种用法：
 * - **自管**（插件页）：自己挂 `<Teleport>`，点外面 / Esc / 滚动都自己关；
 * - **托管**（宿主的面板浮层）：`managed` 打开，不再 Teleport、不拦外面点击和 Esc，
 *   交给 `OverlayHost` 统一处理（遮罩、Esc 只关栈顶、Tab 困在层内）。
 *   宿主里再自己关一次，会出现"Esc 关了菜单又触发面板隐藏"这种连锁反应。
 *
 * 定位：挂载后量真实尺寸再定向。菜单项可能换行、带提示、带分隔线，
 * 按 `itemCount * 行高` 估算迟早会在某个组合下把菜单顶出窗口。
 */
</script>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { MENU_ICONS, MENU_W, type MenuIcon, type MenuItem } from './menu'

/** 视口边距：菜单贴边时留一点缝，别把圆角切掉 */
const PAD = 8

const props = withDefaults(
  defineProps<{
    x: number
    y: number
    items: MenuItem[]
    /** 由 OverlayHost 托管：不 Teleport、不自己拦外部点击与 Esc */
    managed?: boolean
  }>(),
  { managed: false }
)

const emit = defineEmits<{
  pick: [key: string]
  close: []
}>()

const el = ref<HTMLDivElement | null>(null)
/** 先按原坐标渲染一次（不可见），量到尺寸后再定位，避免闪一帧在错误位置 */
const pos = ref({ left: props.x, top: props.y, ready: false })
const origin = ref('top left')

const valid = computed(() => props.items.filter((item) => item.separator || item.label))

function pathOf(icon?: string): string | undefined {
  if (!icon) return undefined
  return icon.startsWith('M') ? icon : MENU_ICONS[icon as MenuIcon]
}

function place(): void {
  const node = el.value
  if (!node) return
  const rect = node.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  let left = props.x
  let top = props.y
  // 右边放不下就翻到光标左侧；翻完还放不下就贴边（贴边总比被裁掉好）
  if (left + rect.width > vw - PAD) left = Math.max(PAD, Math.min(props.x - rect.width, vw - rect.width - PAD))
  if (top + rect.height > vh - PAD) top = Math.max(PAD, props.y - rect.height)
  origin.value = `${top < props.y ? 'bottom' : 'top'} ${left < props.x ? 'right' : 'left'}`
  pos.value = { left, top, ready: true }
}

function pick(item: MenuItem): void {
  if (item.disabled || item.separator) return
  emit('pick', item.key)
  emit('close')
}

/** 点外面关闭。用捕获阶段：菜单项自己的 click 先执行完，再轮到这里的判定 */
function onDocPointer(event: PointerEvent): void {
  const target = event.target as HTMLElement | null
  if (target?.closest('.pop-menu')) return
  emit('close')
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    // 托管时 Esc 归 OverlayHost（它只关栈顶，还能把焦点还回去）
    if (props.managed) return
    // capture 拦下：插件页自己的 Esc 处理会把整个插件退掉
    event.preventDefault()
    event.stopPropagation()
    emit('close')
    return
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const buttons = Array.from(el.value?.querySelectorAll<HTMLButtonElement>('.pop-item') ?? []).filter(
    (b) => !b.disabled
  )
  if (buttons.length === 0) return
  event.preventDefault()
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
  // 还没聚焦时：↓ 进第一项，↑ 进最后一项
  const next =
    at < 0
      ? event.key === 'ArrowDown'
        ? 0
        : buttons.length - 1
      : event.key === 'ArrowDown'
        ? (at + 1) % buttons.length
        : at <= 0
          ? buttons.length - 1
          : at - 1
  buttons[next]?.focus()
}

/** 列表跟着滚走时菜单会悬在半空，直接关掉比让它错位好 */
function onScroll(): void {
  emit('close')
}

const listening = ref(false)

onMounted(() => {
  void nextTick(() => {
    place()
    // 上下键两种模式都要：宿主的菜单不抢焦点，只能靠键盘自己走进去
    window.addEventListener('keydown', onKey, true)
    if (!props.managed) {
      // 外部点击与滚动归自己；托管时这两件归 OverlayHost 的遮罩
      document.addEventListener('pointerdown', onDocPointer, true)
      window.addEventListener('scroll', onScroll, true)
      void nextTick(() => el.value?.querySelector<HTMLButtonElement>('.pop-item:not([disabled])')?.focus())
    }
    listening.value = true
  })
})

onUnmounted(() => {
  if (!listening.value) return
  window.removeEventListener('keydown', onKey, true)
  if (props.managed) return
  document.removeEventListener('pointerdown', onDocPointer, true)
  window.removeEventListener('scroll', onScroll, true)
})
</script>

<template>
  <Teleport to="body" :disabled="props.managed">
    <div
      ref="el"
      class="pop-menu"
      :class="{ ready: pos.ready }"
      :style="{
        left: `${pos.left}px`,
        top: `${pos.top}px`,
        minWidth: `${MENU_W}px`,
        transformOrigin: origin
      }"
      role="menu"
    >
      <template v-for="item in valid" :key="item.key">
        <div v-if="item.separator" class="pop-sep" role="separator" />
        <button
          v-else
          class="pop-item"
          :class="{ danger: item.danger }"
          :disabled="item.disabled"
          role="menuitem"
          @click="pick(item)"
        >
          <svg v-if="item.icon" class="pop-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path :d="pathOf(item.icon)" />
          </svg>
          <span class="pop-label">{{ item.label }}</span>
          <span v-if="item.hint" class="pop-hint">{{ item.hint }}</span>
        </button>
      </template>
      <!-- 全是分隔线时不至于渲染出一张空卡片 -->
      <p v-if="!valid.length" class="pop-empty">没有可用操作</p>
    </div>
  </Teleport>
</template>

<style scoped>
.pop-menu {
  position: fixed;
  z-index: 60;
  max-width: 280px;
  padding: 5px;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-3);
  opacity: 0;
}

.pop-menu.ready {
  opacity: 1;
  animation: pop-in 0.12s var(--ease);
}

@keyframes pop-in {
  from {
    opacity: 0;
    transform: scale(0.96) translateY(-2px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.pop-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  height: 30px;
  padding: 0 9px;
  border-radius: var(--r-sm);
  font-size: 12.5px;
  color: var(--text-2);
  text-align: left;
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.pop-item:hover,
.pop-item:focus-visible {
  background: var(--bg-hover);
  color: var(--text-1);
  box-shadow: none;
  outline: none;
}

.pop-item:disabled {
  color: var(--text-4);
  background: none;
  cursor: not-allowed;
}

.pop-item.danger {
  color: var(--danger);
}

.pop-item.danger:hover,
.pop-item.danger:focus-visible {
  background: var(--danger-soft);
  color: var(--danger);
}

.pop-icon {
  flex: none;
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.85;
}

.pop-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.pop-hint {
  flex: none;
  font-size: 10.5px;
  color: var(--text-4);
  font-family: ui-monospace, Consolas, monospace;
}

.pop-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--line);
}

.pop-empty {
  padding: 8px 9px;
  font-size: 12px;
  color: var(--text-4);
}
</style>
