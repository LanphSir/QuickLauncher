<script lang="ts">
/**
 * 宿主侧的浮层菜单——只是 `src/shared/ui/PopMenu.vue` 的适配层。
 *
 * 定位、翻转、键盘移动、分隔线、危险色这些全在共享组件里，宿主这边只做两件映射：
 * 图标名 → path 数据（宿主的图标库比插件大得多），`action` → `pick(key)`。
 * 以前这里有一份完整实现，和插件页那份各修各的 bug（Esc 连锁、翻转到错误方向），
 * 合并成一份之后只有一处需要维护。
 */
import type { IconName } from './icons'

export interface ContextMenuItem {
  key: string
  label?: string
  icon?: IconName
  danger?: boolean
  /** 右侧灰色提示，比如 Enter、Ctrl+Enter */
  hint?: string
  /** 分隔线：为 true 时其余字段忽略 */
  separator?: boolean
  action?: () => void
}
</script>

<script setup lang="ts">
import { computed } from 'vue'
import PopMenu from '../../../shared/ui/PopMenu.vue'
import type { MenuItem } from '../../../shared/ui/menu'
import { ICONS } from './icons'

const props = defineProps<{
  /** 光标位置：右键菜单用这个 */
  x?: number
  y: number
  /** 触发按钮的右边缘：菜单右缘对齐它，别再用「rect.right - 176」猜宽度 */
  anchorRight?: number
  items: ContextMenuItem[]
}>()

const emit = defineEmits<{ close: [] }>()

const mapped = computed<MenuItem[]>(() =>
  props.items.map((item) =>
    item.separator
      ? { key: item.key, separator: true }
      : {
          key: item.key,
          label: item.label ?? '',
          // AppIcon 每个名字可能是多条 subpath，合成一段 d 交给 PopMenu 画
          icon: item.icon ? ICONS[item.icon].join(' ') : undefined,
          hint: item.hint,
          danger: item.danger
        }
  )
)

function onPick(key: string): void {
  props.items.find((item) => item.key === key)?.action?.()
}
</script>

<template>
  <PopMenu
    :x="props.x ?? 0"
    :y="props.y"
    :anchor-right="props.anchorRight"
    :items="mapped"
    managed
    @pick="onPick"
    @close="emit('close')"
  />
</template>
