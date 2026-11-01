<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { evaluate } from './evaluator'

const expr = ref('')
const result = ref('')
const error = ref('')

const KEYS: string[][] = [
  ['C', '(', ')', '÷'],
  ['7', '8', '9', '×'],
  ['4', '5', '6', '−'],
  ['1', '2', '3', '+'],
  ['0', '.', '%', '=']
]

const DISPLAY_TO_OP: Record<string, string> = { '÷': '/', '×': '*', '−': '-' }
const KEY_MAP: Record<string, string> = {
  Enter: '=',
  '=': '=',
  Backspace: 'back',
  Escape: 'exit',
  c: 'C',
  C: 'C'
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  setupInline()
})
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

/**
 * 内联结果：manifest 声明 features:["inline"] 后，面板每敲一次键就把查询推过来。
 * 这里只认「像算式」的输入（含运算符、且只由数字/运算符/括号组成），算得出就回一条，
 * 回车复制；算不出就回空数组，面板不会显示任何东西。
 */
function setupInline(): void {
  window.appapi.onInlineQuery(({ seq, query }) => {
    const raw = query.trim().replace(/[÷×−]/g, (m) => DISPLAY_TO_OP[m] ?? m)
    const looksLikeExpression = /[-+*/%()]/.test(raw) && /^[\d.+\-*/%()\s]+$/.test(raw)
    if (!looksLikeExpression) {
      void window.appapi.inline.set({ seq, items: [] })
      return
    }
    try {
      const text = format(evaluate(raw))
      void window.appapi.inline.set({
        seq,
        items: [
          {
            id: `${raw}=${text}`,
            title: text,
            subtitle: `${query.trim()} =`,
            badge: '=',
            action: { type: 'copy', text }
          }
        ]
      })
    } catch {
      // 除零、括号不配对等：这次没有结果，面板照常显示其他内容
      void window.appapi.inline.set({ seq, items: [] })
    }
  })
}

function exit(): void {
  void window.appapi.exit()
}

function onKeydown(e: KeyboardEvent): void {
  if (e.ctrlKey || e.altKey || e.metaKey) return
  const mapped = KEY_MAP[e.key]
  if (mapped) {
    e.preventDefault()
    press(mapped)
  } else if (/^[0-9.+*()/%-]$/.test(e.key)) {
    e.preventDefault()
    press(e.key.replace('*', '×').replace('/', '÷').replace('-', '−'))
  }
}

function press(key: string): void {
  if (key === 'exit') {
    void window.appapi.exit()
    return
  }
  if (key === 'C') {
    expr.value = ''
    result.value = ''
    error.value = ''
    return
  }
  if (key === 'back') {
    expr.value = expr.value.slice(0, -1)
    error.value = ''
    return
  }
  if (key === '=') {
    doEvaluate()
    return
  }
  // 刚算完结果后继续输入运算符 → 基于结果继续算
  if (result.value && !expr.value) expr.value = result.value
  result.value = ''
  error.value = ''
  expr.value += key
}

function doEvaluate(): void {
  if (!expr.value.trim()) return
  try {
    const value = evaluate(expr.value.replace(/[÷×−]/g, (m) => DISPLAY_TO_OP[m] ?? m))
    result.value = format(value)
    expr.value = result.value
    error.value = ''
  } catch (err) {
    error.value = err instanceof Error ? err.message : '表达式错误'
    result.value = ''
  }
}

function format(value: number): string {
  if (Math.abs(value) >= 1e15 || (Math.abs(value) < 1e-9 && value !== 0)) {
    return value.toExponential(6)
  }
  return String(value)
}
</script>

<template>
  <div class="page">
    <header>
      <button class="ghost" @click="exit">
        <span class="arrow">‹</span> 返回
      </button>
      <h1>计算器</h1>
      <button class="ghost" @click="press('C')">清空</button>
    </header>

    <div class="screen">
      <div class="expr">{{ expr || '0' }}</div>
      <div class="result" :class="{ err: error }">{{ error || result || ' ' }}</div>
    </div>

    <div class="keys">
      <button
        v-for="key in KEYS.flat()"
        :key="key"
        class="key"
        :class="{ op: '+−×÷%()'.includes(key), eq: key === '=', fn: key === 'C' }"
        @click="press(key)"
      >
        {{ key }}
      </button>
    </div>
    <p class="tip">支持键盘输入 · Enter 等号 · Backspace 删除 · Esc 返回</p>
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
}

.page {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 14px 22px 12px;
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

.arrow {
  font-size: 15px;
}

.screen {
  margin: 12px 0;
  padding: 14px 16px;
  background: #f5f6f7;
  border-radius: 12px;
  text-align: right;
  min-height: 84px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
}

.expr {
  font-size: 15px;
  color: #646a73;
  word-break: break-all;
  min-height: 20px;
}

.result {
  font-size: 26px;
  font-weight: 600;
  min-height: 34px;
}

.result.err {
  font-size: 14px;
  color: #d5304f;
  font-weight: 400;
}

.keys {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.key {
  border: none;
  border-radius: 10px;
  background: #f5f6f7;
  font-size: 18px;
  cursor: pointer;
  transition: background 0.1s;
}

.key:hover {
  background: #ececee;
}

.key:active {
  background: #e0e2e5;
}

.key.op {
  color: #4f46e5;
  font-size: 17px;
}

.key.fn {
  color: #d5304f;
}

.key.eq {
  background: #6366f1;
  color: #fff;
  font-size: 20px;
}

.key.eq:hover {
  background: #5759ec;
}

.tip {
  text-align: center;
  font-size: 11px;
  color: #a1a6ad;
  margin-top: 8px;
}
</style>
