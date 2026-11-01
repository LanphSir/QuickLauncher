import type { ComputedRef } from 'vue'
import { useLauncherStore } from '../stores/launcher'

/**
 * 搜索框键盘导航：↑↓ 在"内联结果 → 条目 → 应用"这条统一光标上循环，
 * Enter 交给调用方（它才知道光标落在哪一段该做什么），Esc 收起面板。
 *
 * 单独成文件是为了让"光标怎么动"和"回车做什么"解耦：前者是纯索引运算，
 * 后者要调主进程。
 */
export function useKeyboardNav(resultCount: ComputedRef<number>, onEnter: () => void) {
  const store = useLauncherStore()

  function onKeydown(e: KeyboardEvent): void {
    const count = resultCount.value
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (count) store.selIndex = (store.selIndex + 1) % count
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (count) store.selIndex = (store.selIndex - 1 + count) % count
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onEnter()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      void window.panel.hidePanel()
    } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // 开始输入新词：光标回到第一条结果
      store.selIndex = 0
    }
  }

  return { onKeydown }
}
