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
  setupTools()
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

/**
 * 工具调用（v0.6.3）：ai/tools.json 里声明的 `calculate` 在这里执行。
 *
 * 为什么放在插件里而不是主进程：这个插件的能力就是「把它自己的求值器算出来的结果
 * 交出去」。主进程替它算，等于把插件的能力搬到更高权限的地方，也让
 * 「插件声明了什么就只能做什么」这条约束失效。
 *
 * 返回值刻意给成一句话而不是裸数字：模型读文本最稳，也顺手把表达式回显了，
 * 用户看到「计算结果：5465」时能对上自己问的是什么。
 */
function setupTools(): void {
  window.appapi.ai.onToolCall((call) => {
    if (call.name !== 'calculate') return { ok: false, error: `这个插件没有名为 ${call.name} 的工具` }
    const expression = String((call.args as Record<string, unknown>).expression ?? '').trim()
    if (!expression) return { ok: false, error: 'expression 不能为空' }
    try {
      return `计算结果：${format(evaluate(expression))}\n表达式：${expression}`
    } catch (err) {
      // 除零、括号不配对等：把原因交给模型，它会换个写法或直接告诉用户
      return { ok: false, error: `算不出来：${err instanceof Error ? err.message : String(err)}` }
    }
  })
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
  <div class="pl-page calc">
    <header class="pl-head">
      <button class="pl-btn" @click="exit">
        <span class="arrow">‹</span> 返回
      </button>
      <h1 class="pl-title">计算器</h1>
      <button class="pl-btn" @click="press('C')">清空</button>
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
    <p class="pl-tip">支持键盘输入 · Enter 等号 · Backspace 删除 · Esc 返回</p>
  </div>
</template>

<style>
/* 颜色/圆角/阴影全部取自 theme.css 的令牌；骨架来自 plugin-ui.css 的 .pl-* */
.calc {
  padding-bottom: 10px;
}

.screen {
  margin: 10px 0;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  min-height: 84px;
  border-radius: var(--r-lg);
  background: var(--bg-soft);
  text-align: right;
}

.expr {
  min-height: 20px;
  font-size: 15px;
  color: var(--text-2);
  word-break: break-all;
}

.result {
  min-height: 34px;
  font-size: 26px;
  font-weight: 600;
  color: var(--text-1);
}

.result.err {
  font-size: 14px;
  font-weight: 400;
  color: var(--danger);
}

.keys {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.key {
  border-radius: var(--r-md);
  background: var(--bg-soft);
  color: var(--text-1);
  font-size: 18px;
  transition: background var(--dur) var(--ease);
}

.key:hover {
  background: var(--bg-hover);
}

.key:active {
  background: var(--bg-active);
}

.key.op {
  font-size: 17px;
  color: var(--accent-strong);
}

.key.fn {
  color: var(--danger);
}

.key.eq {
  font-size: 20px;
  color: var(--on-accent);
  background: var(--accent);
}

.key.eq:hover {
  background: var(--accent-hover);
}

/* 键盘按下的那一下要看得见：键太密，光靠 :active 不够 */
.key:focus-visible {
  box-shadow: var(--ring);
}
</style>
