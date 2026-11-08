// 表达式求值：递归下降解析，不用 eval
//
// 文法（每层的顺序就是优先级，越靠下越紧）：
//   expr   := term (('+'|'-') term)*
//   term   := unary (('*'|'/'|'%') unary | '%'后置)*
//   unary  := '-' unary | power
//   power  := atom ('^' unary)?          右结合，且 2^-1 合法
//   atom   := number | '(' expr ')'
//
// `%` 有两种读法，靠「后面还有没有操作数」区分，不需要用户加括号：
//   - `7 % 3`（后面是数字或 `(`）→ 取余
//   - `30%`、`100*30%`（后面没了，或是运算符/右括号）→ 百分比，即 /100
// 两者混在一套文法里是刻意的：计算器上按 `%` 的人十有八九想打八折，
// 但 AI 调这个工具时写 `7 % 3` 也是自然写法，让它直接报错反而更糟。

type Token = number | string

/** 数字：整数 / 小数 / 科学计数法（结果回填后可能带 e，得能再算一次） */
const NUMBER_RE = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/

/**
 * 把界面上的写法归一成可解析的写法。
 * `×` `÷` `−` 是键盘和屏幕上的字形，星号、斜杠、减号才是文法里的符号；两者必须只在这一处转换，
 * 否则内联结果、AI 工具、键盘输入三条路各自转一遍，早晚有一条漏掉。
 */
export function normalize(input: string): string {
  return input.replace(/[×✕]/g, '*').replace(/÷/g, '/').replace(/[−–—]/g, '-')
}

export function tokenize(input: string): Token[] {
  const src = normalize(input)
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (/[0-9.]/.test(ch)) {
      const matched = NUMBER_RE.exec(src.slice(i))
      if (!matched) throw new Error('数字格式错误')
      i += matched[0].length
      // `1.2.3`：正则只吃下 1.2，剩下的小数点必须当场拒掉，否则会算成 1.2 和 0.3
      if (src[i] === '.') throw new Error('数字格式错误')
      const value = Number(matched[0])
      if (!Number.isFinite(value)) throw new Error('数字格式错误')
      tokens.push(value)
      continue
    }
    if ('+-*/%^()'.includes(ch)) {
      tokens.push(ch)
      i++
      continue
    }
    throw new Error(`无法识别的字符: ${ch}`)
  }
  return tokens
}

export function evaluate(expression: string): number {
  const tokens = tokenize(expression)
  let pos = 0

  const peek = (): Token | undefined => tokens[pos]
  const next = (): Token | undefined => tokens[pos++]

  function parseExpr(): number {
    let value = parseTerm()
    while (peek() === '+' || peek() === '-') {
      const op = next() as string
      const rhs = parseTerm()
      value = op === '+' ? value + rhs : value - rhs
    }
    return value
  }

  function parseTerm(): number {
    let value = parseUnary()
    for (;;) {
      const op = peek()
      if (op === '*' || op === '/') {
        next()
        const rhs = parseUnary()
        if (op === '/' && rhs === 0) throw new Error('除数不能为零')
        value = op === '*' ? value * rhs : value / rhs
        continue
      }
      if (op === '%') {
        // 后面还跟着操作数才算取余，否则是百分比后缀
        const after = tokens[pos + 1]
        const binary = typeof after === 'number' || after === '('
        next()
        if (binary) {
          const rhs = parseUnary()
          if (rhs === 0) throw new Error('取余的除数不能为零')
          value %= rhs
        } else {
          value /= 100
        }
        continue
      }
      break
    }
    return value
  }

  function parseUnary(): number {
    if (peek() === '-') {
      next()
      return -parseUnary()
    }
    return parsePower()
  }

  function parsePower(): number {
    const base = parseAtom()
    if (peek() !== '^') return base
    next()
    // 指数这一侧走 unary：既能右结合（2^3^2 = 2^9），也能接负号（2^-1）
    const exponent = parseUnary()
    const powered = Math.pow(base, exponent)
    if (!Number.isFinite(powered)) throw new Error('结果超出可表示范围')
    return powered
  }

  function parseAtom(): number {
    const token = next()
    if (typeof token === 'number') return token
    if (token === '(') {
      const value = parseExpr()
      if (next() !== ')') throw new Error('括号不匹配')
      return value
    }
    throw new Error('表达式不完整')
  }

  const result = parseExpr()
  if (pos !== tokens.length) throw new Error('表达式不完整')
  if (!Number.isFinite(result)) throw new Error('结果无效')
  // 浮点误差修正：0.1+0.2 这类结果保留 12 位有效数字就够了，再多只是把误差显出来
  return Number(result.toPrecision(12))
}
