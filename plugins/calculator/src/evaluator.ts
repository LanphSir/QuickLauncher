// 四则表达式求值：递归下降解析，不支持 eval
// 文法: expr := term (('+'|'-') term)* ; term := factor (('*'|'/'|'%') factor)* ; factor := number | '(' expr ')' | '-' factor

type Token = number | string

export function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (/[0-9.]/.test(ch)) {
      let num = ''
      while (i < input.length && /[0-9.]/.test(input[i])) num += input[i++]
      const value = Number(num)
      if (!Number.isFinite(value)) throw new Error('数字格式错误')
      tokens.push(value)
      continue
    }
    if ('+-*/%()'.includes(ch)) {
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
    let value = parseFactor()
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = next() as string
      const rhs = parseFactor()
      if ((op === '/' || op === '%') && rhs === 0) throw new Error('除数不能为零')
      value = op === '*' ? value * rhs : op === '/' ? value / rhs : value % rhs
    }
    return value
  }

  function parseFactor(): number {
    const token = next()
    if (typeof token === 'number') return token
    if (token === '(') {
      const value = parseExpr()
      if (next() !== ')') throw new Error('括号不匹配')
      return value
    }
    if (token === '-') return -parseFactor()
    throw new Error('表达式不完整')
  }

  const result = parseExpr()
  if (pos !== tokens.length) throw new Error('表达式不完整')
  if (!Number.isFinite(result)) throw new Error('结果无效')
  // 浮点误差修正：最多保留 12 位有效数字
  return Number(result.toPrecision(12))
}
