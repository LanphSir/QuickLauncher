<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import PopMenu from '../../../src/shared/ui/PopMenu.vue'
import ConfirmDialog from '../../../src/shared/ui/ConfirmDialog.vue'
import { MENU_W, type MenuItem } from '../../../src/shared/ui/menu'
import { MANUALS } from './data/manuals.generated'
import { escapeHtml, parseMarkdown, plainText, type Block } from './markdown'
import type { Manual, PluginDocMeta } from './types'

/** 自定义文档在侧栏里的伪手册 id（内置手册 id 由 manual.json 决定，不会撞） */
const CUSTOM_ID = '__custom__'

interface SearchEntry {
  manualId: string
  manualTitle: string
  chapterId: string
  chapterTitle: string
  text: string
}

interface SearchHit {
  manualId: string
  manualTitle: string
  chapterId: string
  chapterTitle: string
  snippet: string
}

const view = ref<'browse' | 'manage'>('browse')
const disabledIds = ref<string[]>([])
const activeManualId = ref<string | null>(null)
const activeChapterId = ref<string | null>(null)
const search = ref('')
const searchEl = ref<HTMLInputElement | null>(null)
const docEl = ref<HTMLElement | null>(null)
const toast = ref('')

const customDocs = ref<PluginDocMeta[]>([])
const docContents = ref<Record<string, string>>({})
const blocks = ref<Block[]>([])
const blockCache = new Map<string, Block[]>()
let searchIndex: SearchEntry[] = []
let toastTimer: ReturnType<typeof setTimeout> | undefined

/** 自定义文档行的 `···` / 右键菜单；确认框负责删除这类不可逆操作 */
const menu = ref<{ x: number; y: number; doc: PluginDocMeta } | null>(null)
const confirm = ref<{ title: string; message: string; hint?: string; confirmLabel: string; run: () => void } | null>(
  null
)

/** 每本手册的匹配词覆盖（按 manual.id 存，空 = 沿用 manual.json 的默认值） */
const keywordOverrides = ref<Record<string, string[]>>({})
/** 管理页输入框草稿（逗号/空格分隔，失焦或回车时才落库） */
const keywordDraft = ref<Record<string, string>>({})

/** 生效的匹配词 = 内置关键词 + 用户补充（去重） */
function keywordsOf(manual: Manual): string[] {
  const base = manual.keywords ?? []
  const extra = keywordOverrides.value[manual.id] ?? []
  return extra.length ? [...new Set([...base, ...extra])] : base
}

function draftText(manual: Manual): string {
  return (keywordOverrides.value[manual.id] ?? []).join('，')
}

function syncDrafts(): void {
  const drafts: Record<string, string> = {}
  for (const manual of allManuals.value) drafts[manual.id] = draftText(manual)
  keywordDraft.value = drafts
}

/** 保存某本手册的匹配词：清空即恢复内置默认 */
async function saveKeywords(manual: Manual): Promise<void> {
  const raw = keywordDraft.value[manual.id] ?? ''
  const list = [...new Set(raw.split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean))].slice(0, 20)
  const next: Record<string, string[]> = { ...keywordOverrides.value }
  if (list.length) next[manual.id] = list
  else delete next[manual.id]
  keywordDraft.value = { ...keywordDraft.value, [manual.id]: list.join('，') }
  if (JSON.stringify(next) === JSON.stringify(keywordOverrides.value)) return
  keywordOverrides.value = next
  await window.appapi.storage.set('keywords', plain(next))
  void publishSearch()
  showToast(list.length ? `已更新「${manual.title}」的匹配词` : `「${manual.title}」已恢复默认匹配词`)
}

