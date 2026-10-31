/**
 * 插件页外框尺寸：主进程按它计算 WebContentsView 的矩形，面板渲染层按它排工具条与卡片，
 * 两边必须一致，否则插件视图会盖住工具条，或卡片四周露出底色。
 */
export const PLUGIN_FRAME = {
  /** 顶部工具栏高度（返回主界面 / 插件名 / 独立窗口 / 关闭） */
  header: 46,
  /**
   * 卡片与窗口边缘的留白。同时充当"可操作边缘"：
   * 插件视图贴在窗口边界时，系统/自实现的缩放热区会被视图吃掉，边缘内容也不好点。
   */
  inset: 8,
  /** 卡片圆角（WebContentsView.setBorderRadius，不支持时降级为直角） */
  radius: 10
} as const

export interface ViewRect {
  x: number
  y: number
  width: number
  height: number
}

/** 插件视图在面板窗口内的矩形 */
export function pluginViewRect(width: number, height: number): ViewRect {
  const { header, inset } = PLUGIN_FRAME
  return {
    x: inset,
    y: header,
    width: Math.max(1, width - inset * 2),
    height: Math.max(1, height - header - inset)
  }
}
