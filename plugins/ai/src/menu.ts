/**
 * 会话菜单的共享类型。放独立文件而不是从 SFC 导出：
 * .vue 的具名导出要靠 vue-tsc 的类型推导，跨文件引用容易在构建链上出岔子。
 */
export interface MenuItem {
  key: string
  label: string
  /** 内置图标名，见 PopMenu 里的 PATHS；未知名字就不画图标 */
  icon?: 'rename' | 'delete' | 'chat'
  danger?: boolean
}

/** 菜单宽度：调用方需要按它把菜单右边缘对齐到触发按钮 */
export const MENU_W = 176
