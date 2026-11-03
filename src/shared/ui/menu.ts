/**
 * 插件页浮层菜单的共享类型。
 *
 * 放在独立 .ts 而不是从 SFC 导出：.vue 的具名导出要靠类型推导，跨文件引用在
 * 各插件各自的构建链上容易出岔子。
 */

/** 菜单里能画的图标；未知名字就不画，不影响菜单可用 */
export type MenuIcon = 'rename' | 'delete' | 'copy' | 'chat' | 'folder' | 'up' | 'down' | 'external'

export interface MenuItem {
  key: string
  label: string
  icon?: MenuIcon
  /** 破坏性操作：红色文字 + 悬停红底，并应该配一次确认 */
  danger?: boolean
  disabled?: boolean
}

/** 菜单宽度：调用方需要按它把菜单右边缘对齐到触发按钮 */
export const MENU_W = 176
