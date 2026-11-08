/**
 * 键盘状态机：把「按了一个键」变成「屏幕变成什么样」。
 *
 * 单独抽出来的原因有两个：
 * - 这套规则（= 之后按数字要重新开始、运算符替换、自动补右括号、± 只作用于
 *   末尾那个操作数…）全是纯逻辑，放在 .vue 里只能靠点界面验证；
 * - 内联结果与 AI 工具走的是同一个求值器，规则要能一起被单测盯住。
 *
 * 这里不 import vue / 不碰 window：tests/calculator.test.ts 直接调用。
 */
import { evaluate } from './evaluator'

export interface CalcState {
  /** 正在输入的表达式，用屏幕上的字形（× ÷ −） */
  input: string
  /** 最近一次求值成功时的表达式（原样保存，用于回显 `2+3 =`） */
  formula: string
  /** 最近一次求值的结果 */
  result: string
  /** 错误信息，空串表示没有错误 */
  error: string
  /** 上一步是 `=`：屏幕显示 formula 与 result，此时按数字要另起算式 */
  sealed: boolean
}

export const INITIAL: CalcState = {
  input: '',
  formula: '',
  result: '',
  error: '',
  sealed: false
}

const DIGITS = '0123456789'
const OPERATORS = '+−×÷%^'

const isOperator = (ch: string): boolean => OPERATORS.includes(ch)
const isOperandChar = (ch: string): boolean => DIGITS.includes(ch) || ch === '.' || ch === ')' || ch === '%'

/** 当前未闭合的左括号数量 */
export function openParens(input: string): number {
  let depth = 0
  for (const ch of input) {
    if (ch === '(') depth++
    else if (ch === ')' && depth > 0) depth--
  }
  return depth
}

/**
 * 求值前把「没写完的算式」补成能算的：
 * 去掉末尾悬挂的运算符（`12+` → `12`）、补齐缺的右括号（`(1+2` → `(1+2)`）。
 * 这样按 `=` 时不会因为差一个字符就白算一次；真算不出来（比如只剩一个 `−`）返回空串。
 */
export function finalize(input: string): string {
  let text = input.trim()
  // 末尾的 % 不能被当成「没写完的运算符」删掉：`100*30%` 的 % 是百分比后缀，
  // 删了就变成 100*30，差一百倍
  while (text.length > 1 && isOperator(text.slice(-1)) && text.slice(-1) !== '%') {
    text = text.slice(0, -1)
  }
  if (!text) return ''
  const missing = openParens(text)
  if (missing > 0) text += ')'.repeat(missing)
  return text
}

/** 数字转显示文本：超大/超小转科学计数法，并去掉尾随的零（1.234000e+21 → 1.234e+21） */
export function format(value: number): string {
  if (value === 0 || !Number.isFinite(value)) return '0'
  if (Math.abs(value) >= 1e15 || Math.abs(value) < 1e-9) {
    return value.toExponential(6).replace(/\.?0+e/, 'e')
  }
  return String(value)
}

/** 只给显示用：整数部分加千分位（表达式里出现的大数字一眼看不出位数） */
export function decorate(text: string): string {
  return text.replace(/\d+(?:\.\d*)?/g, (num) => {
    const [int, dec] = num.split('.')
    const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    return dec === undefined ? grouped : `${grouped}.${dec}`
  })
}

/**
 * 边敲边算：算出来的值就是按 `=` 会得到的值（同一个 finalize + evaluate），
 * 所以 `12+` 会显示 12，跟手边草稿一样，而不是先跳成 0 再跳回来。
 */
export function preview(state: CalcState): string {
  if (state.sealed || state.error) return ''
  const prepared = finalize(state.input)
  if (!prepared) return ''
  try {
    return format(evaluate(prepared))
  } catch {
    return ''
  }
}

