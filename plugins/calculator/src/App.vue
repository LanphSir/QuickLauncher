<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { evaluate } from './evaluator'
import { applyKey, decorate, format, INITIAL, preview, type CalcState } from './keypad'

/** 一条历史记录：表达式与结果是算完就固定的，at 只用来排序与去重 */
interface HistItem {
  expr: string
  result: string
  at: number
}

interface KeyDef {
  label: string
  act: string
  kind?: 'op' | 'fn' | 'eq'
}

const MAX_HIST = 30
const STORE_KEY = 'history'

const st = ref<CalcState>({ ...INITIAL })
const hist = ref<HistItem[]>([])
const showHist = ref(false)
const flash = ref('')
const toast = ref('')
const exprEl = ref<HTMLElement | null>(null)
/** 上/下键召回历史时的位置 */
let cursor = -1
let flashTimer: ReturnType<typeof setTimeout> | undefined
let toastTimer: ReturnType<typeof setTimeout> | undefined

const k = (label: string, act = label, kind?: KeyDef['kind']): KeyDef => ({ label, act, kind })

/**
 * 六行键盘：上四行是数字与四则，第五行是符号与小数，第六行是「次要运算 + 等号」。
 * 等号固定右下角——手在小键盘上按惯了，换位置就是给自己找别扭。
 */
const KEYS: KeyDef[][] = [
  [k('C', 'C', 'fn'), k('⌫', 'back', 'fn'), k('(', '(', 'op'), k(')', ')', 'op')],
  [k('7'), k('8'), k('9'), k('÷', '÷', 'op')],
  [k('4'), k('5'), k('6'), k('×', '×', 'op')],
  [k('1'), k('2'), k('3'), k('−', '−', 'op')],
  [k('±', 'neg'), k('0'), k('.'), k('+', '+', 'op')],
  [k('%', '%', 'op'), k('x²', 'square', 'op'), k('1/x', 'inv', 'op'), k('=', '=', 'eq')]
]
const flatKeys = KEYS.flat()

/** 鼠标/键盘两条输入路径都要让对应键闪一下，否则按了有没有生效只能靠数字看 */
const labelOf = (act: string): string => flatKeys.find((key) => key.act === act)?.label ?? act

const exprText = computed(() =>
  st.value.sealed ? `${decorate(st.value.formula)} =` : decorate(st.value.input)
)
const previewText = computed(() => preview(st.value))
const valueText = computed(() => {
  const s = st.value
  if (s.error) return s.error
  if (s.sealed) return decorate(s.result)
  // 还没敲完也有值可看：12+ 时显示 12，跟手算草稿一样
  return decorate(previewText.value || s.result || '0')
})
const valueMuted = computed(() => !st.value.sealed && !st.value.error && !previewText.value)
const copyText = computed(() => (st.value.sealed ? st.value.result : previewText.value))

const TIPS: Record<string, string> = {
  C: '清空（Delete）',
  '⌫': '退格（Backspace）',
  '%': '30% 按百分比算，7%3 按取余算',
  'x²': '平方',
  '1/x': '倒数',
  '±': '正负号'
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  setupInline()
  setupTools()
  setupQuery()
  await load()
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  clearTimeout(flashTimer)
  clearTimeout(toastTimer)
})

// 表达式比屏幕宽时，新敲的字符要看得见：滚到最右，而不是把开头截掉
watch(exprText, async () => {
  await nextTick()
  const el = exprEl.value
  if (el) el.scrollLeft = el.scrollWidth
})

function exit(): void {
  void window.appapi.exit()
}

/**
 * 内联结果：manifest 声明 features:["inline"] 后，面板每敲一次键就把查询推过来。
 * 这里只认「像算式」的输入（含运算符、且只由数字/运算符/括号组成），算得出就回一条，
 * 回车复制；算不出就回空数组，面板不会显示任何东西。
 */
