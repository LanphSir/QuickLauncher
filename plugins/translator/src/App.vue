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
const query = ref('')
const showAdd = ref(false)
const newName = ref('')
const newUrl = ref('')
const addError = ref('')

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  const saved = await window.appapi.storage.get('custom-sources')
  if (Array.isArray(saved)) {
    custom.value = saved as Source[]
    sources.value = [...PRESETS, ...custom.value]
  }
  // 面板搜索词透传：打开即翻译
  window.appapi.onQuery((payload) => {
    if (payload?.query?.trim()) {
      query.value = payload.query.trim()
      navigate(activeSource(), query.value)
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

/** 首页（不带查询词）：取模板中 {q} 之前的部分，保证是可打开的站点地址 */
function homeUrl(s: Source): string {
  return s.url.split('{q}')[0]
}

function navigate(s: Source, q?: string): void {
  if (!created.value.includes(s.id)) created.value = [...created.value, s.id]
  urls.value = { ...urls.value, [s.id]: q ? s.url.replace('{q}', encodeURIComponent(q)) : homeUrl(s) }
}

function activate(s: Source): void {
  activeId.value = s.id
  // 已有搜索词时切换引擎 = 用新引擎翻译同一内容
  if (query.value && !urls.value[s.id]) navigate(s, query.value)
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
  if (!url.includes('{q}')) {
    addError.value = '网址模板需包含 {q} 占位符（查询词会替换进去）'
    return
  }
  const source: Source = { id: `c${Date.now()}`, name, url }
  custom.value = [...custom.value, source]
  sources.value = [...PRESETS, ...custom.value]
  await window.appapi.storage.set('custom-sources', custom.value)
  newName.value = ''
  newUrl.value = ''
  showAdd.value = false
  activate(source)
}

async function removeSource(s: Source): Promise<void> {
  custom.value = custom.value.filter((c) => c.id !== s.id)
  sources.value = [...PRESETS, ...custom.value]
  created.value = created.value.filter((id) => id !== s.id)
  const rest = { ...urls.value }
  delete rest[s.id]
  urls.value = rest
  if (activeId.value === s.id) activeId.value = PRESETS[0].id
  await window.appapi.storage.set('custom-sources', custom.value)
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
          v-for="s in sources"
          :key="s.id"
          class="tab"
          :class="{ active: s.id === activeId }"
          @click="activate(s)"
        >
          <span class="tab-name">{{ s.name }}</span>
          <span
            v-if="custom.some((c) => c.id === s.id)"
            class="tab-del"
            title="删除该翻译源"
            @click.stop="removeSource(s)"
          >✕</span>
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

    <div v-if="showAdd" class="add-backdrop" @click.self="showAdd = false">
      <div class="add-card">
        <h2>添加翻译源</h2>
        <label>名称</label>
        <input v-model="newName" class="field" type="text" placeholder="如有道翻译" spellcheck="false" />
        <label>网址模板（查询词会替换其中的 q 占位符）</label>
        <input
          v-model="newUrl"
          class="field mono"
          type="text"
          placeholder="https://fanyi.youdao.com/#auto/zh/{q}"
          spellcheck="false"
        />
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
  flex: none; width: 118px; padding: 8px 6px;
  border-right: 1px solid #f2f3f5;
  display: flex; flex-direction: column; gap: 3px; overflow-y: auto;
}
.tab {
  position: relative; display: flex; align-items: center;
  height: 32px; padding: 0 10px; border: none; border-radius: 8px;
  background: none; cursor: pointer; font-size: 12.5px; color: #646a73; text-align: left;
}
.tab:hover { background: #f5f6f7; }
.tab.active { background: #e8f4fd; color: #0b7ec2; font-weight: 500; }
.tab-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tab-del {
  flex: none; width: 16px; height: 16px; display: none;
  place-items: center; border-radius: 50%; font-size: 9px; color: #a1a6ad;
}
.tab:hover .tab-del { display: grid; }
.tab-del:hover { background: rgba(0,0,0,.08); color: #d5304f; }
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
.add-backdrop {
  position: fixed; inset: 0; background: rgba(15,18,25,.32);
  display: grid; place-items: center; z-index: 10;
}
.add-card {
  width: 400px; background: #fff; border-radius: 14px; padding: 18px;
  box-shadow: 0 14px 50px rgba(0,0,0,.22); display: flex; flex-direction: column; gap: 6px;
}
.add-card h2 { font-size: 15px; margin-bottom: 6px; }
.add-card label { font-size: 12px; color: #646a73; }
.field {
  height: 34px; padding: 0 10px; font-size: 13px; color: #1f2329;
  border: 1px solid #dfe1e4; border-radius: 8px; outline: none;
}
.field:focus { border-color: #0ea5e9; }
.field.mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
.err { font-size: 12px; color: #d5304f; }
.row { display: flex; gap: 8px; margin-top: 10px; }
.go {
  flex: none; padding: 7px 18px; border: none; border-radius: 8px;
  background: #0ea5e9; color: #fff; font-size: 13px; cursor: pointer;
}
.go:hover { background: #0b96d6; }
</style>
