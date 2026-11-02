/**
 * AI 通道实现。
 *
 * 全部标 `internalOnly`：这些通道花的是用户自己的额度，只有随应用发布的内置插件
 * （source === 'builtin'）能调。第三方插件即使声明了 `ai` 权限也会被网关拒掉。
 */
import { sendMessage, stopRun } from '../../ai/chat'
import { modelOptions } from '../../ai/provider'
import { getAiConfig } from '../../ai/settings'
import { createSession, deleteSession, getSession, listSessions, renameSession } from '../../ai/store'
import { defineApi } from './define'
import { fail, object, optional, str } from './validate'

/** 会话 id 是 randomUUID：只允许字母数字与连字符，避免被当成路径片段 */
const sessionId = str('sessionId', { max: 64, pattern: /^[\w-]+$/ })
const modelRef = str('model', { max: 200, pattern: /^[\w.-]+\/[\w.:/@-]+$/ })

export const aiApi = [
  defineApi('plugin:ai.chat.send', {
    internalOnly: true,
    parse: object({
      sessionId: optional(sessionId),
      text: str('text', { max: 200_000 }),
      model: optional(modelRef)
    }),
    // sender 就是 AI 插件页：流式事件推给它，不信 payload 里的任何身份字段
    handle: ({ sender }, req) => sendMessage(sender, req)
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
