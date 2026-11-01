<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

interface ClipItem {
  text: string
  ts: number
}

const MAX_ITEMS = 100
const items = ref<ClipItem[]>([])
const copiedTs = ref<number | null>(null)
let timer: ReturnType<typeof setInterval> | undefined
let last = ''

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  const saved = await window.appapi.storage.get('history')
  if (Array.isArray(saved)) items.value = saved as ClipItem[]
  last = (await window.appapi.clipboard.readText()) ?? ''
  // 视图退出后只缓存不销毁，onUnmounted 不会再触发；轮询改由可见性事件控制，
  // 切走/收起面板时立刻停（不空转、不读剪贴板），回来时补一次并继续。
  window.appapi.onShow(() => {
    void poll()
    startPolling()
  })
  window.appapi.onHide(stopPolling)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  stopPolling()
})

function startPolling(): void {
  if (timer) return
  timer = setInterval(poll, 800)
}

function stopPolling(): void {
  if (!timer) return
  clearInterval(timer)
  timer = undefined
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') void window.appapi.exit()
}

function exit(): void {
  void window.appapi.exit()
}

async function poll(): Promise<void> {
  try {
    const text = await window.appapi.clipboard.readText()
    if (text && text !== last) {
      last = text
      push(text)
    }
  } catch {
    /* 剪贴板权限异常时静默 */
  }
}

function push(text: string): void {
  if (items.value[0]?.text === text) return
  items.value = [{ text, ts: Date.now() }, ...items.value].slice(0, MAX_ITEMS)
  void save()
}

/** contextBridge 传参会结构化克隆，Vue Proxy 不能直接传，先转纯数据 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

async function save(): Promise<void> {
  try {
    await window.appapi.storage.set('history', plain(items.value))
  } catch {
    /* ignore */
  }
}

async function copy(item: ClipItem): Promise<void> {
  await window.appapi.clipboard.writeText(item.text)
  copiedTs.value = item.ts
  void window.appapi.notify('剪贴板历史', '内容已复制到剪贴板')
  setTimeout(() => {
    copiedTs.value = null
  }, 800)
}

async function removeAt(index: number): Promise<void> {
  items.value.splice(index, 1)
  await save()
}

async function clearAll(): Promise<void> {
  items.value = []
  await save()
}

function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > 90 ? oneLine.slice(0, 90) + '…' : oneLine
}
</script>

<template>
  <div class="page">
    <header>
      <button class="ghost" @click="exit">
        <span class="arrow">‹</span> 返回
      </button>
      <h1>剪贴板历史</h1>
      <button class="ghost danger" @click="clearAll">清空</button>
    </header>
    <p class="tip">自动记录复制的文本（最近 {{ MAX_ITEMS }} 条）· 点击条目重新复制 · Esc 返回</p>
    <ul v-if="items.length">
      <li
        v-for="(item, i) in items"
        :key="item.ts"
        :class="{ copied: copiedTs === item.ts }"
        @click="copy(item)"
      >
        <span class="text">{{ preview(item.text) }}</span>
        <button class="del" title="删除" @click.stop="removeAt(i)">✕</button>
      </li>
    </ul>
    <p v-else class="empty">暂无记录，去别处复制点内容试试</p>
  </div>
</template>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html,
body {
  height: 100%;
  background: #fff;
}

body {
  font-family: 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
  color: #1f2329;
  user-select: none;
}

#app {
  height: 100%;
}

.page {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 14px 18px;
}

header {
  display: flex;
  align-items: center;
  gap: 10px;
}

h1 {
  flex: 1;
  text-align: center;
  font-size: 15px;
  font-weight: 600;
}

.ghost {
  font-size: 13px;
  color: #646a73;
  padding: 5px 10px;
  border-radius: 8px;
  border: none;
  background: none;
  cursor: pointer;
}

.ghost:hover {
  background: #f2f3f5;
  color: #1f2329;
}

.ghost.danger:hover {
  color: #d5304f;
  background: #fdecef;
}

.arrow {
  font-size: 15px;
}

.tip {
  text-align: center;
  font-size: 11px;
  color: #a1a6ad;
  margin: 6px 0 10px;
}

ul {
  flex: 1;
  overflow-y: auto;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border-radius: 9px;
  background: #f5f6f7;
  cursor: pointer;
  transition: background 0.12s;
}

li:hover {
  background: #ececee;
}

li.copied {
  background: #eef0fe;
  outline: 1px solid #c3c8f9;
}

.text {
  flex: 1;
  font-size: 13px;
  line-height: 1.5;
  word-break: break-all;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.del {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  font-size: 11px;
  color: #a1a6ad;
  border: none;
  background: none;
  cursor: pointer;
}

.del:hover {
  background: rgba(0, 0, 0, 0.07);
  color: #d5304f;
}

.empty {
  margin-top: 80px;
  text-align: center;
  font-size: 13px;
  color: #a1a6ad;
}

::-webkit-scrollbar {
  width: 6px;
}

::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.14);
  border-radius: 3px;
}
</style>