/** contextBridge 传参会做结构化克隆，Vue 响应式 Proxy 不能直接传 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

const customManual = computed<Manual | null>(() =>
  customDocs.value.length === 0
    ? null
    : {
        id: CUSTOM_ID,
        title: '我的文档',
        description: '导入的本地 Markdown / 纯文本',
        keywords: ['我的文档', '导入', '自定义'],
        order: 9999,
        custom: true,
        chapters: customDocs.value.map((d) => ({ id: d.id, title: d.title, content: '' }))
      }
)

const allManuals = computed<Manual[]>(() => (customManual.value ? [...MANUALS, customManual.value] : [...MANUALS]))
const enabledManuals = computed(() => allManuals.value.filter((m) => !disabledIds.value.includes(m.id)))
const activeManual = computed(() => allManuals.value.find((m) => m.id === activeManualId.value) ?? null)
const activeChapter = computed(
  () => activeManual.value?.chapters.find((c) => c.id === activeChapterId.value) ?? null
)

const searchResults = computed<SearchHit[]>(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return []
  const hits: SearchHit[] = []
  for (const entry of searchIndex) {
    const hay = entry.text.toLowerCase()
    const titleHit = entry.chapterTitle.toLowerCase().includes(q)
    let at = hay.indexOf(q)
    if (at < 0 && !titleHit) continue
    const snippets: string[] = []
    let count = 0
    while (at >= 0 && count < 2) {
      snippets.push(snippet(entry.text, at, q.length))
      at = hay.indexOf(q, at + q.length)
      count++
    }
    hits.push({
      manualId: entry.manualId,
      manualTitle: entry.manualTitle,
      chapterId: entry.chapterId,
      chapterTitle: entry.chapterTitle,
      snippet: snippets.join(' ') || '（标题命中）'
    })
    if (hits.length >= 60) break
  }
  return hits
})

function snippet(text: string, at: number, len: number): string {
  const start = Math.max(0, at - 28)
  const end = Math.min(text.length, at + len + 44)
  const slice = text.slice(start, end)
  const rel = at - start
  return (
    (start > 0 ? '…' : '') +
    escapeHtml(slice.slice(0, rel)) +
    '<mark>' +
    escapeHtml(slice.slice(rel, rel + len)) +
    '</mark>' +
    escapeHtml(slice.slice(rel + len)) +
    (end < text.length ? '…' : '')
  )
}

function chapterContent(manual: Manual, chapterId: string): string {
  if (manual.custom) return docContents.value[chapterId] ?? ''
  return manual.chapters.find((c) => c.id === chapterId)?.content ?? ''
}

/** 搜索索引：只索引"已启用"的手册，停用即从搜索结果消失 */
function rebuildIndex(): void {
  const entries: SearchEntry[] = []
  for (const manual of enabledManuals.value) {
    for (const chapter of manual.chapters) {
      entries.push({
        manualId: manual.id,
        manualTitle: manual.title,
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        text: plainText(chapterContent(manual, chapter.id))
      })
    }
  }
  searchIndex = entries
  void publishSearch()
}

/**
 * 把手册/章节注册到主面板搜索（权限 search）。
 * 手册级条目 weight 0、章节级 10，所以搜 "linux" 先出整本手册，再出 grep/ls 这些章节。
 * 停用的手册不推送；送达失败（宿主未授 search 权限）静默跳过，插件内搜索不受影响。
 */
async function publishSearch(): Promise<void> {
  const entries: Array<Record<string, unknown>> = []
  for (const manual of enabledManuals.value) {
    const chapterTitles = manual.chapters.map((c) => c.title).slice(0, 40)
    entries.push({
      id: `manual:${manual.id}`,
      title: manual.title,
      subtitle: `${manual.chapters.length} 章`,
      keywords: [...keywordsOf(manual), manual.title, ...chapterTitles],
      group: '程序员手册',
      weight: 0,
      intent: { manualId: manual.id }
    })
    for (const chapter of manual.chapters) {
      entries.push({
        id: `chapter:${manual.id}/${chapter.id}`,
        title: chapter.title,
        subtitle: manual.title,
        keywords: [chapter.title],
        group: '程序员手册',
        weight: 10,
        intent: { manualId: manual.id, chapterId: chapter.id }
      })
    }
  }
  try {
    await window.appapi.search.set(plain(entries))
  } catch {
    /* 宿主未提供搜索贡献能力时忽略 */
  }
}

async function loadCustomDocs(): Promise<void> {
  const list = await window.appapi.docs.list()
  customDocs.value = list
  const contents: Record<string, string> = {}
  for (const doc of list) {
    const cached = docContents.value[doc.id]
    if (cached !== undefined) {
      contents[doc.id] = cached
      continue
    }
    const res = await window.appapi.docs.read(doc.id)
    contents[doc.id] = res.ok ? (res.text ?? '') : ''
  }
  docContents.value = contents
  blockCache.clear()
}

