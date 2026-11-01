/**
 * 面板"什么时候该因为失焦收起"的判定。
 *
 * 抽成纯函数的原因：这段逻辑有三层（用户设置 / 置顶 / 浮层登记），
 * 写在 Electron 的 blur 回调里就只能靠手动点窗口来验，改动一次要试五遍。
 */

/** 失焦后的行为：立即收起 / 宽限一会儿（默认）/ 永不收起 */
export type BlurBehavior = 'immediate' | 'delay' | 'never'

export function isBlurBehavior(value: unknown): value is BlurBehavior {
  return value === 'immediate' || value === 'delay' || value === 'never'
}

/** 延迟收起的宽限时长：点击托盘、输入法候选窗、二级弹窗切换都会短暂丢焦点 */
export const BLUR_HIDE_DELAY = 160

export interface BlurState {
  behavior: BlurBehavior
  /** 可见性令牌数量：渲染层浮层、原生对话框登记的数量 */
  holds: number
  /** 置顶钉住 */
  pinned: boolean
  /** DevTools 开着（调试面板时不能一失焦就跑掉） */
  devTools: boolean
}

export interface BlurDecision {
  /** 是否安排隐藏 */
  hide: boolean
  /** 延迟毫秒（0 = 立即） */
  delay: number
  /** 不隐藏的原因，便于排查"为什么没收起" */
  reason: 'never' | 'pinned' | 'devtools' | 'held' | 'hide'
}

export function blurDecision(state: BlurState): BlurDecision {
  if (state.behavior === 'never') return { hide: false, delay: 0, reason: 'never' }
  if (state.pinned) return { hide: false, delay: 0, reason: 'pinned' }
  if (state.devTools) return { hide: false, delay: 0, reason: 'devtools' }
  // 有浮层/对话框注册着可见性：等它关掉时再补判（见 releasePanelVisible）
  if (state.holds > 0) return { hide: false, delay: 0, reason: 'held' }
  if (state.behavior === 'immediate') return { hide: true, delay: 0, reason: 'hide' }
  return { hide: true, delay: BLUR_HIDE_DELAY, reason: 'hide' }
}

/**
 * 延迟到期后的复检。
 * 这 160ms 里用户可能又把面板点回来了（比如点开输入法候选窗），或者刚打开一个浮层，
 * 那就不能收——否则会出现"点了一下没反应，再点面板没了"。
 */
export function shouldHideAfterDelay(state: {
  holds: number
  pinned: boolean
  focused: boolean
}): boolean {
  if (state.pinned) return false
  if (state.holds > 0) return false
  return !state.focused
}
