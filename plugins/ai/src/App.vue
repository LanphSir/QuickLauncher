<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import type {
  AiChatMessage,
  AiModelOption,
  AiSessionDetail,
  AiSessionMeta,
  AiStreamEvent
} from '../../../src/shared/ai'

const api = window.appapi

const sessions = ref<AiSessionMeta[]>([])
const current = ref<AiSessionDetail | null>(null)
const models = ref<AiModelOption[]>([])
const model = ref('')
const draft = ref('')
const busy = ref(false)
const error = ref('')
const usage = ref<{ input: number; output: number } | null>(null)
const toast = ref('')
const scroller = ref<HTMLElement | null>(null)
const composer = ref<HTMLTextAreaElement | null>(null)

const configured = computed(() => models.value.length > 0)
const messages = computed<AiChatMessage[]>(() => current.value?.messages ?? [])
const hasMessages = computed(() => messages.value.length > 0)

function textOf(message: AiChatMessage): string {
  return message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
}

function reasoningOf(message: AiChatMessage): string {
  return message.parts.map((p) => (p.type === 'reasoning' ? p.text : '')).join('')
}

function scrollToEnd(): void {
  void nextTick(() => {
    const el = scroller.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

function showToast(text: string): void {
  toast.value = text
  setTimeout(() => {
    if (toast.value === text) toast.value = ''
  }, 1600)
}

function findMessage(id: string): AiChatMessage | undefined {
  return messages.value.find((m) => m.id === id)
}

/** 增量拼接：同类型的连续片段合到最后一个 part，避免碎片化出几百个节点 */
function appendPart(id: string, kind: 'text' | 'reasoning', delta: string): void {
  const message = findMessage(id)
  if (!message) return
  const last = message.parts[message.parts.length - 1]
  if (last && last.type === kind) last.text += delta
  else message.parts.push({ type: kind, text: delta })
  scrollToEnd()
}

async function refreshSessions(): Promise<void> {
  sessions.value = await api.ai.sessions.list()
  // 标题是首条消息生成后才有意义的，列表要跟着刷新
  const active = current.value
  if (active) {
    const meta = sessions.value.find((s) => s.id === active.id)
    if (meta) active.title = meta.title
  }
}

async function openSession(id: string): Promise<void> {
  const detail = await api.ai.sessions.get(id)
  if (!detail) return
  current.value = detail
  usage.value = null
  if (detail.model && models.value.some((m) => m.id === detail.model)) model.value = detail.model
  else if (!model.value) model.value = models.value[0]?.id ?? ''
  scrollToEnd()
}

async function newSession(): Promise<void> {
  const detail = await api.ai.sessions.create(model.value || undefined)
  current.value = detail
  usage.value = null
  error.value = ''
  await refreshSessions()
  void nextTick(() => composer.value?.focus())
}

async function removeSession(session: AiSessionMeta): Promise<void> {
  if (!window.confirm(`删除「${session.title}」？消息会一起删掉，无法恢复。`)) return
  const r = await api.ai.sessions.remove(session.id)
  if (!r.ok) {
    error.value = r.message ?? '删除失败'
    return
  }
  await refreshSessions()
  if (current.value?.id === session.id) {
    if (sessions.value.length) await openSession(sessions.value[0].id)
    else await newSession()
  }
}

async function send(): Promise<void> {
  const text = draft.value.trim()
  if (!text || busy.value) return
  if (!configured.value) {
    error.value = '还没有配置模型：打开 设置 → AI，添加一个模型服务'
    return
  }
  error.value = ''
  // 懒建会话：打开插件不写盘、不占列表，真正发第一条消息时才创建
  if (!current.value) {
    current.value = await api.ai.sessions.create(model.value || undefined)
    await refreshSessions()
  }
  busy.value = true
  draft.value = ''

  // 乐观插入：界面立刻有反应，等主进程把真实消息落盘后以它为准
  const localId = `local-${Date.now()}`
  current.value.messages.push({
    id: localId,
    role: 'user',
    parts: [{ type: 'text', text }],
    createdAt: Date.now()
  })
  scrollToEnd()

  try {
    const r = await api.ai.send({
      sessionId: current.value.id,
      text,
      model: model.value || undefined
    })
    if (!r.ok) {
      error.value = r.message ?? '发送失败'
      busy.value = false
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    busy.value = false
  }
}

async function stop(): Promise<void> {
  if (!current.value) return
  await api.ai.stop(current.value.id)
}

async function copy(text: string): Promise<void> {
  if (!text) return
  await api.clipboard.writeText(text)
  showToast('已复制')
}

function onDelta(event: AiStreamEvent): void {
  // 切走会话后上一个会话的残流会继续到几帧：不是当前会话就丢掉，
  // 否则字会拼到别人的消息里（比丢几帧难查得多）
  if (!current.value || event.sessionId !== current.value.id) return

  if (event.type === 'start') {
    if (!findMessage(event.messageId)) {
      current.value.messages.push({
        id: event.messageId,
        role: 'assistant',
        parts: [],
        createdAt: Date.now(),
        model: event.model
      })
    }
    scrollToEnd()
    return
  }
  if (event.type === 'text') {
    appendPart(event.messageId, 'text', event.delta)
    return
  }
  if (event.type === 'reasoning') {
    appendPart(event.messageId, 'reasoning', event.delta)
    return
  }
  if (event.type === 'usage') {
    usage.value = { input: event.input, output: event.output }
    return
  }
  if (event.type === 'done') {
    const message = findMessage(event.messageId)
    if (message) {
      if (event.stopped) message.stopped = true
      if (event.error) message.error = event.error
    }
    busy.value = false
    void refreshSessions()
    return
  }
}

onMounted(async () => {
  api.ai.onDelta(onDelta)

  // 打开插件时把面板搜索词当草稿：搜「写个正则」再回车打开，不用重敲
  api.onQuery((payload) => {
    if (payload.query && !draft.value) {
      draft.value = payload.query
      void nextTick(() => composer.value?.focus())
    }
  })
  api.onShow(() => void refreshSessions())

  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    // 有草稿先清草稿：误按 Esc 直接退出会把刚打的东西弄丢
    if (draft.value) {
      draft.value = ''
      return
    }
    void api.exit()
  }
  window.addEventListener('keydown', onKey)
  onUnmounted(() => window.removeEventListener('keydown', onKey))

  models.value = await api.ai.models()
  model.value = models.value[0]?.id ?? ''
  await refreshSessions()
  // 有历史就开最近一条；没有就保持空态，等用户真的发消息再建会话
  if (sessions.value.length) await openSession(sessions.value[0].id)
})
</script>

<template>
  <div class="app">
    <aside class="side">
      <button class="new" title="新建会话" @click="newSession">
        <span class="plus">+</span>
        新会话
      </button>

      <div class="list">
        <button
          v-for="s in sessions"
          :key="s.id"
          class="item"
          :class="{ active: s.id === current?.id }"
          @click="openSession(s.id)"
        >
          <span class="title">{{ s.title }}</span>
          <span class="sub">{{ s.messageCount }} 条</span>
          <span class="del" title="删除会话" @click.stop="removeSession(s)">×</span>
        </button>
        <p v-if="!sessions.length" class="list-empty">还没有会话</p>
      </div>

      <div class="side-foot">
        <div v-if="usage" class="usage">本轮 {{ usage.input }} → {{ usage.output }} tokens</div>
        <div class="brand">QuickLauncher AI</div>
      </div>
    </aside>

    <main class="main">
      <header class="top">
        <select v-model="model" class="model" :disabled="!configured || busy">
          <option v-for="m in models" :key="m.id" :value="m.id">{{ m.providerName }} · {{ m.model }}</option>
          <option v-if="!models.length" value="">未配置模型</option>
        </select>
        <span class="spacer" />
        <button v-if="busy" class="stop" @click="stop">停止</button>
        <button class="ghost" :disabled="!hasMessages || busy" @click="newSession">清空</button>
      </header>

      <div ref="scroller" class="messages">
        <div v-if="!hasMessages" class="welcome">
          <div class="welcome-title">问点什么</div>
          <p v-if="configured">
            支持多轮对话与会话切换；回答流式输出，随时可以停止。按 Esc 退出插件。
          </p>
          <p v-else>
            还没配置模型。打开 <b>设置 → AI</b> 添加一个服务（DeepSeek / 通义 / Kimi / OpenAI / 本机 Ollama），
            填好密钥回来就能用。
          </p>
        </div>

        <div v-for="m in messages" :key="m.id" class="msg" :class="m.role">
          <div class="avatar">{{ m.role === 'user' ? '我' : 'AI' }}</div>
          <div class="body">
            <details v-if="reasoningOf(m)" class="reasoning">
              <summary>思考过程</summary>
              <div class="pre">{{ reasoningOf(m) }}</div>
            </details>
            <div v-if="textOf(m)" class="pre">{{ textOf(m) }}</div>
            <div v-else-if="!m.error && !m.stopped" class="typing">正在生成…</div>
            <div v-if="m.stopped" class="flag">已停止</div>
            <div v-if="m.error" class="flag err">{{ m.error }}</div>
            <div v-if="m.role === 'assistant' && textOf(m)" class="acts">
              <button @click="copy(textOf(m))">复制</button>
              <span v-if="m.model" class="model-tag">{{ m.model }}</span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="error" class="banner">{{ error }}</div>

      <div class="composer">
        <textarea
          ref="composer"
          v-model="draft"
          rows="3"
          spellcheck="false"
          placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"
          @keydown.enter.exact.prevent="send"
        />
        <div class="composer-actions">
          <span class="tip">{{ configured ? 'Enter 发送 · Esc 退出' : '先去 设置 → AI 配置模型' }}</span>
          <button class="send" :disabled="!draft.trim() || busy" @click="send">
            {{ busy ? '生成中' : '发送' }}
          </button>
        </div>
      </div>

      <div v-if="toast" class="toast">{{ toast }}</div>
    </main>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  height: 100vh;
  background: #fff;
  color: #1f2329;
  font-size: 13px;
}

.side {
  flex: none;
  width: 196px;
  display: flex;
  flex-direction: column;
  background: #f7f8fa;
  border-right: 1px solid #eef0f2;
  padding: 10px 8px;
}

.new {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  border-radius: 8px;
  background: #5b6ef5;
  color: #fff;
  font-size: 13px;
}

.new:hover {
  background: #4b5ee6;
}

.plus {
  font-size: 15px;
  line-height: 1;
}

.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.item {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 22px 7px 9px;
  border-radius: 8px;
  text-align: left;
}

.item:hover {
  background: #eef0f4;
}

.item.active {
  background: #e7ebfd;
}

.title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
}

.sub {
  font-size: 11px;
  color: #a1a6ad;
}

.del {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 16px;
  height: 16px;
  display: none;
  place-items: center;
  border-radius: 4px;
  color: #a1a6ad;
  font-size: 13px;
}

.item:hover .del {
  display: grid;
}

.del:hover {
  background: #dfe2e7;
  color: #d03050;
}

.list-empty {
  padding: 8px;
  font-size: 12px;
  color: #a1a6ad;
}

.side-foot {
  flex: none;
  padding: 8px 6px 2px;
  border-top: 1px solid #eef0f2;
}

.usage {
  font-size: 11px;
  color: #8f959e;
}

.brand {
  margin-top: 2px;
  font-size: 11px;
  color: #c2c6cc;
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}

.top {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  border-bottom: 1px solid #eef0f2;
}

.model {
  height: 28px;
  max-width: 320px;
  padding: 0 8px;
  border: 1px solid #e5e6eb;
  border-radius: 8px;
  background: #fff;
  font-size: 12.5px;
  color: #1f2329;
}

.spacer {
  flex: 1;
}

.stop,
.ghost {
  height: 28px;
  padding: 0 10px;
  border-radius: 8px;
  font-size: 12.5px;
}

.stop {
  background: #fdecee;
  color: #d03050;
}

.ghost {
  color: #5c6470;
}

.ghost:disabled,
.stop:disabled {
  opacity: 0.45;
}

.messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 18px 8px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.welcome {
  margin: auto;
  max-width: 420px;
  text-align: center;
  color: #8f959e;
  line-height: 1.8;
}

.welcome-title {
  font-size: 16px;
  color: #1f2329;
  margin-bottom: 6px;
}

.msg {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.msg.user {
  flex-direction: row-reverse;
}

.avatar {
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 11px;
  color: #fff;
  background: #b9bfc9;
}

.msg.assistant .avatar {
  background: #5b6ef5;
}

.body {
  min-width: 0;
  max-width: 78%;
}

.msg.user .body {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.pre {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.72;
  padding: 9px 12px;
  border-radius: 10px;
  background: #f5f6f8;
}

.msg.user .pre {
  background: #e7ebfd;
}

.reasoning {
  margin-bottom: 6px;
  font-size: 12px;
  color: #8f959e;
}

.reasoning summary {
  cursor: pointer;
  user-select: none;
}

.reasoning .pre {
  margin-top: 4px;
  background: #fafbfc;
  border: 1px dashed #e5e6eb;
  color: #6b7280;
}

.typing {
  color: #a1a6ad;
  font-size: 12.5px;
}

.flag {
  margin-top: 4px;
  font-size: 11.5px;
  color: #8f959e;
}

.flag.err {
  color: #d03050;
}

.acts {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

.acts button {
  font-size: 11.5px;
  color: #8f959e;
}

.acts button:hover {
  color: #5b6ef5;
}

.model-tag {
  font-size: 11px;
  color: #c2c6cc;
}

.banner {
  flex: none;
  margin: 0 14px 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: #fdecee;
  color: #d03050;
  font-size: 12px;
  line-height: 1.6;
}

.composer {
  flex: none;
  padding: 10px 14px 12px;
  border-top: 1px solid #eef0f2;
}

.composer textarea {
  width: 100%;
  resize: none;
  padding: 9px 11px;
  border: 1px solid #e5e6eb;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.6;
  color: #1f2329;
  outline: none;
}

.composer textarea:focus {
  border-color: #6b9cf7;
  box-shadow: 0 0 0 3px rgba(91, 110, 245, 0.12);
}

.composer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.tip {
  flex: 1;
  font-size: 11.5px;
  color: #a1a6ad;
}

.send {
  height: 30px;
  padding: 0 16px;
  border-radius: 8px;
  background: #5b6ef5;
  color: #fff;
  font-size: 13px;
}

.send:disabled {
  background: #c8cef8;
  cursor: default;
}

.toast {
  position: absolute;
  left: 50%;
  bottom: 96px;
  transform: translateX(-50%);
  padding: 6px 12px;
  border-radius: 8px;
  background: rgba(31, 35, 41, 0.86);
  color: #fff;
  font-size: 12px;
}
</style>