async function openChapter(manualId: string, chapterId: string, highlight?: string): Promise<void> {
  const manual = allManuals.value.find((m) => m.id === manualId)
  if (!manual) return
  activeManualId.value = manualId
  activeChapterId.value = chapterId
  const key = `${manualId}/${chapterId}`
  const cached = blockCache.get(key)
  if (cached) {
    blocks.value = cached
  } else {
    blocks.value = parseMarkdown(chapterContent(manual, chapterId))
    blockCache.set(key, blocks.value)
  }
  await nextTick()
  docEl.value?.scrollTo({ top: 0 })
  if (highlight) void highlightInDoc(highlight)
  void persistPosition()
}

/** 全文搜索命中后滚到正文里第一处出现的位置（按块级元素粗定位，够用且零解析成本） */
async function highlightInDoc(query: string): Promise<void> {
  await nextTick()
  const root = docEl.value
  if (!root) return
  const q = query.toLowerCase()
  const nodes = root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,p,li,td,th,pre')
  for (const el of nodes) {
    if ((el.textContent ?? '').toLowerCase().includes(q)) {
      // 类名不能复用侧栏结果的 .hit（那边是 display:flex，套到 <p> 上会把段落拆成竖排）
      el.classList.add('found')
      el.scrollIntoView({ block: 'center' })
      setTimeout(() => el.classList.remove('found'), 2200)
      return
    }
  }
}

function openHit(hit: SearchHit): void {
  void openChapter(hit.manualId, hit.chapterId, search.value.trim())
}

async function toggleEnabled(id: string): Promise<void> {
  disabledIds.value = disabledIds.value.includes(id)
    ? disabledIds.value.filter((x) => x !== id)
    : [...disabledIds.value, id]
  await window.appapi.storage.set('disabled-ids', plain(disabledIds.value))
  if (activeManualId.value === id && disabledIds.value.includes(id)) {
    activeManualId.value = null
    activeChapterId.value = null
    blocks.value = []
  }
  rebuildIndex()
}

async function persistPosition(): Promise<void> {
  if (!activeManualId.value || !activeChapterId.value) return
  await window.appapi.storage.set(
    'last-position',
    plain({ manualId: activeManualId.value, chapterId: activeChapterId.value })
  )
}

function showToast(text: string): void {
  toast.value = text
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = ''), 1600)
}

async function copyCode(code: string): Promise<void> {
  await window.appapi.clipboard.writeText(code)
  showToast('已复制代码')
}

async function importDocs(): Promise<void> {
  const res = await window.appapi.docs.import()
  if (!res.ok && !res.message) return // 用户取消
  await loadCustomDocs()
  rebuildIndex()
  showToast(res.message ?? '导入完成')
}

async function removeDoc(doc: PluginDocMeta): Promise<void> {
  const res = await window.appapi.docs.remove(doc.id)
  if (!res.ok) {
    showToast(res.message ?? '删除失败')
    return
  }
  if (activeChapterId.value === doc.id) {
    activeChapterId.value = null
    blocks.value = []
  }
  await loadCustomDocs()
  rebuildIndex()
  showToast(`已删除「${doc.title}」`)
}

function openDocsFolder(): void {
  void window.appapi.docs.reveal()
}

// ---------- 自定义文档的菜单（`···` 与右键共用） ----------

/** 文档行是密行列表：`···` 按行尾对齐，右键跟随光标 */
function openDocMenu(doc: PluginDocMeta, event: MouseEvent): void {
  if (event.type === 'contextmenu') {
    menu.value = { x: event.clientX, y: event.clientY, doc }
    return
  }
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const rightAligned = rect.right - MENU_W
  menu.value = { x: rightAligned < 8 ? rect.left : rightAligned, y: rect.bottom + 4, doc }
}

function docMenuItems(): MenuItem[] {
  return [
    { key: 'open', label: '阅读这篇', icon: 'chat' },
    { key: 'reveal', label: '在文档目录中查看', icon: 'folder' },
    { key: 'delete', label: '删除文档', icon: 'delete', danger: true }
  ]
}