function setupInline(): void {
  window.appapi.onInlineQuery(({ seq, query }) => {
    const raw = query.trim()
    const looksLikeExpression = /[-+*/%^×÷−]/.test(raw) && /^[\d.+\-*/%^()\s×÷−]+$/.test(raw)
    if (!looksLikeExpression) {
      void window.appapi.inline.set({ seq, items: [] })
      return
    }
    try {
      const value = format(evaluate(raw))
      void window.appapi.inline.set({
        seq,
        items: [
          {
            id: `${raw}=${value}`,
            title: decorate(value),
            subtitle: `${raw} =`,
            badge: '=',
            action: { type: 'copy', text: value }
          }
        ]
      })
    } catch {
      // 除零、括号不配对等：这次没有结果，面板照常显示其他内容
      void window.appapi.inline.set({ seq, items: [] })
    }
  })
}

/** 从面板带过来的搜索词：看着像算式就填进屏幕，省得再敲一遍 */
function setupQuery(): void {
  window.appapi.onQuery((payload) => {
    const query = payload?.query?.trim() ?? ''
    if (!query) return
    if (!/^[\d.+\-*/%^()\s×÷−]+$/.test(query) || !/[-+*/%^×÷−]/.test(query)) return
    if (st.value.input || st.value.sealed) return
    st.value = { ...INITIAL, input: query.replace(/\*/g, '×').replace(/\//g, '÷').replace(/-/g, '−') }
  })
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
      return `计算结果：${evaluate(expression)}\n表达式：${expression}`
    } catch (err) {
      // 除零、括号不配对等：把原因交给模型，它会换个写法或直接告诉用户
      return { ok: false, error: `算不出来：${err instanceof Error ? err.message : String(err)}` }
    }
  })
}

function press(act: string, label = labelOf(act)): void {
  // 看着历史还在敲键盘 = 想接着算，先把列表收起来（否则按键作用在看不见的屏幕上）
  if (showHist.value) showHist.value = false
  const next = applyKey(st.value, act)
  st.value = next
  cursor = -1
  if (act === '=' && next.sealed && !next.error) remember(next)
  flashKey(label)
}

function flashKey(label: string): void {
  flash.value = label
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    flash.value = ''
  }, 130)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    // 历史面板自己吃掉 Esc：这时候用户想关的是面板，不是插件
    if (showHist.value) {
      showHist.value = false
      return
    }
    void window.appapi.exit()
    return
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'c') {
    if (window.getSelection()?.toString()) return
    e.preventDefault()
    void copyValue()
    return
  }
  if (e.ctrlKey || e.altKey || e.metaKey) return

  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault()
    recall(e.key === 'ArrowUp' ? 1 : -1)
    return
  }
  if (e.key === 'Backspace') {
    e.preventDefault()
    press('back')
    return
  }
  if (e.key === 'Delete') {
    e.preventDefault()
    press('C')
    return
  }
  if (e.key === 'Enter' || e.key === '=') {
    e.preventDefault()
    press('=')
    return
  }
  const maps: Record<string, string> = { '*': '×', '/': '÷', '-': '−' }
  const act = maps[e.key] ?? e.key
  if (act.length === 1 && '0123456789.+()%^'.includes(act)) {
    e.preventDefault()
    press(act)
  } else if (act === '×' || act === '÷' || act === '−') {
    e.preventDefault()
    press(act)
  }
}

async function copyValue(): Promise<void> {
  if (!copyText.value) return
  try {
    await window.appapi.clipboard.writeText(copyText.value)
    showToast('已复制结果')
  } catch {
    showToast('复制失败')
  }
}

function showToast(text: string): void {
  toast.value = text
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value = ''
  }, 1200)
}

function toggleHist(): void {
  showHist.value = !showHist.value
}

function remember(state: CalcState): void {
  const item: HistItem = { expr: state.formula, result: state.result, at: Date.now() }
  const head = hist.value[0]
  if (head && head.expr === item.expr && head.result === item.result) {
    hist.value = [{ ...head, at: item.at }, ...hist.value.slice(1)]
  } else {
    hist.value = [item, ...hist.value].slice(0, MAX_HIST)
  }
  void save()
}

