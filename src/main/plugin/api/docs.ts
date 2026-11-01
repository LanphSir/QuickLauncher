import { pluginDocs } from '../../services/docs'
import { defineApi } from './define'
import { str } from './validate'

/** 句柄只收纯文件名；services/docs 里还会再做一次 basename 与扩展名校验 */
const docId = str('id', { max: 255, pattern: /^[^\\/:*?"<>|]+$/ })

/** 插件文档库：路径始终留在主进程，插件只按文件句柄收发内容 */
export const docsApi = [
  defineApi('plugin:docs.list', {
    handle: ({ rec }) => pluginDocs.list(rec.manifest.id)
  }),
  defineApi('plugin:docs.import', {
    handle: ({ rec }) => pluginDocs.importFromDialog(rec.manifest.id)
  }),
  defineApi('plugin:docs.read', {
    parse: docId,
    handle: ({ rec }, id) => pluginDocs.read(rec.manifest.id, id)
  }),
  defineApi('plugin:docs.remove', {
    parse: docId,
    handle: ({ rec }, id) => pluginDocs.remove(rec.manifest.id, id)
  }),
  defineApi('plugin:docs.reveal', {
    handle: ({ rec }) => pluginDocs.reveal(rec.manifest.id)
  })
]
