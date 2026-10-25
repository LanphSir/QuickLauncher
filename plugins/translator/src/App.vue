<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

/** 翻译源：url 模板中的 {q} 会被替换为 URL 编码后的查询词 */
interface Source {
  id: string
  name: string
  url: string
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
  const finalUrl = url.includes('{q}')
    ? url
    : url + (url.includes('?') ? '&' : '?') + 'q={q}'
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
</script>

<template>
  <div class="page">
    <header>
      <button class="ghost" @click="exit"><span class="arrow">‹</span> 返回</button>
      <h1>快速翻译</h1>
      <button class="ghost" @click="openInBrowser">浏览器打开</button>
      <button class="ghost add" @click="showAdd = true">＋ 添加翻译源</button>
    </header>

    <div class="main">
      <nav class="tabs">
        <button
          v-for="(s, i) in sources"
          :key="s.id"
          class="tab"
          :class="{ active: s.id === activeId }"
          :title="s.url"
          @click="activate(s)"
        >
          <span class="tab-name">{{ s.name }}</span>
          <span class="tab-ops">
            <span v-if="i > 0" class="tab-op" title="上移" @click.stop="moveSource(s, -1)">↑</span>
            <span v-if="i < sources.length - 1" class="tab-op" title="下移" @click.stop="moveSource(s, 1)">↓</span>
            <span v-if="isCustom(s)" class="tab-op del" title="删除该翻译源" @click.stop="removeSource(s)">✕</span>
          </span>
        </button>
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
        <div v-if="!created.length" class="placeholder">
          <p>左侧选择翻译引擎开始使用</p>
          <p class="sub">在面板输入英文并回车打开本应用，会直接用当前引擎翻译</p>
        </div>
      </div>
    </div>

    <div v-if="showAdd" class="add-backdrop">
      <div class="add-card">
        <header class="add-head">
          <h2>添加翻译源</h2>
          <button class="x" title="关闭" @click="showAdd = false">✕</button>
        </header>
        <label>名称</label>
        <input v-model="newName" class="field" type="text" placeholder="如有道翻译" spellcheck="false" />
        <label>网址（可含 q 占位符，打开时替换为要翻译的词）</label>
        <input
          v-model="newUrl"
          class="field mono"
          type="text"
          placeholder="https://fanyi.youdao.com/"
          spellcheck="false"
        />
        <p class="hint">
          直接粘贴翻译网站地址即可；若网址不含 <code>q</code> 占位符，会自动追加
          <code>?q=…</code> 传参（不支持传参的站点也能添加，仅打开主页后手动输入）。
          需要精确控制可自行写入占位符，如 <code>https://fanyi.youdao.com/#auto/zh/q</code> 样式。
        </p>
        <p v-if="addError" class="err">{{ addError }}</p>
        <div class="row">
          <button class="go" @click="addSource">添加</button>
          <button class="ghost" @click="showAdd = false">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body, #app { height: 100%; }
body {
  font-family: 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
  color: #1f2329; background: #fff; user-select: none;
}
.page { height: 100%; display: flex; flex-direction: column; }
header {
  flex: none; display: flex; align-items: center; gap: 8px;
  padding: 10px 14px; border-bottom: 1px solid #f2f3f5;
}
h1 { flex: 1; text-align: center; font-size: 14px; font-weight: 600; }
.ghost {
  font-size: 12.5px; color: #646a73; padding: 5px 9px;
  border-radius: 8px; border: none; background: none; cursor: pointer;
}
.ghost:hover { background: #f2f3f5; color: #1f2329; }
.ghost.add { color: #0b96d6; }
.arrow { font-size: 14px; }
.main { flex: 1; display: flex; min-height: 0; }
.tabs {
  flex: none; width: 126px; padding: 8px 6px;
  border-right: 1px solid #f2f3f5;
  display: flex; flex-direction: column; gap: 3px; overflow-y: auto;
}
.tab {
  position: relative; display: flex; align-items: center;
  min-height: 32px; padding: 0 8px 0 10px; border: none; border-radius: 8px;
  background: none; cursor: pointer; font-size: 12.5px; color: #646a73; text-align: left;
}
.tab:hover { background: #f5f6f7; }
.tab.active { background: #e8f4fd; color: #0b7ec2; font-weight: 500; }
.tab-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tab-ops { flex: none; display: none; align-items: center; gap: 2px; }
.tab:hover .tab-ops { display: inline-flex; }
.tab-op {
  display: grid; place-items: center; width: 16px; height: 16px;
  border-radius: 4px; font-size: 10px; color: #a1a6ad; cursor: pointer;
}
.tab-op:hover { background: rgba(0, 0, 0, 0.08); color: #1f2329; }
.tab-op.del:hover { color: #d5304f; }
.views { flex: 1; position: relative; min-width: 0; }
webview.engine {
  position: absolute; inset: 0; width: 100%; height: 100%;
  background: #fff;
}
.placeholder {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 6px; color: #8f959e; font-size: 14px;
}
.placeholder .sub { font-size: 12px; color: #b4b8bf; }
/* 弹窗遮罩：覆盖全窗口，点击遮罩不关闭（避免选中文本时误触），仅 Esc/取消/✕ 关闭 */
.add-backdrop {
  position: fixed; inset: 0; z-index: 50;
  background: rgba(15, 18, 25, 0.45);
  display: grid; place-items: center;
}
.add-card {
  width: 420px; background: #fff; border-radius: 14px; padding: 18px;
  box-shadow: 0 14px 50px rgba(0, 0, 0, 0.28); display: flex; flex-direction: column; gap: 6px;
}
.add-head { display: flex; align-items: center; margin-bottom: 4px; }
.add-head h2 { flex: 1; font-size: 15px; }
.x {
  display: grid; place-items: center; width: 24px; height: 24px;
  border: none; border-radius: 6px; background: none; cursor: pointer;
  color: #a1a6ad; font-size: 12px;
}
.x:hover { background: #f2f3f5; color: #1f2329; }
.add-card label { font-size: 12px; color: #646a73; }
.field {
  height: 34px; padding: 0 10px; font-size: 13px; color: #1f2329;
  border: 1px solid #dfe1e4; border-radius: 8px; outline: none;
}
.field:focus { border-color: #0ea5e9; }
.field.mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
.hint { font-size: 11.5px; color: #8f959e; line-height: 1.6; }
.hint code {
  font-family: ui-monospace, Consolas, monospace; font-size: 10.5px;
  background: #f5f6f7; padding: 0.5px 4px; border-radius: 4px;
}
.err { font-size: 12px; color: #d5304f; }
.row { display: flex; gap: 8px; margin-top: 10px; }
.go {
  flex: none; padding: 7px 18px; border: none; border-radius: 8px;
  background: #0ea5e9; color: #fff; font-size: 13px; cursor: pointer;
}
.go:hover { background: #0b96d6; }
</style>