function onDocMenuPick(key: string): void {
  const doc = menu.value?.doc ?? null
  menu.value = null
  if (!doc) return
  if (key === 'open') {
    void openChapter(CUSTOM_ID, doc.id)
    return
  }
  if (key === 'reveal') {
    openDocsFolder()
    return
  }
  if (key === 'delete') {
    confirm.value = {
      title: `删除「${doc.title}」？`,
      message: '这份文档会从插件目录里移除，删除后不可恢复。',
      hint: '内置手册不受影响；想找回需要重新导入原文件。',
      confirmLabel: '删除',
      run: () => void removeDoc(doc)
    }
  }
}

function runConfirm(): void {
  const state = confirm.value
  confirm.value = null
  state?.run()
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function selectManual(id: string): void {
  activeManualId.value = id
  activeChapterId.value = null
  blocks.value = []
}

function back(): void {
  if (view.value === 'manage') {
    view.value = 'browse'
    return
  }
  if (search.value) {
    search.value = ''
    return
  }
  if (activeChapterId.value) {
    activeChapterId.value = null
    return
  }
  if (activeManualId.value) {
    activeManualId.value = null
    return
  }
  void window.appapi.exit()
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    // 浮层开着时 Esc 只该关浮层（它们在捕获阶段已拦下，这里再兜一层）
    if (menu.value || confirm.value) return
    back()
    return
  }
  const typing = document.activeElement?.tagName === 'INPUT'
  if (e.key === '/' && !typing) {
    e.preventDefault()
    searchEl.value?.focus()
    return
  }
  if (e.key === 'Enter' && typing && searchResults.value.length > 0) {
    e.preventDefault()
    openHit(searchResults.value[0])
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  const [savedDisabled, savedPos, savedKeywords] = await Promise.all([
    window.appapi.storage.get('disabled-ids'),
    window.appapi.storage.get('last-position'),
    window.appapi.storage.get('keywords')
  ])
  if (Array.isArray(savedDisabled)) disabledIds.value = savedDisabled as string[]
  if (savedKeywords && typeof savedKeywords === 'object') {
    const map: Record<string, string[]> = {}
    for (const [id, value] of Object.entries(savedKeywords as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        const list = value.filter((k): k is string => typeof k === 'string' && k.trim() !== '')
        if (list.length) map[id] = list
      }
    }
    keywordOverrides.value = map
  }
  await loadCustomDocs()
  syncDrafts()
  rebuildIndex()

  const pos = savedPos as { manualId?: string; chapterId?: string } | null
  if (pos?.manualId && pos?.chapterId) {
    const manual = allManuals.value.find((m) => m.id === pos.manualId)
    if (manual && !disabledIds.value.includes(manual.id) && manual.chapters.some((c) => c.id === pos.chapterId)) {
      await openChapter(pos.manualId, pos.chapterId)
    }
  }

  // 面板搜索词透传：带 intent 则直达手册/章节，否则按关键词搜
  window.appapi.onQuery((payload) => {
    const manualId = typeof payload?.intent?.manualId === 'string' ? payload.intent.manualId : ''
    if (manualId) {
      const manual = allManuals.value.find((m) => m.id === manualId)
      if (manual && !disabledIds.value.includes(manual.id)) {
        // 从面板直接跳进来时，先把管理模式/搜索态收掉，否则用户看到的是管理页
        view.value = 'browse'
        search.value = ''
        const chapterId = typeof payload.intent?.chapterId === 'string' ? payload.intent.chapterId : ''
        if (chapterId && manual.chapters.some((c) => c.id === chapterId)) {
          void openChapter(manual.id, chapterId)
        } else {
          selectManual(manual.id)
        }
        return
      }
    }
    const q = payload?.query?.trim()
    if (q) search.value = q
  })
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  if (toastTimer) clearTimeout(toastTimer)
})
</script>

