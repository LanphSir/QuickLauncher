import { clipboard, Notification, shell } from 'electron'
import { detachBySender, exitBySender, hideBySender } from '../../windows/pluginHost'
import { defineApi } from './define'
import { httpUrl, object, optional, str } from './validate'

/** 剪贴板文本上限：正常用法远低于此，超了基本都是误用 */
const MAX_CLIP_TEXT = 2 * 1024 * 1024

/** 系统能力 + 窗口控制：clipboard / notify / shell 需权限，窗口与退出无需权限 */
export const systemApi = [
  defineApi('plugin:clipboard.readText', {
    handle: () => clipboard.readText()
  }),
  defineApi('plugin:clipboard.writeText', {
    parse: str('text', { max: MAX_CLIP_TEXT, min: 0 }),
    handle: (_ctx, text) => {
      clipboard.writeText(text)
      return true
    }
  }),
  defineApi('plugin:notify', {
    parse: object({
      title: optional(str('title', { max: 120, min: 0 })),
      body: optional(str('body', { max: 2000, min: 0 }))
    }),
    handle: ({ rec }, { title, body }) => {
      new Notification({ title: title || rec.manifest.name, body: body ?? '' }).show()
      return true
    }
  }),
  defineApi('plugin:shell.openExternal', {
    parse: httpUrl('url'),
    handle: (_ctx, url) => {
      void shell.openExternal(url)
      return true
    }
  }),
  defineApi('plugin:window.hide', {
    handle: ({ sender }) => {
      hideBySender(sender)
      return true
    }
  }),
  defineApi('plugin:window.detach', {
    handle: ({ sender }) => detachBySender(sender)
  }),
  defineApi('plugin:exit', {
    handle: ({ sender }) => {
      exitBySender(sender)
      return true
    }
  })
]
