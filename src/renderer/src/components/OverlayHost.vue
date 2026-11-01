<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import {
  closeOverlay,
  FOCUSABLE,
  overlayStack,
  topOverlay,
  type OverlayEntry
} from '../composables/useOverlay'

/**
 * 浮层宿主：所有面板内弹窗/菜单都由它渲染。
 *
 * 负责四件以前各写各的事：
 * - 遮罩与层级（60 起，每层 +2；缩放热区在 40，永远压得住）
 *   遮罩与内容必须分两层：遮罩是 absolute，内容和它同级时会被整个盖住
 *   （表现是弹窗灰蒙蒙一层、点哪都关闭）
 * - Esc 只关栈顶（capture 阶段吃掉，不会同时触发"隐藏面板"）
 * - 点遮罩关闭（`click.self`，点内容不触发）
 * - 焦点：打开时移进浮层、Tab 困在层内、关闭后还给原来的元素
 */

function layerOf(id: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-overlay-id="${id}"]`)
}

function dismiss(entry: OverlayEntry): void {
  if (!entry.dismissible) return
  closeOverlay(entry.id)
}

/** Tab / Shift+Tab 在浮层内循环，别跑到被遮罩盖住的搜索框上 */
function trapTab(e: KeyboardEvent, top: OverlayEntry): void {
  const layer = layerOf(top.id)
  if (!layer) return
  const items = Array.from(layer.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  )
  if (!items.length) {
    e.preventDefault()
    layer.focus()
    return
  }
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  const inside = active instanceof Node && layer.contains(active)
  if (e.shiftKey) {
    if (!inside || active === first) {
      e.preventDefault()
      last.focus()
    }
  } else if (!inside || active === last) {
    e.preventDefault()
    first.focus()
  }
}

function onKeydown(e: KeyboardEvent): void {
  const top = topOverlay()
  if (!top) return
  if (e.key === 'Escape') {
    if (!top.dismissible) return
    // capture 阶段拦下：不这样的话搜索框也会收到 Esc，浮层关了面板也一起没了
    e.preventDefault()
    e.stopPropagation()
    closeOverlay(top.id)
    return
  }
  if (e.key === 'Tab') trapTab(e, top)
}

onMounted(() => window.addEventListener('keydown', onKeydown, true))
onUnmounted(() => window.removeEventListener('keydown', onKeydown, true))
</script>

<template>
  <Teleport to="body">
    <div
      v-for="(entry, index) in overlayStack"
      :key="entry.id"
      class="overlay-layer"
      :data-overlay-id="entry.id"
      :data-overlay="entry.label || undefined"
      :style="{ zIndex: 60 + index * 2 }"
      tabindex="-1"
    >
      <!-- 遮罩层负责"点外面关闭"；transparent 时只是不可见的点击接收区（右键菜单） -->
      <div
        v-if="entry.backdrop !== 'none'"
        class="overlay-backdrop"
        :class="entry.backdrop"
        @click.self="dismiss(entry)"
        @contextmenu.self.prevent="dismiss(entry)"
      />
      <div class="overlay-content">
        <component :is="entry.component" v-bind="entry.props" />
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay-layer {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  outline: none;
}

/* 遮罩跟面板同圆角：面板是 16px 圆角的透明窗口，方块遮罩会在四角露出一点点色块 */
.overlay-backdrop {
  position: absolute;
  /* 0 = 贴在内容层下面。absolute 元素默认会画在静态内容之上，
     不显式压下去的话弹窗会被自己那层遮罩盖住（灰一层、点不动） */
  z-index: 0;
  inset: 0;
  border-radius: 16px;
  background: rgba(15, 18, 25, 0.32);
}

.overlay-backdrop.transparent {
  background: transparent;
}

.overlay-backdrop.none {
  display: none;
}

/*
 * 内容层：单独一层是为了能压在遮罩上面（见上面 z-index 的注释）。
 * 不在这里加 transform / filter——右键菜单是 position: fixed 按视口坐标定位的，
 * 祖先一旦有 transform 就会把它变成相对该祖先定位。
 */
.overlay-content {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  max-width: 100%;
  max-height: 100%;
}
</style>
