<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import type {
  AiAttachResult,
  AiChatMessage,
  AiFilePart,
  AiMessagePart,
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

/** 待发附件：attachId 交给主进程换回解析结果，part 只用于本地展示 */
interface PendingFile {
  attachId: string
  part: AiFilePart
}
const attachments = ref<PendingFile[]>([])
const picking = ref(false)
const dragging = ref(false)
/** 面板右键「用 AI 询问」带过来的条目信息，只作用于紧接着的这一条消息 */
const askAbout = ref<Record<string, string> | null>(null)

const configured = computed(() => models.value.length > 0)
const messages = computed<AiChatMessage[]>(() => current.value?.messages ?? [])
const hasMessages = computed(() => messages.value.length > 0)

function textOf(message: AiChatMessage): string {
  return message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
}

function reasoningOf(message: AiChatMessage): string {
  return message.parts.map((p) => (p.type === 'reasoning' ? p.text : '')).join('')
}

function filesOf(message: AiChatMessage): AiFilePart[] {
  return message.parts.filter((p): p is AiFilePart => p.type === 'file')
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 附件下方那行小字：既要说明它是什么，也要说明"读全了没有" */
function fileSub(file: AiFilePart): string {
  if (file.kind === 'image') return `图片 · ${humanSize(file.size)}`
  const chars = file.text?.length ?? 0
  const base = `${humanSize(file.size)} · 已读 ${chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : chars} 字`
  return file.fullLength && file.fullLength > chars ? `${base}（原文 ${file.fullLength} 字，已截断）` : base
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

/** 单个附件处理结果落地：成功进待发区，失败把原因说出来（而不是静默吞掉） */
function acceptResult(result: AiAttachResult): void {
  if (result.ok && result.attachId && result.part) {
    attachments.value.push({ attachId: result.attachId, part: result.part })
    return
  }
  showToast(result.message ?? '这个文件读不了')
}

function removeAttachment(index: number): void {
  attachments.value.splice(index, 1)
}

/**
 * 把面板带来的条目信息还原成一段上下文。
 * 只列结构化字段而不写"用户想知道这个应用的事"——后者是模型看一眼就懂的事，
 * 写出来只会占 token 还容易把模型引到套话上。
 */
function renderAskAbout(about: Record<string, string>): string {
  const lines = [`【关于应用】${about.name}${about.type ? `（${about.type}）` : ''}`]
  if (about.command) lines.push(`启动命令：${about.command}`)
  if (about.dir) lines.push(`目录：${about.dir}`)
  if (about.description) lines.push(`说明：${about.description}`)
  if (about.keywords) lines.push(`关键词：${about.keywords}`)
  if (about.hotkey) lines.push(`快捷键：${about.hotkey}`)
  return lines.join('\n')
}

/** 原生对话框选文件：主进程逐个解析，失败的项带原因回来，不影响其他文件 */
async function pickFiles(): Promise<void> {
  if (picking.value || busy.value) return
  picking.value = true
  try {
    const results = await api.ai.pick()
    const failed = results.filter((r) => !r.ok)
    for (const r of results) acceptResult(r)
    if (failed.length && results.length === failed.length) {
      error.value = failed[0].message ?? '选中的文件都读不了'
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    picking.value = false
  }
}

/** ArrayBuffer → base64。分块避免大文件时展开参数把调用栈撑爆 */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

async function onDrop(event: DragEvent): Promise<void> {
  dragging.value = false
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (!files.length) return
  for (const file of files) {
    try {
      const buffer = await file.arrayBuffer()
      acceptResult(await api.ai.attach({ name: file.name, data: toBase64(buffer) }))
    } catch (err) {
      showToast(`${file.name} 读取失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** 拖拽时只认"带文件"的拖入，避免拖一段文字进来也弹遮罩 */
function onDragOver(event: DragEvent): void {
  if (!event.dataTransfer?.types?.includes('Files')) return
  event.preventDefault()
  dragging.value = true
}

/** 鼠标移到子元素上也会触发 dragleave，只有真正离开整个区域才收起遮罩 */
function onDragLeave(event: DragEvent): void {
  const next = event.relatedTarget as Node | null
  const host = event.currentTarget as HTMLElement | null
  if (next && host?.contains(next)) return
  dragging.value = false
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
  const files = attachments.value
  const about = askAbout.value
  // 只发一张图、不写字也是合理用法，所以判断条件不是"文本非空"
  if ((!text && !files.length) || busy.value) return
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
  // 上下文拼进正文：界面上要看得见"这句话是带着哪个应用问的"，
  // 只放在 system 里会让用户觉得模型在凭空猜
  const finalText = about ? `${renderAskAbout(about)}\n\n${text}`.trim() : text

  busy.value = true
  draft.value = ''
  attachments.value = []
  askAbout.value = null

  // 乐观插入：界面立刻有反应，等主进程把真实消息落盘后以它为准
  const localId = `local-${Date.now()}`
  const parts: AiMessagePart[] = []
  if (finalText) parts.push({ type: 'text', text: finalText })
  for (const file of files) parts.push(file.part)
  current.value.messages.push({
    id: localId,
    role: 'user',
    parts,
    createdAt: Date.now()
  })
  scrollToEnd()

  try {
    const r = await api.ai.send({
      sessionId: current.value.id,
      text: finalText,
      model: model.value || undefined,
      attachIds: files.map((f) => f.attachId)
    })
    if (!r.ok) {
      error.value = r.message ?? '发送失败'
      busy.value = false
      // 主进程没落盘，本地这条不该留在界面上；把草稿与附件还给用户，
      // 否则换模型重发就得重新拖一遍文件
      const index = current.value.messages.findIndex((m) => m.id === localId)
      if (index >= 0) current.value.messages.splice(index, 1)
      if (text) draft.value = text
      attachments.value = files
      askAbout.value = about
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
    // 超预算时的两种"被裁剪"要让用户看见，否则他会以为模型忘了前面聊过什么
    if (event.dropped) {
      showToast(`本轮省略了 ${event.dropped} 条较早的消息`)
    } else if (event.truncated) {
      showToast('这条消息过长，发送时已截断中间部分')
    }
    void refreshSessions()
    return
  }
  if (event.type === 'summary') {
    // 摘要生成完只做一次轻提示：它落在下轮请求里，不会改变当前这条回答
    showToast('较早的对话已压缩成摘要')
    return
  }
}

onMounted(async () => {
  api.ai.onDelta(onDelta)

  // 打开插件时把面板搜索词当草稿：搜「写个正则」再回车打开，不用重敲
  api.onQuery((payload) => {
    // 面板右键「用 AI 询问」会把条目信息放进 intent.askAbout
    const raw = (payload.intent as Record<string, unknown> | undefined)?.askAbout
    if (raw && typeof raw === 'object') {
      const about: Record<string, string> = {}
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === 'string' && value.trim()) about[key] = value.trim()
      }
      if (Object.keys(about).length) askAbout.value = about
    }
    if (payload.query && !draft.value) {
      draft.value = payload.query
      void nextTick(() => composer.value?.focus())
    }
  })
  api.onShow(() => void refreshSessions())

  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    // 有草稿或待发附件先清掉：误按 Esc 直接退出会把刚准备的东西弄丢
    if (draft.value || attachments.value.length || askAbout.value) {
      draft.value = ''
      attachments.value = []
      askAbout.value = null
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

    <main class="main" @dragover="onDragOver" @dragleave="onDragLeave" @drop.prevent="onDrop">
      <div v-if="dragging" class="drop-mask">
        <div class="drop-box">放开即可添加附件</div>
      </div>
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
            支持多轮对话与会话切换；回答流式输出，随时可以停止。文件可以拖进来，或点「添加文件」。
            按 Esc 退出插件。
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

            <div v-if="filesOf(m).length" class="files">
              <div v-for="(f, i) in filesOf(m)" :key="i" class="file" :class="{ bad: f.error }">
                <img v-if="f.preview" :src="f.preview" class="thumb" alt="" />
                <div v-else class="file-tag">{{ f.kind === 'image' ? 'IMG' : 'TXT' }}</div>
                <div class="file-info">
                  <div class="file-name" :title="f.name">{{ f.name }}</div>
                  <div class="file-sub">{{ f.error ? f.error : fileSub(f) }}</div>
                </div>
                <details v-if="f.text" class="file-more">
                  <summary>查看内容</summary>
                  <div class="pre file-text">{{ f.text }}</div>
                </details>
              </div>
            </div>

            <div v-if="textOf(m)" class="pre">{{ textOf(m) }}</div>
            <div v-else-if="!m.error && !m.stopped && !filesOf(m).length" class="typing">正在生成…</div>
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
        <div v-if="askAbout" class="ask-chip">
          <span class="ask-label">关于</span>
          <b class="ask-name">{{ askAbout.name }}</b>
          <button class="chip-del" title="不再引用" @click="askAbout = null">×</button>
        </div>
        <div v-if="attachments.length" class="attach-bar">
          <div v-for="(a, i) in attachments" :key="a.attachId" class="chip" :class="{ bad: a.part.error }">
            <img v-if="a.part.preview" :src="a.part.preview" class="chip-thumb" alt="" />
            <span v-else class="chip-tag">{{ a.part.kind === 'image' ? 'IMG' : 'TXT' }}</span>
            <span class="chip-name" :title="a.part.name">{{ a.part.name }}</span>
            <button class="chip-del" title="移除" @click="removeAttachment(i)">×</button>
          </div>
        </div>
        <textarea
          ref="composer"
          v-model="draft"
          rows="3"
          spellcheck="false"
          placeholder="问点什么…（Enter 发送，Shift+Enter 换行；文件可直接拖进来）"
          @keydown.enter.exact.prevent="send"
        />
        <div class="composer-actions">
          <button class="ghost attach-btn" :disabled="picking || busy" @click="pickFiles">
            {{ picking ? '读取中…' : '添加文件' }}
          </button>
          <span class="tip">{{ configured ? 'Enter 发送 · Esc 退出' : '先去 设置 → AI 配置模型' }}</span>
          <button class="send" :disabled="(!draft.trim() && !attachments.length) || busy" @click="send">
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

/* ---- 拖拽遮罩 ---- */
.drop-mask {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: grid;
  place-items: center;
  background: rgba(91, 110, 245, 0.08);
  backdrop-filter: blur(1px);
}

.drop-box {
  padding: 14px 22px;
  border: 2px dashed #5b6ef5;
  border-radius: 12px;
  background: #fff;
  color: #5b6ef5;
  font-size: 13px;
}

/* ---- 消息里的附件 ---- */
.files {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 6px;
}

.file {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border: 1px solid #eef0f2;
  border-radius: 10px;
  background: #fafbfc;
}

.msg.user .file {
  background: #eef1fe;
  border-color: #dfe4fb;
}

.file.bad {
  border-color: #f5c2c7;
  background: #fdf3f4;
}

.thumb {
  width: 40px;
  height: 40px;
  object-fit: cover;
  border-radius: 6px;
  flex: none;
}

.file-tag {
  flex: none;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 6px;
  background: #e7e9ee;
  color: #7b8189;
  font-size: 10px;
  letter-spacing: 0.5px;
}

.file-info {
  flex: 1;
  min-width: 0;
}

.file-name {
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-sub {
  margin-top: 1px;
  font-size: 11px;
  color: #8f959e;
}

.file.bad .file-sub {
  color: #d03050;
}

.file-more {
  flex-basis: 100%;
  font-size: 11.5px;
  color: #8f959e;
}

.file-more summary {
  cursor: pointer;
  user-select: none;
}

.file-text {
  margin-top: 4px;
  max-height: 240px;
  overflow: auto;
  font-size: 11.5px;
  line-height: 1.6;
  background: #fff;
  border: 1px solid #eef0f2;
}

/* ---- 待发附件条 ---- */
.ask-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  margin-bottom: 8px;
  padding: 3px 6px 3px 8px;
  border: 1px solid #dfe4fb;
  border-radius: 8px;
  background: #f2f4fe;
  font-size: 12px;
  color: #5c6470;
}

.ask-label {
  color: #8f959e;
}

.ask-name {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #4a5bd0;
  font-weight: 600;
}

.attach-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  padding: 3px 6px 3px 3px;
  border: 1px solid #e5e6eb;
  border-radius: 8px;
  background: #fafbfc;
}

.chip.bad {
  border-color: #f5c2c7;
  background: #fdf3f4;
}

.chip-thumb {
  width: 26px;
  height: 26px;
  object-fit: cover;
  border-radius: 5px;
  flex: none;
}

.chip-tag {
  flex: none;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 5px;
  background: #e7e9ee;
  color: #7b8189;
  font-size: 9px;
}

.chip-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: #5c6470;
}

.chip-del {
  flex: none;
  width: 16px;
  height: 16px;
  display: grid;
  place-items: center;
  border-radius: 4px;
  color: #a1a6ad;
  font-size: 13px;
}

.chip-del:hover {
  background: #eef0f2;
  color: #d03050;
}

.attach-btn {
  padding: 0 10px;
  height: 28px;
  border-radius: 8px;
  font-size: 12.5px;
  color: #5c6470;
  background: #f4f5f7;
}

.attach-btn:hover:not(:disabled) {
  background: #eceef1;
}

.attach-btn:disabled {
  opacity: 0.45;
}

</style>
