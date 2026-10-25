<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

interface HistoryItem {
  text: string
  result: string
  ts: number
}

const MAX_HISTORY = 30
const input = ref('')
const result = ref('')
const loading = ref(false)
const error = ref('')
const copied = ref(false)
const history = ref<HistoryItem[]>([])

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  window.appapi.onQuery((payload) => {
    if (payload?.query && payload.query.trim()) {
      input.value = payload.query.trim()
      void translate()
    }
  })
  const saved = await window.appapi.storage.get('history')
  if (Array.isArray(saved)) history.value = saved as HistoryItem[]
})

onUnmounted(() => window.removeEventListener('keydown', onKeydown))

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') void window.appapi.exit()
}

function exit(): void {
  void window.appapi.exit()
}

/** 简单语向判断：含中文 → 中译英，否则英译中 */
function langPair(text: string): string {
  return /[\u4e00-\u9fa5]/.test(text) ? 'zh-CN|en-US' : 'en|zh-CN'
}

async function translate(): Promise<void> {
  const text = input.value.trim()
  if (!text || loading.value) return
  loading.value = true
  error.value = ''
  result.value = ''
  copied.value = false
  try {
    const res = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${langPair(text)}`
    )
    const data = (await res.json()) as {
      responseData?: { translatedText?: string }
      responseDetails?: string
    }
    const translated = data.responseData?.translatedText
    if (!translated) throw new Error(data.responseDetails || '无翻译结果')
    result.value = translated
    pushHistory({ text, result: translated, ts: Date.now() })
  } catch {
    error.value = '翻译服务暂不可达，请检查网络后重试（回车重试）'
  } finally {
    loading.value = false
  }
}

async function pushHistory(item: HistoryItem): Promise<void> {
  history.value = [item, ...history.value.filter((h) => h.text !== item.text)].slice(0, MAX_HISTORY)
  await window.appapi.storage.set('history', history.value)
}

async function copyResult(): Promise<void> {
  if (!result.value) return
  await window.appapi.clipboard.writeText(result.value)
  copied.value = true
  setTimeout(() => (copied.value = false), 900)
}

function useHistory(item: HistoryItem): void {
  input.value = item.text
  result.value = item.result
  error.value = ''
}

async function clearHistory(): Promise<void> {
  history.value = []
  await window.appapi.storage.set('history', history.value)
}
</script>

<template>
  <div class="page">
    <header>
      <button class="ghost" @click="exit"><span class="arrow">‹</span> 返回</button>
      <h1>快速翻译</h1>
      <button class="ghost" @click="clearHistory">清空历史</button>
    </header>

    <div class="input-row">
      <input
        v-model="input"
        class="input"
        type="text"
        placeholder="输入英文或中文，回车翻译"
        spellcheck="false"
        autofocus
        @keydown.enter.prevent="translate()"
      />
      <button class="go" :disabled="loading || !input.trim()" @click="translate()">
        {{ loading ? '…' : '翻译' }}
      </button>
    </div>

    <div v-if="result || error" class="result-card" :class="{ err: error }" @click="copyResult">
      <template v-if="error">{{ error }}</template>
      <template v-else>
        <span class="result-text">{{ result }}</span>
        <span class="copy-hint">{{ copied ? '已复制 ✓' : '点击复制' }}</span>
      </template>
    </div>

    <div v-if="history.length" class="history">
      <div class="history-title">最近</div>
      <button v-for="item in history.slice(0, 6)" :key="item.ts" class="history-item" @click="useHistory(item)">
        <span class="h-text">{{ item.text }}</span>
        <span class="h-result">{{ item.result }}</span>
      </button>
    </div>

    <p class="tip">在面板输入任意英文即可命中本应用 · Esc 返回</p>
  </div>
</template>

<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body, #app { height: 100%; }
body {
  font-family: 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
  color: #1f2329; background: #fff; user-select: none;
}
.page { height: 100%; display: flex; flex-direction: column; padding: 14px 20px 10px; }
header { display: flex; align-items: center; gap: 10px; }
h1 { flex: 1; text-align: center; font-size: 15px; font-weight: 600; }
.ghost {
  font-size: 13px; color: #646a73; padding: 5px 10px;
  border-radius: 8px; border: none; background: none; cursor: pointer;
}
.ghost:hover { background: #f2f3f5; color: #1f2329; }
.arrow { font-size: 15px; }
.input-row { display: flex; gap: 8px; margin: 14px 0 10px; }
.input {
  flex: 1; height: 40px; padding: 0 14px; font-size: 15px;
  border: 1px solid #dfe1e4; border-radius: 10px; outline: none; color: #1f2329;
}
.input:focus { border-color: #0ea5e9; box-shadow: 0 0 0 2px rgba(14, 165, 233, 0.15); }
.go {
  flex: none; width: 76px; border: none; border-radius: 10px; cursor: pointer;
  background: #0ea5e9; color: #fff; font-size: 14px;
}
.go:disabled { opacity: 0.5; cursor: default; }
.go:hover:not(:disabled) { background: #0b96d6; }
.result-card {
  padding: 16px; border-radius: 12px; background: #f0f9ff;
  cursor: pointer; display: flex; align-items: baseline; gap: 10px;
}
.result-card.err { background: #fef2f2; color: #d5304f; font-size: 13px; }
.result-text { flex: 1; font-size: 17px; line-height: 1.6; word-break: break-word; }
.copy-hint { flex: none; font-size: 11px; color: #0b96d6; }
.history { margin-top: 14px; overflow-y: auto; }
.history-title { font-size: 12px; color: #8f959e; margin-bottom: 6px; }
.history-item {
  width: 100%; display: flex; gap: 12px; align-items: baseline; text-align: left;
  padding: 8px 12px; border-radius: 9px; border: none; background: #f5f6f7;
  cursor: pointer; margin-bottom: 5px; color: #1f2329;
}
.history-item:hover { background: #ececee; }
.h-text { flex: none; max-width: 45%; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.h-result { flex: 1; font-size: 12.5px; color: #646a73; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tip { margin-top: auto; text-align: center; font-size: 11px; color: #a1a6ad; padding-top: 8px; }
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-thumb { background: rgba(0, 0, 0, 0.14); border-radius: 3px; }
</style>