function reuse(item: HistItem): void {
  st.value = { ...INITIAL, input: item.expr, result: item.result }
  showHist.value = false
}

/** ↑ 往更早翻，↓ 往回收：和终端里翻命令的手感一致 */
function recall(step: number): void {
  if (!hist.value.length) return
  cursor = Math.min(hist.value.length - 1, Math.max(0, cursor + step))
  const item = hist.value[cursor]
  if (item) reuse(item)
  showHist.value = false
}

async function clearHist(): Promise<void> {
  hist.value = []
  cursor = -1
  await save()
  showToast('已清空历史')
}

async function load(): Promise<void> {
  try {
    const saved = await window.appapi.storage.get(STORE_KEY)
    if (!Array.isArray(saved)) return
    hist.value = (saved as HistItem[])
      .filter((item) => typeof item?.expr === 'string' && typeof item?.result === 'string')
      .slice(0, MAX_HIST)
  } catch {
    /* 没权限或首次运行：从空历史开始 */
  }
}

async function save(): Promise<void> {
  try {
    // contextBridge 传参会结构化克隆，Vue Proxy 不能直接传，先转纯数据
    await window.appapi.storage.set(STORE_KEY, JSON.parse(JSON.stringify(hist.value)))
  } catch {
    /* ignore */
  }
}
</script>

<template>
  <div class="pl-page calc">
    <header class="pl-head">
      <button class="pl-btn" @click="exit"><span class="arrow">‹</span> 返回</button>
      <h1 class="pl-title">计算器</h1>
      <button class="pl-btn hist-btn" :class="{ on: showHist }" @click="toggleHist">
        历史
        <span v-if="hist.length" class="hist-count">{{ hist.length }}</span>
      </button>
    </header>

    <div class="stage">
      <!-- 历史是「换一个视图」，不是盖在键盘上的浮层：浮层一半压在键位上，
           既挡住按键又留一条缝，看久了很难受 -->
      <section v-if="showHist" class="hist">
        <div class="hist-head">
          <span class="hist-title">历史记录</span>
          <button class="pl-btn" :disabled="!hist.length" @click="clearHist">清空</button>
          <button class="pl-icon-btn" title="关闭" @click="showHist = false">✕</button>
        </div>
        <div v-if="!hist.length" class="pl-empty">
          还没有计算记录
          <span class="sub">按 = 之后会留在这里</span>
        </div>
        <div v-else class="pl-list hist-list">
          <button v-for="(item, i) in hist" :key="`${item.at}-${i}`" class="pl-row tile" @click="reuse(item)">
            <span class="h-expr">{{ decorate(item.expr) }}</span>
            <span class="h-res">{{ decorate(item.result) }}</span>
          </button>
        </div>
      </section>

      <template v-else>
        <div class="screen">
          <div ref="exprEl" class="expr">{{ exprText }}</div>
          <div
            class="value"
            :class="{ muted: valueMuted, bad: !!st.error, copyable: !!copyText && !st.error }"
            :title="copyText && !st.error ? '点击复制' : ''"
            @click="copyValue"
          >
            {{ valueText }}
          </div>
        </div>

        <div class="keys">
          <button
            v-for="key in flatKeys"
            :key="key.label"
            class="key"
            :class="[key.kind, { hit: flash === key.label }]"
            :title="TIPS[key.label]"
            @click="press(key.act, key.label)"
          >
            {{ key.label }}
          </button>
        </div>

        <p class="pl-tip">Enter 求值 · ⌫ 删除 · ↑ 历史 · Esc 返回</p>
      </template>
    </div>

    <transition name="toast">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </transition>
  </div>
</template>

