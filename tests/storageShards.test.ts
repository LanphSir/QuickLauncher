import { describe, expect, it } from 'vitest'
import {
  formatBytes,
  overQuota,
  parseShard,
  PLUGIN_STORE_QUOTA_BYTES,
  safeId,
  serializeShard,
  shardName
} from '../src/main/services/storageShards'

describe('safeId', () => {
  it('把分隔符换成下划线，结果永远是单层目录名', () => {
    expect(safeId('com.example.app')).toBe('com.example.app')
    for (const evil of ['../../etc/passwd', 'a/b', 'a\\b', 'c:windows']) {
      const id = safeId(evil)
      expect(id).not.toMatch(/[/\\:]/)
      expect(id.startsWith('.')).toBe(false)
    }
  })

  it('纯点号的 id 不会退化成上级目录', () => {
    expect(safeId('..')).not.toBe('..')
    expect(safeId('.')).not.toBe('.')
    expect(safeId('.../../x')).not.toMatch(/^\./)
  })

  it('超长 id 截断，且空输入有兜底', () => {
    expect(safeId('a'.repeat(200))).toHaveLength(64)
    expect(safeId('')).toBe('_')
  })
})

describe('shardName', () => {
  it('同一 key 永远得到同一文件名（重启后还能找回数据）', () => {
    expect(shardName('settings')).toBe(shardName('settings'))
  })

  it('不同 key 不会撞名：哈希在前，slug 截断也不影响', () => {
    const a = shardName('user.prefix.one.alpha')
    const b = shardName('user.prefix.two.beta')
    expect(a).not.toBe(b)
  })

  it('文件名只含安全字符，且长度可控', () => {
    for (const key of ['中文键名', 'a/b\\c:d*e?f', 'x'.repeat(200), '']) {
      const name = shardName(key)
      expect(name).toMatch(/^[0-9a-f]{16}(-[\w.-]+)?$/)
      expect(name.length).toBeLessThanOrEqual(16 + 1 + 32)
    }
  })

  it('全空字符的 key 退化为纯哈希', () => {
    expect(shardName('中文')).toMatch(/^[0-9a-f]{16}-_$/)
    expect(shardName('..')).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('分片序列化', () => {
  it('往返保留原始 key 与值', () => {
    const shard = parseShard(serializeShard('剪贴板/历史', [1, 2, { a: true }]))
    expect(shard).toEqual({ key: '剪贴板/历史', value: [1, 2, { a: true }] })
  })

  it('坏文件返回 null，由调用方跳过单个键', () => {
    expect(parseShard('{')).toBeNull()
    expect(parseShard('[]')).toBeNull()
    expect(parseShard('null')).toBeNull()
    expect(parseShard('{"v":1}')).toBeNull()
    expect(parseShard('{"k":""}')).toBeNull()
  })

  it('值为 undefined 时归一成 null（JSON 里本来也没有 undefined）', () => {
    expect(parseShard('{"k":"a"}')).toEqual({ key: 'a', value: null })
  })
})

describe('overQuota', () => {
  const Q = PLUGIN_STORE_QUOTA_BYTES

  it('没存满时放行', () => {
    expect(overQuota(0, 0, 1024, Q)).toBe(false)
    expect(overQuota(Q - 10, 0, 10, Q)).toBe(false)
  })

  it('刚好超出 1 字节就拒绝', () => {
    expect(overQuota(Q, 0, 1, Q)).toBe(true)
  })

  it('覆盖已有键时先扣掉旧值再算（改小一点不该被旧体积拖累）', () => {
    // 已用满，但这次是把 1MB 的旧值换成 100 字节
    expect(overQuota(Q, 1024 * 1024, 100, Q)).toBe(false)
    // 换成比旧值大的还是会超
    expect(overQuota(Q, 1024 * 1024, 2 * 1024 * 1024, Q)).toBe(true)
  })

  it('上限为 0 或负数表示不限制', () => {
    expect(overQuota(10 ** 12, 0, 10 ** 12, 0)).toBe(false)
    expect(overQuota(10 ** 12, 0, 10 ** 12, -1)).toBe(false)
  })

  it('默认上限是 8MB', () => {
    expect(PLUGIN_STORE_QUOTA_BYTES).toBe(8 * 1024 * 1024)
    expect(overQuota(PLUGIN_STORE_QUOTA_BYTES, 0, 0)).toBe(false)
    expect(overQuota(PLUGIN_STORE_QUOTA_BYTES, 0, 1)).toBe(true)
  })
})

describe('formatBytes', () => {
  it('按量级选单位，给插件报错时能看懂', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(8 * 1024 * 1024)).toBe('8.0 MB')
  })

  it('不限制时显示 ∞', () => {
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('∞')
  })
})