<template>
  <div class="pl-page hb">
    <header class="pl-head bar">
      <button class="pl-btn" @click="back"><span class="arrow">‹</span> 返回</button>
      <input
        ref="searchEl"
        v-model="search"
        class="pl-search"
        type="text"
        placeholder="搜索已启用手册的内容（按 / 聚焦）"
        spellcheck="false"
      />
      <button class="pl-btn" @click="view = view === 'manage' ? 'browse' : 'manage'">
        {{ view === 'manage' ? '完成' : '手册管理' }}
      </button>
    </header>

    <div class="body">
      <aside class="side">
        <!-- 管理：启用/停用 + 自定义文档 -->
        <template v-if="view === 'manage'">
          <p class="side-title">启用手册 · 匹配词</p>
          <div v-for="m in allManuals" :key="m.id" class="m-block">
            <label class="m-row">
              <input type="checkbox" :checked="!disabledIds.includes(m.id)" @change="toggleEnabled(m.id)" />
              <span class="m-name">{{ m.title }}</span>
              <span class="m-count">{{ m.chapters.length }} 章</span>
            </label>
            <input
              v-model="keywordDraft[m.id]"
              class="kw"
              type="text"
              :placeholder="`补充匹配词（默认：${(m.keywords ?? []).join('、') || '无'}）`"
              spellcheck="false"
              @keydown.enter="($event.target as HTMLInputElement).blur()"
              @blur="saveKeywords(m)"
            />
          </div>
          <p class="hint">
            匹配词决定主面板搜索能否命中这本手册：用逗号/空格分隔，留空用默认值。章节名始终参与匹配。
          </p>

          <p class="side-title mt">自定义文档</p>
          <div class="m-actions">
            <button class="mini" @click="importDocs">导入文档…</button>
            <button class="mini" @click="openDocsFolder">打开目录</button>
          </div>
          <p v-if="customDocs.length === 0" class="hint">
            还没有导入文档。支持 .md / .markdown / .txt，可多选；也可以把文件直接放进文档目录后重新进入本页。
          </p>
          <div
            v-for="doc in customDocs"
            :key="doc.id"
            class="doc-row"
            @contextmenu.prevent="openDocMenu(doc, $event)"
          >
            <span class="doc-name" :title="doc.title">{{ doc.title }}</span>
            <span class="doc-size">{{ formatSize(doc.size) }}</span>
            <button class="pl-icon-btn" title="更多操作" @click.stop="openDocMenu(doc, $event)">
              <span class="pl-dots">···</span>
            </button>
          </div>
        </template>

        <!-- 搜索结果 -->
        <template v-else-if="search.trim()">
          <p class="side-title">命中 {{ searchResults.length }} 章</p>
          <button
            v-for="(hit, i) in searchResults"
            :key="`${hit.manualId}-${hit.chapterId}-${i}`"
            class="hit"
            @click="openHit(hit)"
          >
            <span class="hit-title">{{ hit.chapterTitle }}</span>
            <span class="hit-from">{{ hit.manualTitle }}</span>
            <span class="hit-snippet" v-html="hit.snippet" />
          </button>
          <p v-if="searchResults.length === 0" class="hint">没有找到，换个关键词试试。</p>
        </template>

        <!-- 章节列表 -->
        <template v-else-if="activeManual">
          <button class="side-back" @click="activeManualId = null">‹ 全部手册</button>
          <p class="side-title">{{ activeManual.title }}</p>
          <button
            v-for="chapter in activeManual.chapters"
            :key="chapter.id"
            class="ch-row"
            :class="{ active: chapter.id === activeChapterId }"
            @click="openChapter(activeManual.id, chapter.id)"
          >
            {{ chapter.title }}
          </button>
        </template>

        <!-- 手册列表 -->
        <template v-else>
          <p class="side-title">手册（{{ enabledManuals.length }}）</p>
          <button v-for="m in enabledManuals" :key="m.id" class="m-item" @click="selectManual(m.id)">
            <span class="m-item-name">{{ m.title }}</span>
            <span class="m-item-sub">{{ m.chapters.length }} 章</span>
          </button>
          <p v-if="enabledManuals.length === 0" class="hint">
            所有手册都被停用了，去「手册管理」里打开需要的。
          </p>
        </template>
      </aside>

      <main ref="docEl" class="doc">
        <!-- 正文 -->
        <article v-if="activeChapter" class="article">
          <div class="crumb">{{ activeManual?.title }} / {{ activeChapter.title }}</div>
          <template v-for="(block, i) in blocks" :key="i">
            <h1 v-if="block.type === 'heading' && block.level === 1" v-html="block.html" />
            <h2 v-else-if="block.type === 'heading' && block.level === 2" v-html="block.html" />
            <h3 v-else-if="block.type === 'heading' && block.level === 3" v-html="block.html" />
            <h4 v-else-if="block.type === 'heading'" class="h4" v-html="block.html" />
            <p v-else-if="block.type === 'paragraph'" v-html="block.html" />
            <div v-else-if="block.type === 'code'" class="code">
              <div class="code-bar">
                <span>{{ block.lang || 'text' }}</span>
                <button class="mini" @click="copyCode(block.code)">复制</button>
              </div>
              <pre><code>{{ block.code }}</code></pre>
            </div>
            <ul v-else-if="block.type === 'list'" class="list">
              <li
                v-for="(item, j) in block.items"
                :key="j"
                :style="{ paddingLeft: `${item.depth * 18}px` }"
              >
                <span class="marker">{{ item.marker }}</span>
                <span v-html="item.html" />
              </li>
            </ul>
            <blockquote v-else-if="block.type === 'quote'">
              <template v-for="(child, k) in block.blocks" :key="k">
                <p v-if="child.type === 'paragraph'" v-html="child.html" />
                <p v-else-if="child.type === 'heading'" class="quote-h" v-html="child.html" />
                <ul v-else-if="child.type === 'list'" class="list">
                  <li
                    v-for="(item, j2) in child.items"
                    :key="j2"
                    :style="{ paddingLeft: `${item.depth * 18}px` }"
                  >
                    <span class="marker">{{ item.marker }}</span>
                    <span v-html="item.html" />
                  </li>
                </ul>
              </template>
            </blockquote>
            <table v-else-if="block.type === 'table'" class="tbl">
              <thead>
                <tr>
                  <th v-for="(h, j) in block.headers" :key="j" v-html="h" />
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, j) in block.rows" :key="j">
                  <td v-for="(cell, k) in row" :key="k" v-html="cell" />
                </tr>
              </tbody>
            </table>
            <hr v-else-if="block.type === 'hr'" />
          </template>
        </article>

        <!-- 手册概览 -->
        <section v-else-if="activeManual" class="overview">
          <h2>{{ activeManual.title }}</h2>
          <p v-if="activeManual.description" class="desc">{{ activeManual.description }}</p>
          <p class="meta">
            <span v-if="activeManual.source">
              来源：<a :href="activeManual.source" target="_blank" rel="noreferrer">{{ activeManual.source }}</a>
            </span>
            <span v-if="activeManual.license">· {{ activeManual.license }}</span>
          </p>
          <div class="cards">
            <button
              v-for="chapter in activeManual.chapters"
              :key="chapter.id"
              class="card"
              @click="openChapter(activeManual.id, chapter.id)"
            >
              {{ chapter.title }}
            </button>
          </div>
        </section>

        <!-- 欢迎页 -->
        <section v-else class="welcome">
          <h2>程序员手册</h2>
          <p class="desc">离线可读的本地手册库：左侧选一本，右侧直接读；按 <b>/</b> 搜全文，Esc 返回。</p>
          <div class="cards">
            <button v-for="m in enabledManuals" :key="m.id" class="card" @click="selectManual(m.id)">
              <b>{{ m.title }}</b>
              <span>{{ m.chapters.length }} 章</span>
            </button>
          </div>
          <p class="hint">
            想加自己的文档？右上角「手册管理」→ 导入文档（.md / .txt），或直接把文件放进文档目录。
          </p>
        </section>
      </main>
    </div>

    <transition name="fade">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </transition>

    <PopMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :items="docMenuItems()"
      @pick="onDocMenuPick"
      @close="menu = null"
    />
    <ConfirmDialog
      v-if="confirm"
      :title="confirm.title"
      :message="confirm.message"
      :hint="confirm.hint"
      :confirm-label="confirm.confirmLabel"
      danger
      @confirm="runConfirm"
      @cancel="confirm = null"
    />
  </div>
