/**
 * 浮层菜单的共享类型（宿主与插件页共用一套）。
 *
 * 放在独立 .ts 而不是从 SFC 导出：.vue 的具名导出要靠类型推导，跨文件引用在
 * 各插件各自的构建链上容易出岔子。
 */

/** 插件页能画的图标；未知名字就不画，不影响菜单可用 */
export type MenuIcon = 'rename' | 'delete' | 'copy' | 'chat' | 'folder' | 'up' | 'down' | 'external'

/** 24×24 线性图标的 path 数据：插件写名字，宿主把自己的图标表拼成 path 传进来 */
export const MENU_ICONS: Record<MenuIcon, string> = {
  rename: 'M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z M13.5 6.5l3 3',
  delete:
    'M4 7h16 M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2 M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12',
  copy: 'M9 9h9v11H9z M6 15H4V4h11v2',
  chat: 'M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z',
  folder: 'M4 7a1 1 0 0 1 1-1h5l2 2h7a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z',
  up: 'M12 19V5 M6 11l6-6 6 6',
  down: 'M12 5v14 M6 13l6 6 6-6',
  external: 'M14 4h6v6 M20 4l-8 8 M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'
}

export interface MenuItem {
  key: string
  /** 分隔线不需要文字 */
  label?: string
  /**
   * 图标：插件写 `MenuIcon` 名字（`'delete'`），宿主传现成的 path 数据。
   * `PopMenu` 用「是否以 M 开头」区分两者——path 数据必然从 moveto 开始。
   */
  icon?: string
  /** 右侧灰色提示，比如快捷键 */
  hint?: string
  /** 破坏性操作：红色文字 + 悬停红底，并应该配一次确认 */
  danger?: boolean
  disabled?: boolean
  /** 分隔线：为 true 时其余字段忽略 */
  separator?: boolean
}

/** 菜单宽度：调用方需要按它把菜单右边缘对齐到触发按钮 */
export const MENU_W = 176
