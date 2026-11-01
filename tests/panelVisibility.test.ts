import { describe, expect, it } from 'vitest'
import {
  BLUR_HIDE_DELAY,
  blurDecision,
  isBlurBehavior,
  shouldHideAfterDelay
} from '../src/main/windows/panelVisibility'

const base = { behavior: 'delay' as const, holds: 0, pinned: false, devTools: false }

describe('blurDecision：失焦后收不收面板', () => {
  it('默认延迟收起，给误触留余地', () => {
    expect(blurDecision(base)).toEqual({ hide: true, delay: BLUR_HIDE_DELAY, reason: 'hide' })
  })

  it('设成立即收起时 delay 为 0', () => {
    expect(blurDecision({ ...base, behavior: 'immediate' })).toEqual({
      hide: true,
      delay: 0,
      reason: 'hide'
    })
  })

  it('设成不自动收起时永远不安排隐藏', () => {
    expect(blurDecision({ ...base, behavior: 'never' }).hide).toBe(false)
  })

  it('置顶钉住优先于延迟策略', () => {
    const d = blurDecision({ ...base, pinned: true })
    expect(d.hide).toBe(false)
    expect(d.reason).toBe('pinned')
  })

  it('开着 DevTools 时不收起（否则调试面板 UI 一步都走不完）', () => {
    expect(blurDecision({ ...base, devTools: true }).reason).toBe('devtools')
  })

  it('有浮层/对话框登记时不收起，等它关掉再补判', () => {
    const d = blurDecision({ ...base, holds: 2 })
    expect(d.hide).toBe(false)
    expect(d.reason).toBe('held')
  })

  it('浮层登记压过 pinned / devTools 的判断顺序，但结论都是"别收"', () => {
    const d = blurDecision({ ...base, holds: 1, pinned: true, devTools: true })
    expect(d.hide).toBe(false)
  })
})

describe('shouldHideAfterDelay：宽限期结束时的复检', () => {
  it('用户点回来了就不收', () => {
    expect(shouldHideAfterDelay({ holds: 0, pinned: false, focused: true })).toBe(false)
  })

  it('确实离开了才收', () => {
    expect(shouldHideAfterDelay({ holds: 0, pinned: false, focused: false })).toBe(true)
  })

  it('宽限期内打开了浮层，到期也不收', () => {
    expect(shouldHideAfterDelay({ holds: 1, pinned: false, focused: false })).toBe(false)
  })

  it('宽限期内被钉住，到期也不收', () => {
    expect(shouldHideAfterDelay({ holds: 0, pinned: true, focused: false })).toBe(false)
  })
})

describe('isBlurBehavior：写进配置前的白名单', () => {
  it('接受三档', () => {
    expect(isBlurBehavior('immediate')).toBe(true)
    expect(isBlurBehavior('delay')).toBe(true)
    expect(isBlurBehavior('never')).toBe(true)
  })

  it('拒绝脏值，避免行为静默退化成默认', () => {
    for (const bad of ['', 'later', 1, null, undefined, {}]) {
      expect(isBlurBehavior(bad)).toBe(false)
    }
  })
})