<style>
/* 颜色/圆角/阴影全部取自 theme.css 的令牌；骨架来自 plugin-ui.css 的 .pl-* */
.calc {
  position: relative;
  padding-bottom: 10px;
}

/*
 * 面板能被拉到整个工作区那么大，键位跟着 1fr 摊开就会变成一片手掌大的按钮。
 * 屏幕与键盘限宽居中：宽屏下是一台正常大小的计算器，窄屏自动铺满。
 * 页头不跟着限宽——返回/历史贴着面板边缘，和其他插件一致。
 */
.stage {
  position: relative;
  flex: 1;
  min-height: 0;
  width: 100%;
  max-width: 520px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  /* 高窗口里把整台计算器放在视觉中间，而不是顶在页头下面留一大片空白 */
  justify-content: center;
}

.screen {
  flex: none;
  margin: 10px 0;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  min-height: 84px;
  border-radius: var(--r-lg);
  background: var(--bg-soft);
  text-align: right;
}

/* 表达式行：只露最近敲的部分，横向滚到尾部 */
.expr {
  min-height: 19px;
  font-size: 13px;
  line-height: 19px;
  color: var(--text-3);
  white-space: nowrap;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  /* 溢出时左侧淡出：直接切一半字符看着像渲染坏了 */
  mask-image: linear-gradient(to right, transparent, #000 18px);
}

.expr::-webkit-scrollbar {
  display: none;
}

.value {
  min-height: 38px;
  font-size: 27px;
  font-weight: 600;
  line-height: 38px;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color var(--dur) var(--ease);
}

/* 灰色的数 = 还没落定的中间值（正在敲、或上一条结果），别让它跟最终结果一样重 */
.value.muted {
  color: var(--text-4);
  font-weight: 500;
}

.value.bad {
  font-size: 13px;
  font-weight: 400;
  line-height: 38px;
  color: var(--danger);
}

.value.copyable {
  cursor: pointer;
}

.value.copyable:hover {
  color: var(--accent-strong);
}

.keys {
  flex: 1;
  min-height: 0;
  /* 高窗口里别把键盘拉成一堵墙，够按就行 */
  max-height: 396px;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  grid-template-rows: repeat(6, minmax(0, 1fr));
  gap: 8px;
}

.key {
  min-height: 0;
  border-radius: var(--r-md);
  background: var(--bg-soft);
  color: var(--text-1);
  font-size: 18px;
  line-height: 1;
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.key:hover {
  background: var(--bg-hover);
}

.key:active,
.key.hit {
  background: var(--bg-active);
}

.key.op {
  font-size: 17px;
  color: var(--accent-strong);
}

.key.fn {
  font-size: 16px;
  color: var(--text-2);
}

.key.eq {
  font-size: 20px;
  color: var(--on-accent);
  background: var(--accent);
}

.key.eq:hover,
.key.eq.hit {
  background: var(--accent-hover);
}

/* 键盘按下的那一下要看得见：键太密，光靠 :active 不够 */
.key:focus-visible {
  box-shadow: var(--ring);
}

/* ---------- 历史 ---------- */

/* 历史视图：占满整块内容区，条目多了在内部滚 */
.hist {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.hist-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
}

.hist-title {
  flex: 1;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
}

.hist-list .pl-row {
  flex: none;
  padding: 7px 10px;
}

.h-expr {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.h-res {
  flex: none;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
}

.hist-btn.on {
  background: var(--bg-active);
  color: var(--text-1);
}

.hist-count {
  min-width: 16px;
  padding: 0 4px;
  border-radius: 8px;
  font-size: 10px;
  line-height: 15px;
  text-align: center;
  color: var(--text-3);
  background: var(--bg-active);
}

/* ---------- 复制提示 ---------- */

.toast {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  z-index: 8;
  padding: 5px 12px;
  border-radius: 999px;
  font-size: 12px;
  color: #fff;
  background: var(--toast-bg);
  pointer-events: none;
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity var(--dur) var(--ease);
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
}
</style>
