<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import type {
  AiAttachResult,
  AiChatMessage,
  AiConfirmRequest,
  AiFilePart,
  AiMessagePart,
  AiModelOption,
  AiSessionDetail,
  AiSessionMeta,
  AiStreamEvent,
  AiToolCallPart,
  AiToolResultPart
} from '../../../src/shared/ai'
import PopMenu from './components/PopMenu.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import { MENU_W, type MenuItem } from './menu'

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
/**
 * 已授权给 AI 的插件工具数量。
 * 只用来给用户一句提示——「模型手上有没有工具」直接影响它该怎么答；
 * 具体有哪些工具在设置 → AI → AI 工具里看。
 */
const toolCount = ref(0)

/**
 * 工具调用的风险确认（v0.6.3）。
 *
 * 确认框必须画在这一页里，而不是主面板的核心浮层：插件视图是原生层，
 * 盖在核心渲染层之上，那边的弹窗再漂亮也会被这段对话挡在后面。
 */
const confirmReq = ref<AiConfirmRequest | null>(null)
const rememberConfirm = ref(false)

async function answerConfirm(allow: boolean): Promise<void> {
  const req = confirmReq.value
  if (!req) return
  confirmReq.value = null
  try {
    await api.ai.confirmTool(req.requestId, allow, allow && rememberConfirm.value)
  } catch {
    // 超时后按钮才被点到：请求已经结束，界面收起就够了，不必再报错
  }
  rememberConfirm.value = false
}

async function refreshToolCount(): Promise<void> {
  try {
    toolCount.value = (await api.ai.tools()).length
  } catch {
    toolCount.value = 0
  }
}

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

/** 消息正文里要按顺序渲染的部分：推理单独折叠、工具结果挂回它对应的调用上 */
function bodyParts(message: AiChatMessage): AiMessagePart[] {
  return message.parts.filter((p) => p.type !== 'reasoning' && p.type !== 'tool_result')
}

function resultOf(message: AiChatMessage, callId: string): AiToolResultPart | undefined {
  return message.parts.find((p): p is AiToolResultPart => p.type === 'tool_result' && p.callId === callId)
}

function hasToolParts(message: AiChatMessage): boolean {
  return message.parts.some((p) => p.type === 'tool_call')
}

/** 还没拿到结果 = 正在执行（界面上转圈的那个） */
function toolRunning(message: AiChatMessage, call: AiToolCallPart): boolean {
  return !resultOf(message, call.callId)
}

/** 风险标签：只读 / 会改动 / 高风险。用户看一眼就知道这次要不要细看参数 */
const RISK_LABEL: Record<string, string> = { read: '只读', write: '会改动', dangerous: '高风险' }

function riskLabel(risk: string): string {
  return RISK_LABEL[risk] ?? risk
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

/* ---------------- 会话条目操作：··· 菜单 / 右键 / 行内重命名 / 自绘确认 ---------------- */

/** 菜单锚点与目标。x/y 已经是"菜单左上角"的位置，由触发方式决定 */
const menu = ref<{ x: number; y: number; session: AiSessionMeta } | null>(null)
const renamingId = ref('')
const renameDraft = ref('')
const pendingDelete = ref<AiSessionMeta | null>(null)

const sessionMenuItems: MenuItem[] = [
  { key: 'rename', label: '重命名', icon: 'rename' },
  { key: 'delete', label: '删除会话', icon: 'delete', danger: true }
]

/**
 * 打开菜单。点「···」时把菜单右边缘对齐按钮，右键时跟随鼠标——
 * 两种入口给同一个菜单，但锚点要各自自然，否则右键出来的菜单会飘在光标左上。
 */
function openMenu(session: AiSessionMeta, event: MouseEvent, fromButton = false): void {
  event.stopPropagation()
  if (fromButton) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    // 优先右对齐按钮；按钮贴着窗口左边缘时右对齐会把菜单顶出视口，改为左对齐
    const rightAligned = rect.right - MENU_W
    menu.value = { x: rightAligned < 8 ? rect.left - 4 : rightAligned, y: rect.bottom + 5, session }
  } else {
    menu.value = { x: event.clientX, y: event.clientY, session }
  }
}

function onMenuPick(key: string): void {
  const target = menu.value?.session
  menu.value = null
  if (!target) return
  if (key === 'rename') startRename(target)
  else if (key === 'delete') pendingDelete.value = target
}

