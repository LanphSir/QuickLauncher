<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
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
  const [savedDisabled, savedPos] = await Promise.all([
    window.appapi.storage.get('disabled-ids'),
    window.appapi.storage.get('last-position')
  ])
  if (Array.isArray(savedDisabled)) disabledIds.value = savedDisabled as string[]
  await loadCustomDocs()
  rebuildIndex()

  const pos = savedPos as { manualId?: string; chapterId?: string } | null
  if (pos?.manualId && pos?.chapterId) {
    const manual = allManuals.value.find((m) => m.id === pos.manualId)
    if (manual && !disabledIds.value.includes(manual.id) && manual.chapters.some((c) => c.id === pos.chapterId)) {
      await openChapter(pos.manualId, pos.chapterId)
    }
  }

  // 面板搜索词透传：进来直接搜
  window.appapi.onQuery((payload) => {
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
  <div class="page">
    <header class="bar">
      <button class="ghost" @click="back"><span class="arrow">‹</span> 返回</button>
      <input
        ref="searchEl"
        v-model="search"
        class="search"
        type="text"
        placeholder="搜索已启用手册的内容（按 / 聚焦）"
        spellcheck="false"
      />
      <button class="ghost" @click="view = view === 'manage' ? 'browse' : 'manage'">
        {{ view === 'manage' ? '完成' : '手册管理' }}
      </button>
    </header>

    <div class="body">
      <aside class="side">
        <!-- 管理：启用/停用 + 自定义文档 -->
        <template v-if="view === 'manage'">
          <p class="side-title">启用手册</p>
          <label v-for="m in allManuals" :key="m.id" class="m-row">
            <input type="checkbox" :checked="!disabledIds.includes(m.id)" @change="toggleEnabled(m.id)" />
            <span class="m-name">{{ m.title }}</span>
            <span class="m-count">{{ m.chapters.length }} 章</span>
          </label>

          <p class="side-title mt">自定义文档</p>
          <div class="m-actions">
            <button class="mini" @click="importDocs">导入文档…</button>
            <button class="mini" @click="openDocsFolder">打开目录</button>
          </div>
          <p v-if="customDocs.length === 0" class="hint">
            还没有导入文档。支持 .md / .markdown / .txt，可多选；也可以把文件直接放进文档目录后重新进入本页。
          </p>
          <div v-for="doc in customDocs" :key="doc.id" class="doc-row">
            <span class="doc-name" :title="doc.title">{{ doc.title }}</span>
            <span class="doc-size">{{ formatSize(doc.size) }}</span>
            <button class="x" title="删除" @click="removeDoc(doc)">✕</button>
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
  </div>
</template>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html,
body,
#app {
  height: 100%;
}

body {
  font-family: 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
  color: #1f2329;
  background: #fff;
  user-select: none;
  font-size: 13px;
}

.page {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 10px 16px 12px;
}

.bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 8px;
}

.ghost {
  font-size: 13px;
  color: #646a73;
  padding: 5px 10px;
  border-radius: 8px;
  border: none;
  background: none;
  cursor: pointer;
  white-space: nowrap;
}

.ghost:hover {
  background: #f2f3f5;
  color: #1f2329;
}

.arrow {
  font-size: 15px;
}

.search {
  flex: 1;
  height: 32px;
  padding: 0 12px;
  border: 1px solid #e5e6eb;
  border-radius: 9px;
  font-size: 13px;
  outline: none;
  background: #fafbfc;
  color: #1f2329;
  -webkit-app-region: no-drag;
}

.search:focus {
  border-color: #c7cbf5;
  background: #fff;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
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
  padding-right: 4px;
  border-right: 1px solid #f0f1f3;
}

.side-title {
  font-size: 11px;
  color: #a1a6ad;
  padding: 6px 8px 4px;
  letter-spacing: 0.4px;
}

.side-title.mt {
  margin-top: 10px;
}

.side-back {
  text-align: left;
  border: none;
  background: none;
  color: #646a73;
  font-size: 12px;
  padding: 4px 8px;
  cursor: pointer;
  border-radius: 6px;
}

.side-back:hover {
  background: #f2f3f5;
}

.m-item,
.ch-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  border: none;
  background: none;
  padding: 7px 9px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  color: #1f2329;
  line-height: 1.4;
}

.m-item:hover,
.ch-row:hover {
  background: #f5f6f7;
}

.ch-row.active {
  background: #eef0ff;
  color: #4f46e5;
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
  color: #a1a6ad;
}

.m-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 9px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
}

.m-row:hover {
  background: #f5f6f7;
}

.m-row input {
  accent-color: #6366f1;
}

.m-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.m-actions {
  display: flex;
  gap: 6px;
  padding: 2px 6px 6px;
}

.mini {
  font-size: 12px;
  padding: 4px 9px;
  border-radius: 7px;
  border: 1px solid #e5e6eb;
  background: #fff;
  color: #4e5969;
  cursor: pointer;
}

.mini:hover {
  border-color: #c7cbf5;
  color: #4f46e5;
  background: #f7f8ff;
}

.doc-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 9px;
  font-size: 12px;
  border-radius: 7px;
}

.doc-row:hover {
  background: #f5f6f7;
}