</template>

<style>
/*
 * 骨架、页头、按钮来自 plugin-ui.css 的 .pl-*；这里只写手册页特有的两栏布局与正文排版。
 * 颜色一律取 theme.css 的令牌——正文排版最容易散出一堆"差不多"的灰。
 */
.hb {
  padding: 10px 16px 12px;
}

.bar {
  gap: 10px;
  padding-bottom: 8px;
}

.body {
  flex: 1;
  display: flex;
  gap: 12px;
  min-height: 0;
}

.side {
  width: 202px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  /* 侧栏里长占位符/长单词会撑出横向滚动条，宁可裁掉也不整页横滚 */
  overflow-x: hidden;
  padding-right: 4px;
  border-right: 1px solid var(--line-soft);
}

.side-title {
  font-size: 11px;
  color: var(--text-3);
  padding: 6px 8px 4px;
  letter-spacing: 0.4px;
}

.side-title.mt {
  margin-top: 10px;
}

.side-back {
  text-align: left;
  color: var(--text-2);
  font-size: 12px;
  padding: 4px 8px;
  border-radius: var(--r-xs);
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.side-back:hover {
  background: var(--bg-hover);
  color: var(--text-1);
}

.m-item,
.ch-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border-radius: var(--r-sm);
  font-size: 13px;
  color: var(--text-1);
  text-align: left;
  line-height: 1.4;
  transition: background var(--dur) var(--ease);
}