/** 行内重命名：不弹二级输入框，就地改成输入态，改完回车落地 */
function startRename(session: AiSessionMeta): void {
  renamingId.value = session.id
  renameDraft.value = session.title
  void nextTick(() => {
    const input = document.querySelector<HTMLInputElement>('.item .rename-input')
    input?.focus()
    input?.select()
  })
}

function cancelRename(): void {
  renamingId.value = ''
}

async function commitRename(): Promise<void> {
  const id = renamingId.value
  if (!id) return
  // 先退出编辑态：blur 会再触发一次本函数，靠这一行让第二次直接返回
  renamingId.value = ''
  const title = renameDraft.value.trim()
  const session = sessions.value.find((s) => s.id === id)
  if (!session || !title || title === session.title) return
  const r = await api.ai.sessions.rename(id, title)
  if (!r.ok) {
    error.value = r.message ?? '重命名失败'
    return
  }
  // 本地改掉就够：标题只有一个来源，重拉列表反而会让侧栏闪一下
  session.title = title
  if (current.value?.id === id) current.value.title = title
}

async function doDelete(): Promise<void> {
  const target = pendingDelete.value
  pendingDelete.value = null
  if (!target) return
  const r = await api.ai.sessions.remove(target.id)
  if (!r.ok) {
    error.value = r.message ?? '删除失败'
    return
  }
  await refreshSessions()
  if (current.value?.id === target.id) {
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
  /*
   * 确认请求**不受会话过滤**：用户可能已经切到别的会话在看历史，
   * 但那个正在跑的对话马上要动他的东西。丢掉这条事件等于让工具一直等到超时
   * ——而且用户完全不知道发生过什么。
   */
  if (event.type === 'tool-confirm') {
    confirmReq.value = event.request
    rememberConfirm.value = false
    return
  }
  if (event.type === 'tool-confirm-close') {
    if (confirmReq.value?.requestId === event.requestId) confirmReq.value = null
    return
  }

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
  if (event.type === 'tool-call') {
    const message = findMessage(event.messageId)
    // 同一 callId 只插一次：重复事件（重连、多路推送）会让界面上出现两张一样的卡片
    if (message && !message.parts.some((p) => p.type === 'tool_call' && p.callId === event.call.callId)) {
      message.parts.push(event.call)
    }
    scrollToEnd()
    return
  }
  if (event.type === 'tool-result') {
    const message = findMessage(event.messageId)
    if (message && !message.parts.some((p) => p.type === 'tool_result' && p.callId === event.result.callId)) {
      message.parts.push(event.result)
    }
    scrollToEnd()
    return
  }
  if (event.type === 'done') {
    const message = findMessage(event.messageId)
    if (message) {
      if (event.stopped) message.stopped = true
      if (event.error) message.error = event.error
    }
    // 生成结束时不该还留着确认框：那一轮已经收尾了
    confirmReq.value = null
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
  void refreshToolCount()

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
  api.onShow(() => {
    void refreshSessions()
    // 用户可能刚在设置里开了某个插件的授权，回来时提示要跟着变
    void refreshToolCount()
  })

  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    // 确认框优先：Esc = 拒绝。这里不能用「关掉弹窗但保持等待」，
    // 那样用户会以为事情没发生，实际请求还挂着
    if (confirmReq.value) {
      void answerConfirm(false)
      return
    }
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
      <div class="side-head">
        <span class="side-title">会话</span>
        <button class="new" title="新建会话" aria-label="新建会话" @click="newSession">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      </div>

      <div class="list">
        <div
          v-for="s in sessions"
          :key="s.id"
          class="item"
          :class="{ active: s.id === current?.id, editing: renamingId === s.id }"
          role="button"
          tabindex="0"
          :title="s.title"
          @click="openSession(s.id)"
          @keydown.enter.prevent="openSession(s.id)"
          @contextmenu.prevent="openMenu(s, $event)"
        >
          <input
            v-if="renamingId === s.id"
            v-model="renameDraft"
            class="rename-input"
            spellcheck="false"
            @click.stop
            @keydown.enter.prevent="commitRename"
            @keydown.esc.prevent="cancelRename"
            @blur="commitRename"
          />
          <template v-else>
            <span class="title">{{ s.title }}</span>
            <span class="sub">{{ s.messageCount }} 条消息</span>
          </template>
          <button
            class="more"
            title="更多操作"
            aria-label="更多操作"
            @click.stop="openMenu(s, $event, true)"
          >
            <span class="dots"><i /><i /><i /></span>
          </button>
        </div>
        <p v-if="!sessions.length" class="list-empty">还没有会话，点右上角 ＋ 开始</p>
      </div>

      <div class="side-foot">
        <div v-if="usage" class="usage">{{ usage.input }} → {{ usage.output }} tokens</div>
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
        <button class="ghost" :disabled="!hasMessages || busy" @click="newSession">新会话</button>
      </header>

      <div ref="scroller" class="messages">
        <div v-if="!hasMessages" class="welcome">
          <div class="welcome-title">问点什么</div>
          <p v-if="configured">
            支持多轮对话与会话切换，回答流式输出、随时可停。文件可以拖进来，或点「添加文件」。
            模型还能调用启动器的内置能力和已授权的插件工具，有副作用的操作会先弹确认。
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

            <template v-for="(p, i) in bodyParts(m)" :key="i">
              <div v-if="p.type === 'text'" class="pre">{{ p.text }}</div>
              <div
                v-else-if="p.type === 'tool_call'"
                class="tool-card"
                :class="{
                  bad: !!resultOf(m, p.callId) && resultOf(m, p.callId)?.ok === false,
                  run: toolRunning(m, p)
                }"
              >
                <div class="tool-head">
                  <span class="tool-state">
                    {{ toolRunning(m, p) ? '⋯' : resultOf(m, p.callId)?.ok ? '✓' : '✗' }}
                  </span>
                  <span class="tool-title">{{ p.title }}</span>
                  <span class="tool-risk" :class="`risk-${p.risk}`">{{ riskLabel(p.risk) }}</span>
                  <span v-if="p.pluginName" class="tool-from">{{ p.pluginName }}</span>
                </div>
                <template v-if="resultOf(m, p.callId)">
                  <div v-if="resultOf(m, p.callId)?.ok" class="tool-out">{{ resultOf(m, p.callId)?.text }}</div>
                  <div v-else class="tool-err">{{ resultOf(m, p.callId)?.error }}</div>
                </template>
                <div v-else class="tool-out">正在执行…</div>
                <details class="tool-args">
                  <summary>参数</summary>
                  <div class="pre">{{ p.args || '（无）' }}</div>
                </details>
              </div>
            </template>

            <div
              v-if="!textOf(m) && !hasToolParts(m) && !m.error && !m.stopped && !filesOf(m).length"
              class="typing"
            >
              正在生成…
            </div>
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
        <div class="composer-box">
          <textarea
            ref="composer"
            v-model="draft"
            rows="2"
            spellcheck="false"
            placeholder="问点什么…（Enter 发送，Shift+Enter 换行；文件可直接拖进来）"
            @keydown.enter.exact.prevent="send"
          />
          <div class="composer-actions">
            <button class="ghost attach-btn" :disabled="picking || busy" @click="pickFiles">
              {{ picking ? '读取中…' : '添加文件' }}
            </button>
            <span class="tip">{{
              configured
                ? `Enter 发送 · Esc 退出${toolCount ? ` · ${toolCount} 个插件工具可用` : ''}`
                : '先去 设置 → AI 配置模型'
            }}</span>
            <button class="send" :disabled="(!draft.trim() && !attachments.length) || busy" @click="send">
              {{ busy ? '生成中' : '发送' }}
            </button>
          </div>
        </div>
      </div>

      <div v-if="toast" class="toast">{{ toast }}</div>
    </main>

    <!--
      风险确认：画在本页的最上层。
      按钮顺序固定「拒绝在左、允许在右」，且默认焦点不给「允许」——
      用户按回车就要能过关的确认框，等于没有确认。
    -->
    <div v-if="confirmReq" class="confirm-mask" role="dialog" aria-modal="true">
      <div class="confirm-box">
        <div class="confirm-title">允许执行「{{ confirmReq.title }}」？</div>
        <div class="confirm-sub">
          <span class="confirm-from">{{ confirmReq.pluginName || '启动器内置工具' }}</span>
          <span class="tool-risk" :class="`risk-${confirmReq.risk}`">{{ riskLabel(confirmReq.risk) }}</span>
          <span class="confirm-full">{{ confirmReq.fullName }}</span>
        </div>
        <pre class="confirm-args">{{ confirmReq.args || '（无参数）' }}</pre>
        <div v-if="confirmReq.risk === 'dangerous'" class="confirm-warn">
          这是高风险操作，每次都会询问；「不再询问」对它不生效。
        </div>
        <label v-else-if="confirmReq.rememberable" class="confirm-remember">
          <input v-model="rememberConfirm" type="checkbox" />
          本次会话内不再询问这个工具
        </label>
        <div class="confirm-actions">
          <span class="confirm-tip">
            Esc 取消 · {{ Math.round(confirmReq.timeoutMs / 1000) }} 秒内没有选择将按拒绝处理
          </span>
          <span class="spacer" />
          <button class="ghost" @click="answerConfirm(false)">拒绝</button>
          <button class="send" @click="answerConfirm(true)">允许</button>
        </div>
      </div>
    </div>

    <PopMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :items="sessionMenuItems"
      @pick="onMenuPick"
      @close="menu = null"
    />

    <ConfirmDialog
      v-if="pendingDelete"
      title="删除这个会话？"
      :message="`「${pendingDelete.title}」的全部消息会一起删除。`"
      hint="删除后无法恢复。"
      confirm-label="删除"
      danger
      @confirm="doDelete"
      @cancel="pendingDelete = null"
    />
  </div>
</template>

<style scoped>
/*
 * 布局：两栏定高。
 * 这里只能用 100%（不能用 100vh）：外层已经有 reset 保证 html/body/#app 满高，
 * 再加 100vh 会和 body 的盒模型叠加出一圈溢出，右侧/下侧就常驻滚动条。
 */
.app {
  display: flex;
  height: 100%;
  background: var(--bg);
  color: var(--text-1);
  font-size: 13px;
  /* 面板整体不选中；正文与结果区单独开 user-select: text */
  user-select: none;
}

/* ---------------- 左侧会话栏 ---------------- */
.side {
  flex: none;
  width: 204px;
  display: flex;
  flex-direction: column;
  background: var(--bg-soft);
  border-right: 1px solid var(--line);
  padding: 10px 8px 8px;
}

.side-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px 8px 6px;
}

.side-title {
  flex: 1;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--text-3);
  text-transform: uppercase;
}