.doc-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.doc-size {
  color: #a1a6ad;
  font-size: 11px;
}

.x {
  border: none;
  background: none;
  color: #c9cdd4;
  cursor: pointer;
  font-size: 11px;
  padding: 2px 4px;
  border-radius: 5px;
}

.x:hover {
  color: #d5304f;
  background: #fef0f0;
}

.hit {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  text-align: left;
  border: none;
  background: none;
  padding: 7px 9px;
  border-radius: 8px;
  cursor: pointer;
  border-bottom: 1px solid #f5f6f7;
}

.hit:hover {
  background: #f7f8ff;
}

.hit-title {
  font-size: 13px;
  color: #1f2329;
  font-weight: 500;
}

.hit-from {
  font-size: 11px;
  color: #8f959e;
}

.hit-snippet {
  font-size: 11.5px;
  color: #646a73;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.hit-snippet mark {
  background: #fff3bf;
  color: inherit;
  padding: 0 1px;
  border-radius: 2px;
}

.hint {
  font-size: 11.5px;
  color: #a1a6ad;
  line-height: 1.6;
  padding: 6px 9px;
}

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
  color: #a1a6ad;
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
  border-bottom: 1px solid #f0f1f3;
}

.article h3 {
  font-size: 14.5px;
  margin: 16px 0 6px;
}

.article .h4 {
  font-size: 13.5px;
  margin: 12px 0 4px;
  color: #4e5969;
}

.article p {
  line-height: 1.75;
  color: #2b2f36;
  margin: 7px 0;
  word-break: break-word;
}

.article a {
  color: #4f46e5;
  text-decoration: none;
  border-bottom: 1px dotted #c7cbf5;
}

.article a:hover {
  border-bottom-style: solid;
}

.article code {
  font-family: 'Cascadia Mono', Consolas, 'JetBrains Mono', monospace;
  font-size: 12px;
  background: #f4f5f7;
  color: #c7254e;
  padding: 1px 5px;
  border-radius: 4px;
}

.article .found {
  animation: flash 2.2s ease;
}

@keyframes flash {
  0%,
  60% {
    background: #fff8db;
  }
  100% {
    background: transparent;
  }
}

.code {
  margin: 10px 0;
  border: 1px solid #eceef1;
  border-radius: 10px;
  overflow: hidden;
  background: #fbfcfd;
}

.code-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  background: #f5f6f8;
  border-bottom: 1px solid #eceef1;
  font-size: 11px;
  color: #8f959e;
}

.code pre {
  margin: 0;
  padding: 10px 12px;
  overflow-x: auto;
  max-height: 420px;
}

.code pre code {
  background: none;
  color: #24292f;
  padding: 0;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre;
}

.list {
  list-style: none;
  margin: 6px 0;
}

.list li {
  display: flex;
  gap: 6px;
  line-height: 1.75;
  color: #2b2f36;
  padding: 1px 0;
  word-break: break-word;
}

.list .marker {
  color: #a1a6ad;
  min-width: 12px;
  text-align: right;
  flex-shrink: 0;
}

.article blockquote {
  margin: 10px 0;
  padding: 8px 12px;
  border-left: 3px solid #c7cbf5;
  background: #fafbff;
  border-radius: 0 8px 8px 0;
}

.article blockquote p {
  color: #4e5969;
  margin: 3px 0;
}

.quote-h {
  font-weight: 600;
  color: #1f2329 !important;
}

.tbl {
  width: 100%;
  border-collapse: collapse;
  margin: 10px 0;
  font-size: 12.5px;
}

.tbl th,
.tbl td {
  border: 1px solid #eceef1;
  padding: 6px 9px;
  text-align: left;
  line-height: 1.6;
}

.tbl th {
  background: #fafbfc;
  font-weight: 600;
  color: #4e5969;
}

.article hr {
  border: none;
  border-top: 1px solid #f0f1f3;
  margin: 16px 0;
}

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
  color: #4e5969;
  line-height: 1.7;
  margin: 6px 0;
}

.meta {
  font-size: 11.5px;
  color: #a1a6ad;
  margin: 6px 0 12px;
}

.meta a {
  color: #8f959e;
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
  gap: 2px;
  align-items: flex-start;
  padding: 9px 12px;
  border: 1px solid #eceef1;
  border-radius: 10px;
  background: #fff;
  cursor: pointer;
  font-size: 12.5px;
  color: #1f2329;
  max-width: 210px;
}

.card:hover {
  border-color: #c7cbf5;
  background: #f7f8ff;
}

.card span {
  font-size: 11px;
  color: #a1a6ad;
}

.toast {
  position: fixed;
  left: 50%;
  bottom: 22px;
  transform: translateX(-50%);
  background: rgba(31, 35, 41, 0.88);
  color: #fff;
  font-size: 12px;
  padding: 7px 14px;
  border-radius: 8px;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.18s;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.side::-webkit-scrollbar,
.doc::-webkit-scrollbar,
.code pre::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.side::-webkit-scrollbar-thumb,
.doc::-webkit-scrollbar-thumb,
.code pre::-webkit-scrollbar-thumb {
  background: #d9dce1;
  border-radius: 3px;
}
</style>
