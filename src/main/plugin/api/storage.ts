import { pluginStorage } from '../../services/storage'
import { defineApi } from './define'
import { fail, jsonValue, object, str, type Parser } from './validate'

/** 单值上限：存储是同步写盘的，放任插件塞几十 MB 会卡死主进程 */
const MAX_VALUE_BYTES = 2 * 1024 * 1024
/** 对象字面量赋值会命中 __proto__ 的 setter，显式挡掉 */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function storageKey(): Parser<string> {
  const base = str('key', { max: 200 })
  return (input) => {
    const key = base(input)
    if (RESERVED_KEYS.has(key)) fail('key 使用了保留名')
    return key
  }
}

const key = storageKey()

export const storageApi = [
  defineApi('plugin:storage.get', {
    parse: key,
    handle: ({ rec }, k) => pluginStorage.get(rec.manifest.id, k)
  }),
  defineApi('plugin:storage.set', {
    parse: object({ key, value: jsonValue('value', MAX_VALUE_BYTES) }),
    handle: ({ rec }, { key: k, value }) => {
      const result = pluginStorage.set(rec.manifest.id, k, value)
      // 配额满/写盘失败要让插件看到原因，不能悄悄返回 false 让它以为存上了
      if (!result.ok) throw new Error(result.message ?? `写入失败：${k}`)
      return true
    }
  }),
  defineApi('plugin:storage.remove', {
    parse: key,
    handle: ({ rec }, k) => pluginStorage.remove(rec.manifest.id, k)
  }),
  defineApi('plugin:storage.keys', {
    handle: ({ rec }) => pluginStorage.keys(rec.manifest.id)
  })
]