.new {
  flex: none;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  color: var(--text-2);
  background: var(--bg);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-1);
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}

.new:hover {
  color: var(--accent-strong);
  border-color: var(--accent-line);
  background: var(--accent-soft);
}

.new svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
}

.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  /* 滚动条出现时不挤压内容：会话标题被压到换行比滚动条本身更难看 */
  scrollbar-gutter: stable;
}

.item {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 7px 30px 7px 10px;
  border-radius: 9px;
  text-align: left;
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}

.item:hover {
  background: var(--bg-hover);
}

.item.active {
  background: var(--accent-soft);
}

/* 选中态的左侧指示条：只靠浅底在灰侧栏上不够清楚 */
.item.active::before {
  content: '';
  position: absolute;
  left: 3px;
  top: 50%;
  width: 2px;
  height: 15px;
  margin-top: -7.5px;
  border-radius: 2px;
  background: var(--accent);
}

.item:focus-visible {
  box-shadow: var(--ring);
}

.title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--text-1);
}

.item.active .title {
  font-weight: 500;
  color: var(--accent-strong);
}

.sub {
  font-size: 10.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

/* ···：默认隐形，hover/选中/键盘聚焦时才出现——一眼看去只有标题，不抢注意力 */
.more {
  position: absolute;
  top: 6px;
  right: 5px;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  color: var(--text-3);
  opacity: 0;
  transition: opacity var(--dur) var(--ease), background var(--dur) var(--ease);
}

.item:hover .more,
.item.active .more,
.item:focus-within .more,
.more:focus-visible {
  opacity: 1;
}

.more:hover {
  background: rgba(15, 23, 42, 0.09);
  color: var(--text-1);
}

.dots {
  display: flex;
  gap: 1.5px;
}

.dots i {
  width: 2.5px;
  height: 2.5px;
  border-radius: 50%;
  background: currentColor;
}

.rename-input {
  width: 100%;
  height: 22px;
  padding: 0 5px;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: var(--bg);
  font-size: 12.5px;
  color: var(--text-1);
  outline: none;
  user-select: text;
}

.item.editing {
  padding-right: 10px;
}

.list-empty {
  padding: 10px 8px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-4);
}