.m-item:hover,
.ch-row:hover {
  background: var(--bg-hover);
}

.ch-row.active {
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-weight: 600;
}

.m-item-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.m-item-sub,
.m-count {
  font-size: 11px;
  color: var(--text-3);
}

.m-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 9px;
  border-radius: var(--r-sm);
  font-size: 13px;
  cursor: pointer;
}

.m-row:hover {
  background: var(--bg-hover);
}

.m-row input {
  accent-color: var(--accent);
}

/* 管理页每本手册一块：启用开关 + 匹配词输入 */
.m-block {
  padding-bottom: 6px;
  border-bottom: 1px dashed var(--line-soft);
  margin-bottom: 4px;
}

.m-block:last-of-type {
  border-bottom: none;
}

.kw {
  display: block;
  /* 用 margin 让出位置，宽度交给块级自动填充；写 calc(100% - 18px) 再加左边距会溢出 */
  width: auto;
  margin: 0 9px 2px 27px;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--text-2);
  background: var(--bg-soft);
  border: 1px solid transparent;
  border-radius: var(--r-xs);
  outline: none;
  transition:
    background var(--dur) var(--ease),
    border-color var(--dur) var(--ease);
}

.kw:focus {
  border-color: var(--accent-line);
  background: var(--bg);
  box-shadow: none;
}

.kw::placeholder {
  color: var(--text-4);
}

.m-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.m-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 2px 6px 6px;
}

.mini {
  font-size: 12px;
  padding: 4px 9px;
  border-radius: var(--r-xs);
  border: 1px solid var(--line);
  background: var(--bg);
  color: var(--text-2);
  cursor: pointer;
  transition:
    background var(--dur) var(--ease),
    border-color var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.mini:hover {
  border-color: var(--accent-line);
  color: var(--accent-strong);
  background: var(--accent-soft);
}

/* 自定义文档行：行高比会话项高，`···` 常驻 35% 可见，hover 变实 */
.doc-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 4px 4px 9px;
  font-size: 12px;
  border-radius: var(--r-xs);
}

.doc-row:hover {
  background: var(--bg-hover);
}

.doc-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.doc-size {
  flex: none;
  color: var(--text-3);
  font-size: 11px;
}

.doc-row .pl-icon-btn {
  width: 22px;
  height: 22px;
  opacity: 0.35;
}

.doc-row:hover .pl-icon-btn,
.doc-row .pl-icon-btn:focus-visible {
  opacity: 1;
}

.hit {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 7px 9px;
  border-radius: var(--r-sm);
  border-bottom: 1px solid var(--line-soft);
  text-align: left;
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}

.hit:hover {
  background: var(--bg-hover);
}

.hit-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-1);
}

.hit-from {
  font-size: 11px;
  color: var(--text-3);
}

.hit-snippet {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-2);
}

.hit-snippet mark {
  background: var(--mark);
  color: inherit;
  padding: 0 1px;
  border-radius: 2px;
}

.hint {
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-3);
  padding: 6px 9px;
}

/* ---------- 正文 ---------- */

.doc {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 0 6px 30px 10px;
  user-select: text;
}

.article {
  max-width: 720px;
}

.crumb {
  font-size: 11px;
  color: var(--text-3);
  margin-bottom: 8px;
}

.article h1 {
  font-size: 21px;
  margin: 14px 0 10px;
  line-height: 1.35;
}

