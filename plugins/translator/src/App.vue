<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import PopMenu from '../../../src/shared/ui/PopMenu.vue'
import ConfirmDialog from '../../../src/shared/ui/ConfirmDialog.vue'
import { MENU_W, type MenuItem } from '../../../src/shared/ui/menu'

/** 翻译源：url 模板中的 {q} 会被替换为 URL 编码后的查询词 */
interface Source {
  id: string
  name: string
  url: string
}

/** 一次待确认的破坏性操作 */
interface PendingConfirm {
  title: string
  message: string
  hint?: string
  confirmLabel: string
  run: () => void
}

const PRESETS: Source[] = [
  { id: 'google', name: 'Google', url: 'https://translate.google.com/?sl=auto&tl=zh-CN&text={q}&op=translate' },
  { id: 'deepl', name: 'DeepL', url: 'https://www.deepl.com/translator#auto/zh/{q}' },
  { id: 'bing', name: '必应翻译', url: 'https://www.bing.com/translator?text={q}' },
  { id: 'baidu', name: '百度翻译', url: 'https://fanyi.baidu.com/#auto/zh/{q}' }
]

const sources = ref<Source[]>([...PRESETS])
const custom = ref<Source[]>([])
const activeId = ref(PRESETS[0].id)
/** 已创建的 webview（懒创建，创建后保留状态） */
const created = ref<string[]>([])
/** 每个源当前的 URL（改变 :src 即导航） */
const urls = ref<Record<string, string>>({})
/** 每个源最后一次导航使用的查询词（相同则不重导航，保留页面状态） */
const navQuery = ref<Record<string, string | undefined>>({})
const query = ref('')
const showAdd = ref(false)
const newName = ref('')
const newUrl = ref('')
const addError = ref('')
const menu = ref<{ x: number; y: number; source: Source } | null>(null)
const confirm = ref<PendingConfirm | null>(null)

/** contextBridge 传参会做结构化克隆，Vue 响应式 Proxy 无法通过——先转纯数据 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  const [savedCustom, savedOrder] = await Promise.all([
    window.appapi.storage.get('custom-sources'),
    window.appapi.storage.get('source-order')
  ])
  if (Array.isArray(savedCustom)) custom.value = savedCustom as Source[]
  const all = [...PRESETS, ...custom.value]
  // 按用户排序恢复引擎顺序（未知 id 追加在末尾）
  if (Array.isArray(savedOrder)) {
    const map = new Map(all.map((s) => [s.id, s]))
    const sorted = (savedOrder as string[])
      .map((id) => map.get(id))
      .filter((s): s is Source => Boolean(s))
    for (const s of all) if (!sorted.includes(s)) sorted.push(s)
    sources.value = sorted
  } else {
    sources.value = all
  }
  activeId.value = sources.value[0]?.id ?? PRESETS[0].id
  // 面板搜索词透传：打开即翻译
  window.appapi.onQuery((payload) => {
    if (payload?.query?.trim()) {
      query.value = payload.query.trim()
      openSource(activeSource(), query.value)
    }
  })
})

onUnmounted(() => window.removeEventListener('keydown', onKeydown))

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  // 浮层自己处理 Esc（捕获阶段），别顺手把插件退了
  if (menu.value || confirm.value) return
  if (showAdd.value) {
    showAdd.value = false
    return
  }
  void window.appapi.exit()
}

function exit(): void {
  void window.appapi.exit()
}

function activeSource(): Source {
  return sources.value.find((s) => s.id === activeId.value) ?? sources.value[0]
}

/** 首页（不带查询词）：取模板中 {q} 之前的部分；纯网址模板即完整地址 */
function homeUrl(s: Source): string {
  return s.url.split('{q}')[0]
}

/** 打开（或切换到）某个引擎：无 URL 时打开主页/带查询词时导航翻译 */
function openSource(s: Source, q?: string): void {
  if (!created.value.includes(s.id)) created.value = [...created.value, s.id]
  // 同一引擎、同一查询词 → 不重导航，保留页面内状态
  if (urls.value[s.id] && navQuery.value[s.id] === q) return
  urls.value = { ...urls.value, [s.id]: q ? s.url.replace('{q}', encodeURIComponent(q)) : homeUrl(s) }
  navQuery.value = { ...navQuery.value, [s.id]: q }
}

function activate(s: Source): void {
  activeId.value = s.id
  // 已有搜索词 → 用该引擎翻译同一内容；否则打开站点主页
  openSource(s, query.value || undefined)
}

