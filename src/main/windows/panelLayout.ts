/**
 * 面板窗口布局的纯计算部分。
 *
 * 这里刻意不碰 Electron：屏幕/显示器查询留在 panel.ts，纯算术抽出来后单测能直接跑。
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

/** 插件页最多占工作区的比例：留一圈边缘，视觉上不贴死屏幕 */
const MAX_AREA_RATIO = 0.94

/**
 * 插件页目标尺寸。
 * 只放大不缩小——用户如果本来就把主页拉得更大，不该因为开插件被压回去；
 * 记住的插件页尺寸作为下限参与比较，这样"上次在插件页拉过的框"能延续。
 */
export function pluginSize(current: Size, saved: Size | undefined, area: Rect): Size {
  const width = Math.min(Math.max(current.width, saved?.width ?? 0), Math.round(area.width * MAX_AREA_RATIO))
  const height = Math.min(Math.max(current.height, saved?.height ?? 0), Math.round(area.height * MAX_AREA_RATIO))
  return { width: Math.round(width), height: Math.round(height) }
}

/** 把给定尺寸的窗口摆在工作区正中（取整，避免 125% 缩放下半像素抖动） */
export function centerInWorkArea(area: Rect, size: Size): Rect {
  return {
    x: Math.round(area.x + (area.width - size.width) / 2),
    y: Math.round(area.y + (area.height - size.height) / 2),
    width: size.width,
    height: size.height
  }
}
