import { describe, expect, it } from 'vitest'
import { centerInWorkArea, pluginSize } from '../src/main/windows/panelLayout'

const AREA = { x: 0, y: 0, width: 1920, height: 1040 }
const DEFAULT = { width: 980, height: 720 }

describe('pluginSize', () => {
  it('主页比默认小 → 伸到默认尺寸', () => {
    expect(pluginSize({ width: 760, height: 560 }, DEFAULT, AREA)).toEqual(DEFAULT)
  })

  it('主页本来就更宽 → 只放大不缩小', () => {
    const size = pluginSize({ width: 1400, height: 560 }, DEFAULT, AREA)
    expect(size).toEqual({ width: 1400, height: 720 })
  })

  it('上次在插件页拉过的尺寸作为下限', () => {
    expect(pluginSize({ width: 760, height: 560 }, { width: 1200, height: 900 }, AREA)).toEqual({
      width: 1200,
      height: 900
    })
  })

  it('封顶在 94% 工作区，不会顶到屏幕边缘', () => {
    const size = pluginSize({ width: 3000, height: 2000 }, DEFAULT, AREA)
    expect(size.width).toBe(Math.round(1920 * 0.94))
    expect(size.height).toBe(Math.round(1040 * 0.94))
  })

  it('多显示器时按该显示器的工作区算上限', () => {
    const secondary = { x: 1920, y: 0, width: 1280, height: 720 }
    expect(pluginSize({ width: 2000, height: 600 }, DEFAULT, secondary)).toEqual({
      width: Math.round(1280 * 0.94),
      height: Math.round(720 * 0.94)
    })
  })

  it('没有记忆尺寸时默认值兜底（调用方传 DEFAULT）', () => {
    expect(pluginSize({ width: 600, height: 400 }, DEFAULT, AREA)).toEqual(DEFAULT)
  })
})

describe('centerInWorkArea', () => {
  it('把窗口摆在工作区正中', () => {
    expect(centerInWorkArea(AREA, DEFAULT)).toEqual({ x: 470, y: 160, width: 980, height: 720 })
  })

  it('带偏移的工作区（副屏 / 任务栏在左）同样居中', () => {
    const area = { x: 1920, y: 0, width: 1280, height: 720 }
    const rect = centerInWorkArea(area, { width: 900, height: 600 })
    expect(rect.x).toBe(1920 + Math.round((1280 - 900) / 2))
    expect(rect.y).toBe(Math.round((720 - 600) / 2))
  })

  it('奇数差值取整，不会出现半像素坐标', () => {
    const rect = centerInWorkArea({ x: 0, y: 0, width: 1001, height: 801 }, { width: 500, height: 400 })
    expect(Number.isInteger(rect.x)).toBe(true)
    expect(Number.isInteger(rect.y)).toBe(true)
    expect(rect.x).toBe(251)
    expect(rect.y).toBe(201)
  })
})
