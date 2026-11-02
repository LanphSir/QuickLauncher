/**
 * AI 通道实现。
 *
 * 全部标 `internalOnly`：这些通道花的是用户自己的额度，只有随应用发布的内置插件
 * （source === 'builtin'）能调。第三方插件即使声明了 `ai` 权限也会被网关拒掉。
 */
import { BrowserWindow, dialog } from 'electron'
import { attachBytes, attachPath } from '../../ai/attach'
import { sendMessage, stopRun } from '../../ai/chat'
import { answerConfirm } from '../../ai/confirm'
import { modelOptions } from '../../ai/provider'
import { getAiConfig } from '../../ai/settings'
import { createSession, deleteSession, getSession, listSessions, renameSession } from '../../ai/store'
import { grantedTools } from '../../ai/tools'
import { handlePluginToolReply } from '../../ai/toolHost'
import { MAX_ATTACHMENTS } from '../../../shared/ai'
import { defineApi } from './define'
import { fail, jsonValue, object, optional, str, strArray } from './validate'

/** 会话 id 是 randomUUID：只允许字母数字与连字符，避免被当成路径片段 */
const sessionId = str('sessionId', { max: 64, pattern: /^[\w-]+$/ })
const modelRef = str('model', { max: 200, pattern: /^[\w.-]+\/[\w.:/@-]+$/ })

/** base64 体积：8MB 原始字节编码后约 10.7MB 字符，给到 12MB 留余量 */
const MAX_BASE64 = 12 * 1024 * 1024

export const aiApi = [
  defineApi('plugin:ai.chat.send', {
    internalOnly: true,
    parse: object({
      sessionId: optional(sessionId),
      text: str('text', { max: 200_000, min: 0 }),
      model: optional(modelRef),
      attachIds: optional(strArray('attachIds', { max: MAX_ATTACHMENTS, itemMax: 64, pattern: /^[\w-]+$/ }))
    }),
    // sender 就是 AI 插件页：流式事件推给它，不信 payload 里的任何身份字段
    handle: ({ sender }, req) => sendMessage(sender, req)
  }),

  /**
   * 原生对话框选文件。父窗口取 sender 所在的窗口——
   * 用 BrowserWindow.getFocusedWindow() 在分离窗口场景下会挂错地方（甚至弹到主面板后面）。
   */
  defineApi('plugin:ai.attach.pick', {
    internalOnly: true,
    handle: async ({ sender }) => {
      const parent = BrowserWindow.fromWebContents(sender)
      const result = parent
        ? await dialog.showOpenDialog(parent, {
            title: '选择要发给 AI 的文件',
            properties: ['openFile', 'multiSelections'],
            filters: [
              { name: '支持的文件', extensions: ['txt', 'md', 'json', 'log', 'csv', 'pdf', 'docx', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ts', 'js', 'py', 'go', 'yaml', 'yml'] },
              { name: '全部文件', extensions: ['*'] }
            ]
          })
        : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
      if (result.canceled || !result.filePaths.length) return []

      // 并行处理：几个文件里有一份大 PDF 不该让其他文件排队等它
      const picked = result.filePaths.slice(0, MAX_ATTACHMENTS)
      return Promise.all(picked.map((path) => attachPath(path)))
    }
  }),

  /** 拖拽进来的文件：base64 → 字节，后面的判定与解析全在主进程 */
  defineApi('plugin:ai.attach.bytes', {
    internalOnly: true,
    parse: object({
      name: str('name', { max: 255 }),
      data: str('data', { max: MAX_BASE64 })
    }),
    handle: async (_ctx, { name, data }) => {
      const bytes = Buffer.from(data, 'base64')
      if (!bytes.length) fail('文件内容为空或不是合法的 base64')
      return attachBytes({ name, bytes })
    }
  }),

  defineApi('plugin:ai.chat.stop', {
    internalOnly: true,
    parse: object({ sessionId }),
    handle: (_ctx, { sessionId: id }) => {
      const stopped = stopRun(id)
      return { ok: stopped.ok, message: stopped.ok ? undefined : '当前没有正在生成的消息' }
    }
  }),

  defineApi('plugin:ai.models', {
    internalOnly: true,
    handle: () => modelOptions(getAiConfig().providers)
  }),

  /**
   * 已授权的插件工具清单（v0.6.2）。
   * 与设置页的 panel:ai-tools 不同：那条给用户看「谁声明了什么」，
   * 这条给模型用，只含授权且可用的，未授权一律不下发。
   */
  defineApi('plugin:ai.tools', {
    internalOnly: true,
    handle: () => grantedTools()
  }),

  /**
   * 工具执行回执（v0.6.3）。
   *
   * 刻意**不是** internalOnly：第三方插件正是被调用的那一方。
   * 身份由网关锚定（sender → 插件记录），toolHost 再核对「这个插件是不是
   * 正等这个 callId 的那一个」，两层都过才认。
   */
  defineApi('plugin:ai.tool.reply', {
    parse: object({
      callId: str('callId', { max: 80, pattern: /^[\w-]+$/ }),
      ok: (input) => input === true,
      result: optional(jsonValue('result', 64 * 1024)),
      error: optional(str('error', { max: 2000 }))
    }),
    handle: ({ sender }, reply) => handlePluginToolReply(sender, reply)
  }),

  /**
   * 风险确认的答复。internalOnly：能自批的工具授权等于没有授权。
   * 返回 ok=false 不是错误（多半是超时后按钮才被点到），界面直接收起即可。
   */
  defineApi('plugin:ai.tool.confirm', {
    internalOnly: true,
    parse: object({
      requestId: str('requestId', { max: 64, pattern: /^[\w-]+$/ }),
      allow: (input) => input === true,
      remember: optional((input) => input === true)
    }),
    handle: (_ctx, { requestId, allow, remember }) => {
      const handled = answerConfirm(requestId, allow, remember === true)
      return { ok: handled, message: handled ? undefined : '这次确认已经结束（可能已超时）' }
    }
  }),

  defineApi('plugin:ai.session.list', {
    internalOnly: true,
    handle: () => listSessions()
  }),

  defineApi('plugin:ai.session.get', {
    internalOnly: true,
    parse: sessionId,
    handle: (_ctx, id) => getSession(id)
  }),

  defineApi('plugin:ai.session.create', {
    internalOnly: true,
    parse: object({ model: optional(modelRef) }),
    handle: (_ctx, { model }) => createSession(model)
  }),

  defineApi('plugin:ai.session.rename', {
    internalOnly: true,
    parse: object({ id: sessionId, title: str('title', { max: 60 }) }),
    handle: (_ctx, { id, title }) => {
      const ok = renameSession(id, title)
      return { ok, message: ok ? undefined : '重命名失败（会话可能已被删除）' }
    }
  }),

  defineApi('plugin:ai.session.delete', {
    internalOnly: true,
    parse: sessionId,
    handle: (_ctx, id) => {
      // 先停掉在飞的请求：否则删完文件，流还在往里写
      stopRun(id)
      const ok = deleteSession(id)
      if (!ok) fail('会话不存在或删除失败')
      return { ok }
    }
  })
]
