/**
 * 自实现窗口缩放：透明无边框窗口拿不到系统边缘缩放，只能自己在 8 个方向上
 * 监听 pointermove 再调 setWindowBounds。
 *
 * 两个容易踩的点都封在这里：
 * - pointermove 用 rAF 合帧，否则一次拖动能发出上百条 IPC；
 * - 拖动结束（pointerup / pointercancel）才 saveWindowBounds，中途不写配置。
 */

const MIN_W = 520
const MIN_H = 400

export const RESIZE_HANDLES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const

export function useWindowResize() {
  async function startResize(e: PointerEvent, handle: string): Promise<void> {
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    const start = await window.panel.getWindowBounds()
    if (!start) return
    const sx = e.screenX
    const sy = e.screenY
    let raf = 0
    const apply = (ev: PointerEvent): void => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const dx = ev.screenX - sx
        const dy = ev.screenY - sy
        let { x, y, width, height } = start
        if (handle.includes('e')) width = Math.max(MIN_W, start.width + dx)
        if (handle.includes('s')) height = Math.max(MIN_H, start.height + dy)
        if (handle.includes('w')) {
          width = Math.max(MIN_W, start.width - dx)
          x = start.x + (start.width - width)
        }
        if (handle.includes('n')) {
          height = Math.max(MIN_H, start.height - dy)
          y = start.y + (start.height - height)
        }
        void window.panel.setWindowBounds({
          x: Math.round(x),
          y: Math.round(y),
          width: Math.round(width),
          height: Math.round(height)
        })
      })
    }
    const up = (): void => {
      el.removeEventListener('pointermove', apply)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      void window.panel.saveWindowBounds()
    }
    el.setPointerCapture(e.pointerId)
    el.addEventListener('pointermove', apply)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  return { startResize }
}