.side-foot {
  flex: none;
  margin-top: 6px;
  padding: 8px 6px 2px;
  border-top: 1px solid var(--line);
}

.usage {
  font-size: 10.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.brand {
  margin-top: 3px;
  font-size: 10.5px;
  letter-spacing: 0.02em;
  color: var(--text-4);
}

/* ---------------- 右侧主区 ---------------- */
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  background: var(--bg);
}

.top {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 46px;
  padding: 0 14px;
  border-bottom: 1px solid var(--line);
}

.model {
  height: 28px;
  max-width: 320px;
  padding: 0 26px 0 9px;
  border: 1px solid transparent;
  border-radius: 8px;
  background-color: transparent;
  /* 原生下拉箭头太大太黑，用一张淡色 chevron 顶替 */
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238f959e' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
  font-size: 12.5px;
  color: var(--text-2);
  appearance: none;
  cursor: pointer;
  transition: background-color var(--dur) var(--ease), border-color var(--dur) var(--ease);
}

.model:hover:not(:disabled) {
  background-color: var(--bg-hover);
  color: var(--text-1);
}

.model:focus {
  outline: none;
  border-color: var(--accent-line);
  background-color: var(--bg);
  box-shadow: var(--ring);
}

.model:disabled {
  cursor: default;
  opacity: 0.6;
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
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}

