import { describe, expect, it } from 'vitest'
import { pickEvictions, type LruCandidate } from '../src/main/windows/viewLru'

const entry = (id: string, protect = false): LruCandidate => ({ id, protect })

describe('pickEvictions', () => {
  it('未超上限时不淘汰', () => {
    expect(pickEvictions([entry('a'), entry('b')], 5)).toEqual([])
  })

  it('从最久未用的开始淘汰，直到回到上限', () => {
    const order = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => entry(id))
    expect(pickEvictions(order, 5)).toEqual(['a', 'b'])
  })

  it('跳过受保护条目，把额度让给更"新"的普通条目', () => {
    const order = [entry('active', true), entry('b'), entry('c'), entry('d')]
    expect(pickEvictions(order, 2)).toEqual(['b', 'c'])
  })

  it('全是受保护条目时宁可超限，也不关掉用户正看着的视图', () => {
    const order = [entry('a', true), entry('b', true), entry('c', true)]
    expect(pickEvictions(order, 1)).toEqual([])
  })

  it('上限为 0 时清空所有可淘汰条目', () => {
    expect(pickEvictions([entry('a'), entry('b')], 0)).toEqual(['a', 'b'])
  })

  it('非法上限不触发任何淘汰（避免配置写错就清场）', () => {
    expect(pickEvictions([entry('a'), entry('b')], Number.POSITIVE_INFINITY)).toEqual([])
    expect(pickEvictions([entry('a'), entry('b')], Number.NaN)).toEqual([])
  })
})