async function persistOrder(): Promise<void> {
  await window.appapi.storage.set('source-order', plain(sources.value.map((s) => s.id)))
}

async function moveSource(s: Source, dir: -1 | 1): Promise<void> {
  const arr = [...sources.value]
  const idx = arr.findIndex((x) => x.id === s.id)
  const to = idx + dir
  if (idx < 0 || to < 0 || to >= arr.length) return
  ;[arr[idx], arr[to]] = [arr[to], arr[idx]]
  sources.value = arr
  await persistOrder()
}

function isCustom(s: Source): boolean {
  return custom.value.some((c) => c.id === s.id)
}

function openInBrowser(): void {
  const el = document.querySelector('webview.engine.active') as { getURL?: () => string } | null
  const url = el?.getURL?.() ?? homeUrl(activeSource())
  void window.appapi.shell.openExternal(url)
}

async function addSource(): Promise<void> {
  const name = newName.value.trim()
  const url = newUrl.value.trim()
  addError.value = ''
  if (!name || !url) {
    addError.value = '名称和网址都不能为空'
    return
  }
  if (!/^https?:\/\//i.test(url)) {
    addError.value = '网址需以 http(s):// 开头'
    return
  }
  // 不含 {q} 时后台自动补全为查询参数（站点不支持自动填词时至少能打开主页）
  const finalUrl = url.includes('{q}') ? url : url + (url.includes('?') ? '&' : '?') + 'q={q}'
  const source: Source = { id: `c${Date.now()}`, name, url: finalUrl }
  try {
    custom.value = [...custom.value, source]
    sources.value = [...sources.value, source]
    await window.appapi.storage.set('custom-sources', plain(custom.value))
    await persistOrder()
    newName.value = ''
    newUrl.value = ''
    showAdd.value = false
    activate(source)
  } catch (err) {
    // 存储失败时保持弹窗打开并提示，避免静默丢数据
    addError.value = '保存失败：' + (err instanceof Error ? err.message : String(err))
    console.error('[translator] addSource failed', err)
  }
}

async function removeSource(s: Source): Promise<void> {
  custom.value = custom.value.filter((c) => c.id !== s.id)
  sources.value = sources.value.filter((x) => x.id !== s.id)
  created.value = created.value.filter((id) => id !== s.id)
  const rest = { ...urls.value }
  delete rest[s.id]
  urls.value = rest
  if (activeId.value === s.id) activeId.value = sources.value[0]?.id ?? ''
  await window.appapi.storage.set('custom-sources', plain(custom.value))
  await persistOrder()
}

// ---------- 引擎菜单（右键 / hover 的 ··· 共用） ----------

function openTabMenu(s: Source, event: MouseEvent): void {
  if (event.type === 'contextmenu') {
    menu.value = { x: event.clientX, y: event.clientY, source: s }
    return
  }
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  // 标签在左侧栏，菜单贴右边展开（往内容区方向），不然会翻到窗口外面
  menu.value = { x: rect.right + 2, y: rect.bottom + 3, source: s }
}

function tabMenuItems(s: Source): MenuItem[] {
  const idx = sources.value.findIndex((x) => x.id === s.id)
  return [
    { key: 'up', label: '上移', icon: 'up', disabled: idx <= 0 },
    { key: 'down', label: '下移', icon: 'down', disabled: idx < 0 || idx >= sources.value.length - 1 },
    {
      key: 'delete',
      label: '删除该翻译源',
      icon: 'delete',
      danger: true,
      disabled: !isCustom(s)
    }
  ]
}

function onMenuPick(key: string): void {
  const target = menu.value?.source
  menu.value = null
  if (!target) return
  if (key === 'up') {
    void moveSource(target, -1)
    return
  }
  if (key === 'down') {
    void moveSource(target, 1)
    return
  }
  if (key === 'delete') {
    confirm.value = {
      title: `删除「${target.name}」？`,
      message: '这个自定义翻译源会从列表里移除。',
      hint: '内置引擎不能删除；需要的话可以重新添加同一个网址。',
      confirmLabel: '删除',
      run: () => void removeSource(target)
    }
  }
}

function runConfirm(): void {
  const state = confirm.value
  confirm.value = null
  state?.run()
}
</script>