.stop {
  background: var(--danger-soft);
  color: var(--danger);
}

.stop:hover {
  background: #fbdde3;
}

.ghost {
  color: var(--text-2);
}

.ghost:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-1);
}

.ghost:disabled,
.stop:disabled {
  opacity: 0.4;
}

/* ---------------- 消息流 ---------------- */
.messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 18px 20px 10px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.welcome {
  margin: auto;
  max-width: 400px;
  text-align: center;
  color: var(--text-3);
  line-height: 1.8;
  font-size: 12.5px;
}

.welcome-title {
  margin-bottom: 8px;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text-1);
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
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  font-size: 10.5px;
  font-weight: 500;
  color: #fff;
  background: #b9bfc9;
}

.msg.assistant .avatar {
  background: linear-gradient(135deg, var(--accent), #8b5cf6);
}

.body {
  min-width: 0;
  max-width: 82%;
}

.msg.user .body {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

/*
 * 助手正文不画气泡：模型答案经常是长文 + 工具卡片 + 代码，
 * 套一层灰底只会让整屏变成一个大色块。用户消息反过来，短、需要一眼分辨。
 */
.pre {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.75;
  font-size: 13px;
  color: var(--text-1);
  user-select: text;
}

.pre + .pre {
  margin-top: 8px;
}

.msg.user .pre {
  padding: 8px 12px;
  border-radius: 12px;
  border-bottom-right-radius: 4px;
  background: var(--accent-soft);
  color: #2f3550;
}

.reasoning {
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--text-3);
}

.reasoning summary {
  cursor: pointer;
  user-select: none;
  width: fit-content;
}

.reasoning .pre {
  margin-top: 4px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px dashed var(--line);
  background: var(--bg-soft);
  color: var(--text-2);
  font-size: 12px;
}

.typing {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-3);
  font-size: 12.5px;
}

.typing::before {
  content: '';
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1.5px solid var(--accent-line);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* ---------------- 工具卡片 ---------------- */
.tool-card {
  margin: 7px 0;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: var(--bg-soft);
  font-size: 12.5px;
}

.tool-card.run {
  border-style: dashed;
}

.tool-card.bad {
  border-color: var(--danger-line);
  background: #fdf7f8;
}

.tool-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
  color: var(--text-1);
}

.tool-state {
  width: 14px;
  text-align: center;
  color: var(--text-3);
  font-size: 11px;
}

.tool-card.bad .tool-state {
  color: var(--danger);
}

.tool-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-risk {
  flex: none;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 10.5px;
  line-height: 16px;
  font-weight: 400;
}

.risk-read {
  background: #eef2f5;
  color: var(--text-2);
}

.risk-write {
  background: var(--warn-soft);
  color: var(--warn);
}

.risk-dangerous {
  background: var(--danger-soft);
  color: var(--danger);
}

.tool-from {
  flex: none;
  font-size: 10.5px;
  font-weight: 400;
  color: var(--text-3);
}