/** @ 之后的状态：接着输入就是在结果上继续算 */
function resume(state: CalcState): CalcState {
  if (!state.sealed) return { ...state, error: '' }
  return { input: state.result, formula: '', result: state.result, error: '', sealed: false }
}

/**
 * `=` 之后按数字 / 小数点 / 左括号 = 另起一题，而不是把数字接在结果后面。
 * 这是计算器最容易被写错的一条：`1+2=` 之后按 7，用户要的是 7，不是 37。
 */
function startFresh(state: CalcState): CalcState {
  if (!state.sealed) return { ...state, error: '' }
  return { input: '', formula: '', result: state.result, error: '', sealed: false }
}

function appendDigit(state: CalcState, digit: string): CalcState {
  const next = startFresh(state)
  let input = next.input
  // `)` 或 `%` 后面直接跟数字，补一个乘号：3(2+1) 写成 3×(2+1)
  if (isOperandChar(input.slice(-1)) && !DIGITS.includes(input.slice(-1)) && input.slice(-1) !== '.') {
    input += '×'
  }
  // 单独一个 0 后面接数字，把 0 吃掉（01 不是数字，1 才是）
  if (/(^|[+−×÷%^(])0$/.test(input)) input = input.slice(0, -1)
  return { ...next, input: input + digit }
}

function appendDot(state: CalcState): CalcState {
  const next = startFresh(state)
  let input = next.input
  if (!input || isOperator(input.slice(-1)) || input.slice(-1) === '(') input += '0'
  const tail = /[\d.]*$/.exec(input)?.[0] ?? ''
  if (tail.includes('.')) return { ...next, input }
  return { ...next, input: input + '.' }
}

function appendOpen(state: CalcState): CalcState {
  const next = startFresh(state)
  let input = next.input
  if (/[0-9.)%]$/.test(input)) input += '×'
  return { ...next, input: input + '(' }
}

function appendClose(state: CalcState): CalcState {
  if (state.sealed) return state
  const input = state.input
  if (openParens(input) === 0) return state
  if (!input || isOperator(input.slice(-1)) || input.slice(-1) === '(') return state
  return { ...state, input: input + ')', error: '' }
}

function appendOperator(state: CalcState, op: string): CalcState {
  const next = resume(state)
  const input = next.input
  if (!input) return op === '−' ? { ...next, input: '−' } : next
  const last = input.slice(-1)
  if (isOperator(last)) {
    // 5×−3：乘除后面允许跟一元负号，其余情况视为「按错运算符」，替换掉
    if (op === '−' && '×÷'.includes(last)) return { ...next, input: input + '−' }
    return { ...next, input: input.slice(0, -1) + op }
  }
  if (last === '(') return op === '−' ? { ...next, input: input + '−' } : next
  return { ...next, input: input + op }
}

/** 末尾操作数：一串数字，或一对配平的括号 */
function trailingOperand(input: string): { start: number; end: number } | null {
  const end = input.length
  if (!end) return null
  if (input[end - 1] === ')') {
    let depth = 0
    for (let i = end - 1; i >= 0; i--) {
      if (input[i] === ')') depth++
      else if (input[i] === '(') {
        depth--
        if (depth === 0) return { start: i, end }
      }
    }
    return null
  }
  if (!/[0-9.]/.test(input[end - 1])) return null
  let i = end - 1
  while (i >= 0 && /[0-9.]/.test(input[i])) i--
  return { start: i + 1, end }
}

/**
 * ± ：只翻转末尾那个操作数的正负。
 * 已经是否定形式就翻回来——所以按两次等于没按，这是用户对 ± 的基本预期。
 */