.article h2 {
  font-size: 16.5px;
  margin: 20px 0 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--line-soft);
}

.article h3 {
  font-size: 14.5px;
  margin: 16px 0 6px;
}

.article .h4 {
  font-size: 13.5px;
  margin: 12px 0 4px;
  color: var(--text-2);
}

.article p {
  line-height: 1.75;
  color: var(--text-1);
  margin: 7px 0;
  word-break: break-word;
}

.article a {
  color: var(--accent-strong);
  text-decoration: none;
  border-bottom: 1px dotted var(--accent-line);
}

.article a:hover {
  border-bottom-style: solid;
}

.article code {
  font-family: 'Cascadia Mono', Consolas, 'JetBrains Mono', monospace;
  font-size: 12px;
  padding: 1px 5px;
  border-radius: var(--r-xs);
  background: var(--bg-soft);
  color: var(--danger);
}

/* 命中定位：从浅黄淡回透明，比"跳过去就没了"更容易找到位置 */
.article .found {
  animation: flash 2.2s var(--ease);
}

@keyframes flash {
  0%,
  60% {
    background: var(--mark-soft);
  }
  100% {
    background: transparent;
  }
}

.code {
  margin: 10px 0;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  overflow: hidden;
  background: var(--bg-soft);
}

.code-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  background: var(--bg-soft);
  border-bottom: 1px solid var(--line);
  font-size: 11px;
  color: var(--text-3);
}

.code pre {
  margin: 0;
  padding: 10px 12px;
  overflow-x: auto;
  max-height: 420px;
}

.code pre code {
  padding: 0;
  background: none;
  color: var(--text-1);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre;
  user-select: text;
}

.list {
  list-style: none;
  margin: 6px 0;
}

.list li {
  display: flex;
  gap: 6px;
  padding: 1px 0;
  line-height: 1.75;
  color: var(--text-1);
  word-break: break-word;
}

.list .marker {
  flex-shrink: 0;
  min-width: 12px;
  text-align: right;
  color: var(--text-3);
}

.article blockquote {
  margin: 10px 0;
  padding: 8px 12px;
  border-left: 3px solid var(--accent-line);
  border-radius: 0 var(--r-sm) var(--r-sm) 0;
  background: var(--bg-soft);
}

.article blockquote p {
  color: var(--text-2);
  margin: 3px 0;
}

.quote-h {
  font-weight: 600;
  color: var(--text-1) !important;
}

.tbl {
  width: 100%;
  border-collapse: collapse;
  margin: 10px 0;
  font-size: 12.5px;
}

.tbl th,
.tbl td {
  border: 1px solid var(--line);
  padding: 6px 9px;
  text-align: left;
  line-height: 1.6;
}

.tbl th {
  background: var(--bg-soft);
  font-weight: 600;
  color: var(--text-2);
}

.article hr {
  border: none;
  border-top: 1px solid var(--line-soft);
  margin: 16px 0;
}

/* ---------- 概览 / 欢迎页 ---------- */

.overview,
.welcome {
  padding: 6px 4px;
  max-width: 700px;
}

.overview h2,
.welcome h2 {
  font-size: 18px;
  margin-bottom: 6px;
}

.desc {
  color: var(--text-2);
  line-height: 1.7;
  margin: 6px 0;
}

.meta {
  font-size: 11.5px;
  color: var(--text-3);
  margin: 6px 0 12px;
}

.meta a {
  color: var(--text-3);
}

.cards {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0;
}

.card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  max-width: 210px;
  padding: 9px 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--bg);
  font-size: 12.5px;
  color: var(--text-1);
  cursor: pointer;
  transition:
    background var(--dur) var(--ease),
    border-color var(--dur) var(--ease);
}

.card:hover {
  border-color: var(--accent-line);
  background: var(--accent-soft);
}

.card span {
  font-size: 11px;
  color: var(--text-3);
}

.toast {
  position: fixed;
  left: 50%;
  bottom: 22px;
  transform: translateX(-50%);
  padding: 7px 14px;
  border-radius: var(--r-sm);
  background: var(--toast-bg);
  color: var(--on-accent);
  font-size: 12px;
  box-shadow: var(--shadow-2);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.18s var(--ease);
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