.tool-out {
  margin-top: 5px;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 168px;
  overflow-y: auto;
  user-select: text;
}

.tool-err {
  margin-top: 5px;
  color: var(--danger);
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}

.tool-args {
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--text-3);
}

.tool-args summary {
  cursor: pointer;
  user-select: none;
  width: fit-content;
}

.tool-args .pre {
  margin-top: 4px;
  padding: 7px 9px;
  max-height: 140px;
  overflow: auto;
  border-radius: 7px;
  background: rgba(15, 23, 42, 0.04);
  font-size: 11.5px;
  color: var(--text-2);
}

/* ---------------- 消息尾部 ---------------- */
.flag {
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--text-3);
}

.flag.err {
  color: var(--danger);
}

.acts {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 5px;
  opacity: 0;
  transition: opacity var(--dur) var(--ease);
}

.msg:hover .acts {
  opacity: 1;
}

.acts button {
  height: 20px;
  padding: 0 6px;
  border-radius: 5px;
  font-size: 11.5px;
  color: var(--text-3);
}

.acts button:hover {
  background: var(--bg-hover);
  color: var(--text-1);
}

.model-tag {
  font-size: 10.5px;
  color: var(--text-4);
}

/* ---------------- 底部输入区 ---------------- */
.banner {
  flex: none;
  margin: 0 14px 6px;
  padding: 7px 10px;
  border-radius: 8px;
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 12px;
  line-height: 1.6;
}

.composer {
  flex: none;
  padding: 8px 14px 12px;
}

/* 输入框 + 工具条合成一张卡片：焦点在哪都用 focus-within 提整张卡 */
.composer-box {
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--bg-soft);
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}

.composer-box:focus-within {
  border-color: var(--accent-line);
  background: var(--bg);
  box-shadow: var(--ring);
}

.composer textarea {
  display: block;
  width: 100%;
  padding: 10px 12px 2px;
  border: none;
  background: transparent;
  font-size: 13px;
  line-height: 1.65;
  color: var(--text-1);
  resize: none;
  outline: none;
  user-select: text;
}

.composer textarea::placeholder {
  color: var(--text-4);
}

/* 输入框的焦点态由 .composer-box:focus-within 统一表达 */
.composer textarea:focus-visible {
  box-shadow: none;
}

.composer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 8px 10px;
}

.tip {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text-4);
}

.send {
  flex: none;
  height: 28px;
  padding: 0 14px;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-size: 12.5px;
  font-weight: 500;
  transition: background var(--dur) var(--ease), transform var(--dur) var(--ease);
}

.send:hover:not(:disabled) {
  background: var(--accent-hover);
}

.send:active:not(:disabled) {
  transform: scale(0.97);
}

.send:disabled {
  background: #c9cdf6;
  cursor: default;
}

.toast {
  position: absolute;
  left: 50%;
  bottom: 104px;
  transform: translateX(-50%);
  padding: 7px 13px;
  border-radius: 9px;
  background: rgba(31, 35, 41, 0.9);
  color: #fff;
  font-size: 12px;
  box-shadow: var(--shadow-2);
  animation: toast-in 0.16s var(--ease);
  pointer-events: none;
}

@keyframes toast-in {
  from {
    opacity: 0;
    transform: translate(-50%, 6px);
  }
  to {
    opacity: 1;
    transform: translate(-50%, 0);
  }
}

/* ---------------- 拖拽遮罩 ---------------- */
.drop-mask {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: grid;
  place-items: center;
  background: rgba(99, 102, 241, 0.06);
}

.drop-box {
  padding: 14px 22px;
  border: 1.5px dashed var(--accent);
  border-radius: 12px;
  background: var(--bg);
  color: var(--accent-strong);
  font-size: 12.5px;
  box-shadow: var(--shadow-2);
}

/* ---------------- 消息里的附件 ---------------- */
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
  max-width: 320px;
  padding: 7px 9px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--bg-soft);
}

.msg.user .file {
  background: var(--accent-soft);
  border-color: rgba(99, 102, 241, 0.16);
}

.file.bad {
  border-color: var(--danger-line);
  background: #fdf7f8;
}

.thumb {
  flex: none;
  width: 40px;
  height: 40px;
  object-fit: cover;
  border-radius: 6px;
}