function negate(state: CalcState): CalcState {
  const next = resume(state)
  const input = next.input
  if (!input) return { ...next, input: '−' }
  const span = trailingOperand(input)
  if (!span) return { ...next, input: input + '−' }
  const { start } = span
  // `5+−3` → `5+3`
  if (input[start - 1] === '−' && (start - 1 === 0 || isOperator(input[start - 2]) || input[start - 2] === '(')) {
    return { ...next, input: input.slice(0, start - 1) + input.slice(start) }
  }
  // `5+(−3)` → `5+(3)`，但只在括号里只有一个数时成立；(1+2) 这种整组要保留负号
  const inner = input.slice(start + 1, input.length - 1)
  if (input[start] === '(' && input[start + 1] === '−' && !/[+−×÷%^]/.test(inner.slice(1))) {
    return { ...next, input: input.slice(0, start + 1) + input.slice(start + 2) }
  }
  if (start === 0) return { ...next, input: '−' + input }
  // 数字包成 (−n)，比 5+−3 好读，再按一次还能翻回来
  if (input[start] !== '(') return { ...next, input: input.slice(0, start) + '(−' + input.slice(start) + ')' }
  return { ...next, input: input.slice(0, start) + '−' + input.slice(start) }
}

function square(state: CalcState): CalcState {
  const next = resume(state)
  const input = next.input
  if (!input) return next
  if (!/[0-9.)]$/.test(input)) return next
  // 负结果平方要加括号：−3^2 是 −9，(−3)^2 才是 9
  if (/^−/.test(input)) return { ...next, input: `(${input})^2` }
  return { ...next, input: `${input}^2` }
}

function reciprocal(state: CalcState): CalcState {
  const next = resume(state)
  const input = next.input
  if (!input) return { ...next, input: '1÷' }
  return { ...next, input: `1÷(${input})` }
}

function commit(state: CalcState): CalcState {
  const raw = (state.sealed ? state.formula : state.input).trim()
  if (!raw) return state
  const prepared = finalize(raw)
  if (!prepared) return { ...state, sealed: false, error: '表达式不完整' }
  try {
    const value = evaluate(prepared)
    return { input: '', formula: raw, result: format(value), error: '', sealed: true }
  } catch (err) {
    // 出错时保留原表达式：用户按一下就能改，不用从头再敲一遍
    return { ...state, sealed: false, result: '', error: err instanceof Error ? err.message : '表达式错误' }
  }
}

/**
 * 别名：按钮上的字形、键盘上敲的符号、动作名，三套写法在这里收敛成一套。
 * 少一层转换就少一处「某个入口传进来的符号没被认出来」。
 */
const ALIAS: Record<string, string> = {
  '⌫': 'back',
  '±': 'neg',
  'x²': 'square',
  '1/x': 'inv',
  '*': '×',
  '/': '÷',
  '-': '−'
}

/** 把一次按键应用到状态上；不认识的键原样返回 */
export function applyKey(state: CalcState, rawKey: string): CalcState {
  const key = ALIAS[rawKey] ?? rawKey
  switch (key) {
    case 'C':
      return { ...INITIAL }
    case 'back':
      if (state.sealed) {
        // 结果也能删改：删完接着编辑，相当于「在结果上动手」
        const input = state.result.slice(0, -1)
        return { input, formula: '', result: '', error: '', sealed: false }
      }
      return { ...state, input: state.input.slice(0, -1), error: '' }
    case '=':
      return commit(state)
    case 'neg':
      return negate(state)
    case 'square':
      return square(state)
    case 'inv':
      return reciprocal(state)
    default:
      break
  }
  if (key.length === 1 && DIGITS.includes(key)) return appendDigit(state, key)
  if (key === '.') return appendDot(state)
  if (key === '(') return appendOpen(state)
  if (key === ')') return appendClose(state)
  if (key.length === 1 && isOperator(key)) return appendOperator(state, key)
  return state
}

/**
 * 依次应用一串按键，返回最终状态。
 * 字符串按字符拆分（`run('1+2=')`），数组原样（`run(['3', 'neg', 'square'])`）。
 */
export function run(sequence: string | string[], from: CalcState = INITIAL): CalcState {
  const queue = typeof sequence === 'string' ? [...sequence] : sequence
  return queue.reduce(applyKey, from)
}
