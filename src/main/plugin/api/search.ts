import { clearSearchEntries, setSearchEntries } from '../../services/searchIndex'
import { defineApi } from './define'

/**
 * 搜索贡献：条目是插件提交的不可信数据，校验与裁剪在 services/searchIndex
 * （normalizeEntries）里统一做，这里只负责把调用方 id 锚上去。
 */
export const searchApi = [
  defineApi('plugin:search.set', {
    handle: ({ rec }, entries) => setSearchEntries(rec.manifest.id, entries)
  }),
  defineApi('plugin:search.clear', {
    handle: ({ rec }) => clearSearchEntries(rec.manifest.id)
  })
]