.file-tag {
  flex: none;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 6px;
  background: rgba(15, 23, 42, 0.07);
  color: var(--text-2);
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
  color: var(--text-1);
}

.file-sub {
  margin-top: 1px;
  font-size: 10.5px;
  color: var(--text-3);
}

.file.bad .file-sub {
  color: var(--danger);
}

.file-more {
  flex-basis: 100%;
  font-size: 11.5px;
  color: var(--text-3);
}

.file-more summary {
  cursor: pointer;
  user-select: none;
  width: fit-content;
}

.file-text {
  margin-top: 4px;
  max-height: 240px;
  overflow: auto;
  padding: 8px 9px;
  border-radius: 7px;
  border: 1px solid var(--line);
  background: var(--bg);
  font-size: 11.5px;
  line-height: 1.6;
  user-select: text;
}

/* ---------------- 待发附件条 ---------------- */
.ask-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  margin-bottom: 7px;
  padding: 3px 6px 3px 8px;
  border: 1px solid rgba(99, 102, 241, 0.18);
  border-radius: 8px;
  background: var(--accent-soft);
  font-size: 12px;
  color: var(--text-2);
}

.ask-label {
  color: var(--text-3);
}

.ask-name {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--accent-strong);
  font-weight: 600;
}

.attach-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 7px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  padding: 3px 6px 3px 3px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg-soft);
}

.chip.bad {
  border-color: var(--danger-line);
  background: #fdf7f8;
}

.chip-thumb {
  flex: none;
  width: 26px;
  height: 26px;
  object-fit: cover;
  border-radius: 5px;
}

.chip-tag {
  flex: none;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 5px;
  background: rgba(15, 23, 42, 0.07);
  color: var(--text-2);
  font-size: 9px;
}

.chip-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-2);
}

.chip-del,
.confirm-close {
  flex: none;
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  color: var(--text-3);
  font-size: 13px;
  line-height: 1;
}

.chip-del:hover {
  background: rgba(15, 23, 42, 0.08);
  color: var(--danger);
}

.attach-btn {
  flex: none;
  height: 26px;
  padding: 0 9px;
  border-radius: 7px;
  font-size: 12px;
  color: var(--text-2);
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}

.attach-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-1);
}

.attach-btn:disabled {
  opacity: 0.4;
}

/*
 * ---------------- 工具风险确认 ----------------
 * 类名（confirm-box / confirm-title / confirm-sub / confirm-warn /
 * confirm-remember / confirm-actions）是冒烟脚本的定位依据，别改。
 */
.confirm-mask {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(15, 18, 25, 0.34);
  animation: mask-in 0.12s var(--ease);
}

@keyframes mask-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.confirm-box {
  width: min(480px, 100%);
  max-height: calc(100vh - 40px);
  overflow: auto;
  padding: 18px;
  border-radius: var(--r-lg);
  background: var(--bg);
  box-shadow: var(--shadow-3);
  animation: dlg-in 0.16s var(--ease);
}

@keyframes dlg-in {
  from {
    opacity: 0;
    transform: scale(0.97) translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.confirm-title {
  font-size: 14.5px;
  font-weight: 600;
  color: var(--text-1);
  line-height: 1.45;
}

.confirm-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 7px;
  font-size: 11.5px;
  color: var(--text-3);
  flex-wrap: wrap;
}

.confirm-from {
  color: var(--text-2);
}

.confirm-full {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px;
  color: var(--text-4);
}

.confirm-args {
  margin-top: 10px;
  padding: 9px 10px;
  max-height: 200px;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--bg-soft);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}

.confirm-warn {
  margin-top: 9px;
  padding: 7px 9px;
  border-radius: 7px;
  background: var(--danger-soft);
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--danger);
}

.confirm-remember {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
}

.confirm-remember input {
  accent-color: var(--accent);
}

.confirm-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
}

.confirm-tip {
  font-size: 11px;
  color: var(--text-4);
}

.confirm-actions .send {
  height: 30px;
  padding: 0 16px;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-size: 12.5px;
}

.confirm-actions .send:hover {
  background: var(--accent-hover);
}

.confirm-actions .ghost {
  height: 30px;
  padding: 0 14px;
  border-radius: 8px;
  border: 1px solid var(--line);
  font-size: 12.5px;
  color: var(--text-2);
}

.confirm-actions .ghost:hover {
  background: var(--bg-hover);
  color: var(--text-1);
}
</style>