<template>
  <div class="pl-page flush">
    <header class="pl-head bar">
      <button class="pl-btn" @click="exit"><span class="arrow">‹</span> 返回</button>
      <h1 class="pl-title">快速翻译</h1>
      <button class="pl-btn" @click="openInBrowser">浏览器打开</button>
      <button class="pl-btn primary" @click="showAdd = true">＋ 添加翻译源</button>
    </header>

    <div class="main">
      <nav class="tabs">
        <div v-for="(s, i) in sources" :key="s.id" class="tab-wrap">
          <button
            class="tab"
            :class="{ active: s.id === activeId }"
            :title="s.url"
            @click="activate(s)"
            @contextmenu.prevent="openTabMenu(s, $event)"
          >
            <span class="tab-name">{{ s.name }}</span>
          </button>
          <!-- 操作入口独立成按钮（不能嵌在 .tab 里面：button 套 button 是非法结构） -->
          <button
            class="tab-op"
            :aria-label="`${s.name} 的操作`"
            :tabindex="i === 0 ? 0 : -1"
            @click.stop="openTabMenu(s, $event)"
          >
            ···
          </button>
        </div>
      </nav>

      <div class="views">
        <template v-for="s in sources" :key="s.id">
          <webview
            v-if="created.includes(s.id)"
            v-show="s.id === activeId"
            class="engine"
            :class="{ active: s.id === activeId }"
            :src="urls[s.id] ?? homeUrl(s)"
          />
        </template>
        <div v-if="!created.length" class="pl-empty placeholder">
          <p>左侧选择翻译引擎开始使用</p>
          <p class="sub">在面板输入英文并回车打开本应用，会直接用当前引擎翻译</p>
        </div>
      </div>
    </div>

    <div v-if="showAdd" class="pl-mask">
      <div class="pl-dialog">
        <div class="pl-dialog-head">
          <h2>添加翻译源</h2>
          <button class="pl-icon-btn" title="关闭" @click="showAdd = false">✕</button>
        </div>
        <label class="pl-label">名称</label>
        <input v-model="newName" class="pl-input" type="text" placeholder="如有道翻译" spellcheck="false" />
        <label class="pl-label">网址（可含 {q} 占位符，打开时替换为要翻译的词）</label>
        <input
          v-model="newUrl"
          class="pl-input mono"
          type="text"
          placeholder="https://fanyi.youdao.com/"
          spellcheck="false"
        />
        <p class="pl-hint">
          直接粘贴翻译网站地址即可；若网址不含 <code>{q}</code> 占位符，会自动追加
          <code>?q=…</code> 传参（不支持传参的站点也能添加，仅打开主页后手动输入）。
          需要精确控制可自行写入占位符。
        </p>
        <p v-if="addError" class="err">{{ addError }}</p>
        <div class="pl-actions">
          <button class="pl-btn" @click="showAdd = false">取消</button>
          <button class="pl-btn primary" @click="addSource">添加</button>
        </div>
      </div>
    </div>

    <PopMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :items="tabMenuItems(menu.source)"
      @pick="onMenuPick"
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
/* 骨架与控件来自 plugin-ui.css；这里只保留「左侧引擎栏 + 右侧 webview」的布局 */
.bar {
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line-soft);
}

.main {
  flex: 1;
  display: flex;
  min-height: 0;
}

.tabs {
  flex: none;
  width: 126px;
  padding: 8px 6px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  overflow-y: auto;
  border-right: 1px solid var(--line-soft);
}

.tab-wrap {
  position: relative;
  display: flex;
}

.tab {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  min-height: 32px;
  padding: 0 26px 0 10px;
  border-radius: var(--r-sm);
  font-size: 12.5px;
  color: var(--text-2);
  text-align: left;
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.tab:hover {
  background: var(--bg-hover);
}

.tab.active {
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-weight: 500;
}

.tab-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 引擎的操作入口：默认隐形，hover/选中才出现，避免一排小图标把侧栏撑乱 */
.tab-op {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: var(--r-xs);
  font-size: 12px;
  letter-spacing: 1px;
  color: var(--text-3);
  opacity: 0;
  cursor: pointer;
  transition:
    opacity var(--dur) var(--ease),
    background var(--dur) var(--ease);
}

.tab-wrap:hover .tab-op,
.tab.active + .tab-op,
.tab-op:focus-visible {
  opacity: 1;
}

.tab-op:hover {
  background: var(--bg-active);
  color: var(--text-1);
}

.views {
  flex: 1;
  position: relative;
  min-width: 0;
}

/* 空态铺满右侧内容区（.pl-empty 本身是 flex 居中的） */
.placeholder {
  position: absolute;
  inset: 0;
}

webview.engine {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  background: var(--bg);
}

.err {
  font-size: 12px;
  color: var(--danger);
}
</style>
