import { describe, expect, it } from 'vitest'
import { evaluate, normalize, tokenize } from '../plugins/calculator/src/evaluator'
import {
  applyKey,
  decorate,
  finalize,
  format,
  INITIAL,
  openParens,
  preview,
  run,
  type CalcState
} from '../plugins/calculator/src/keypad'

/** 把一串按键走完，返回屏幕上的最终状态 */
const keys = (seq: string): CalcState => run(seq)

describe('evaluator：四则与优先级', () => {
  it('先乘除后加减', () => {
    expect(evaluate('1+2*3')).toBe(7)
    expect(evaluate('(1+2)*3')).toBe(9)
    expect(evaluate('10-2-3')).toBe(5)
    expect(evaluate('2*3+4*5')).toBe(26)
  })

  it('括号可以嵌套，一元负号跟着走', () => {
    expect(evaluate('((1+2)*(3+4))')).toBe(21)
    expect(evaluate('-3+2')).toBe(-1)
    expect(evaluate('-(2+3)')).toBe(-5)
    expect(evaluate('2*-3')).toBe(-6)
  })

  it('屏幕上的 ×÷− 与键盘上的 */- 等价（只在这一处归一）', () => {
    expect(normalize('8×2÷4−1')).toBe('8*2/4-1')
    expect(evaluate('8×2÷4−1')).toBe(3)
    expect(evaluate('8*2/4-1')).toBe(3)
  })

  it('浮点误差被收掉：0.1+0.2 就是 0.3', () => {
    expect(evaluate('0.1+0.2')).toBe(0.3)
    expect(evaluate('1.1*3')).toBe(3.3)
  })

  it('结果回填后还能继续算（科学计数法能再进解析器）', () => {
    expect(tokenize('1.23e+21')).toEqual([1.23e21])
    expect(evaluate('1e3+1')).toBe(1001)
    expect(evaluate('-1.5e-3')).toBe(-0.0015)
  })

  it('乘方：右结合，且指数可以是负数', () => {
    expect(evaluate('2^10')).toBe(1024)
    expect(evaluate('2^3^2')).toBe(512)
    expect(evaluate('2^-1')).toBe(0.5)
    // 一元负号比乘方松：-2^2 是 -(2^2)
    expect(evaluate('-2^2')).toBe(-4)
    expect(evaluate('(-2)^2')).toBe(4)
  })

  it('百分号两种读法：后面还有操作数算取余，否则算百分比', () => {
    expect(evaluate('7%3')).toBe(1)
    expect(evaluate('30%')).toBe(0.3)
    expect(evaluate('100*30%')).toBe(30)
    expect(evaluate('100+8%')).toBe(100.08)
    expect(evaluate('(50%)*2')).toBe(1)
  })
})

describe('evaluator：报错要说人话', () => {
  const reasons = ['1/0', '1%0', '1+', '(1+2', '1+2)', 'abc', '1..2', '2^99999', '']
  it('常见错误都有明确原因而不是 NaN', () => {
    for (const expr of reasons) {
      expect(() => evaluate(expr), expr).toThrow()
    }
    expect(() => evaluate('1/0')).toThrow('除数不能为零')
    expect(() => evaluate('(1+2')).toThrow('括号不匹配')
    expect(() => evaluate('1..2')).toThrow('数字格式错误')
  })
})

describe('格式化', () => {
  it('大数小数量转科学计数法，并去掉多余的零', () => {
    expect(format(0.3)).toBe('0.3')
    expect(format(1e21)).toBe('1e+21')
    expect(format(1.234e21)).toBe('1.234e+21')
    expect(format(1e-12)).toBe('1e-12')
    expect(format(-0)).toBe('0')
  })

  it('显示用千分位，但不改表达式本身', () => {
    expect(decorate('1234567')).toBe('1,234,567')
    expect(decorate('1234.5678')).toBe('1,234.5678')
    expect(decorate('12+(3456×7)')).toBe('12+(3,456×7)')
    expect(decorate('1.234e+21')).toBe('1.234e+21')
    expect(decorate('123')).toBe('123')
  })
})

describe('keypad：= 之后的行为', () => {
  it('= 之后按数字是重新开始，按运算符是接着结果算', () => {
    const done = keys('1+2=')
    expect(done.sealed).toBe(true)
    expect(done.formula).toBe('1+2')
    expect(done.result).toBe('3')

    expect(applyKey(done, '7').input).toBe('7')
    expect(applyKey(done, '×').input).toBe('3×')
  })

  it('= 之后按退格是改结果，而不是把结果整条扔掉', () => {
    const next = applyKey(keys('10+5='), 'back')
    expect(next.input).toBe('1')
    expect(next.sealed).toBe(false)
  })

  it('连按两次 = 结果不变', () => {
    const first = keys('6×7=')
    expect(applyKey(first, '=').result).toBe('42')
  })
})

describe('keypad：输入修正', () => {
  it('连续的运算符按替换处理，不是拼在后面', () => {
    expect(keys('5+×').input).toBe('5×')
    expect(keys('5×÷').input).toBe('5÷')
  })

  it('乘除后面允许一元负号，加减后面则视为替换', () => {
    expect(keys('5×−').input).toBe('5×−')
    expect(keys('5+−').input).toBe('5−')
  })

  it('开头的运算符只有负号能进，其余忽略', () => {
    expect(keys('+').input).toBe('')
    expect(keys('−').input).toBe('−')
  })

  it('右括号只有在配得上的时候才能敲', () => {
    expect(keys(')').input).toBe('')
    expect(keys('(1+2)').input).toBe('(1+2)')
    expect(keys('(1+2))').input).toBe('(1+2)')
  })

  it('括号与数字相邻时自动补乘号', () => {
    expect(keys('3(2)').input).toBe('3×(2)')
    expect(keys('(1+2)3').input).toBe('(1+2)×3')
  })

  it('一个小数里只有一个点，且开头补 0', () => {
    expect(keys('.5').input).toBe('0.5')
    expect(keys('1.2.3').input).toBe('1.23')
    expect(keys('5+.5').input).toBe('5+0.5')
  })

  it('前导 0 被吃掉，但 0.5 不受影响', () => {
    expect(keys('05').input).toBe('5')
    expect(keys('0.5').input).toBe('0.5')
    expect(keys('10').input).toBe('10')
    expect(keys('5+0').input).toBe('5+0')
  })
})

describe('keypad：±、平方、倒数', () => {
  it('± 翻转末尾操作数，按两次等于没按', () => {
    expect(keys('5±').input).toBe('−5')
    expect(keys('5±±').input).toBe('5')
    expect(keys('5+3±').input).toBe('5+(−3)')
    expect(keys('5+3±±').input).toBe('5+(3)')
  })

  it('± 在空表达式里起一个负号，在运算符后面接着写', () => {
    expect(keys('±').input).toBe('−')
    expect(keys('5+±').input).toBe('5+−')
  })

  it('平方与倒数', () => {
    expect(run(['1', '+', '2', 'square']).input).toBe('1+2^2')
    expect(evaluate(run(['1', '+', '2', 'square']).input)).toBe(5)
    // 负结果平方必须带括号，否则等于 -(3^2)
    expect(run(['3', '±', 'square']).input).toBe('(−3)^2')
    expect(evaluate(run(['3', '±', 'square']).input)).toBe(9)
    expect(run(['4', 'inv']).input).toBe('1÷(4)')
    expect(evaluate(run(['4', 'inv']).input)).toBe(0.25)
  })
})

describe('keypad：没写完的算式也能按 =', () => {
  it('尾部悬挂的运算符被忽略', () => {
    expect(finalize('12+')).toBe('12')
    expect(finalize('12+3×')).toBe('12+3')
    expect(keys('12+=').result).toBe('12')
  })

  it('缺的右括号自动补齐', () => {
    expect(finalize('(1+2')).toBe('(1+2)')
    expect(openParens('(1+2')).toBe(1)
    expect(keys('(1+2=').result).toBe('3')
  })

  it('结尾的百分号是后缀，不能被当成没写完的运算符删掉', () => {
    expect(finalize('100×30%')).toBe('100×30%')
    expect(preview(keys('100×30%'))).toBe('30')
    expect(keys('100×30%=').result).toBe('30')
  })

  it('只剩一个负号时按 = 报错，且原表达式留在屏幕上', () => {
    const next = keys('−=')
    expect(next.error).toBeTruthy()
    expect(next.input).toBe('−')
  })

  it('出错之后接着敲会清掉错误提示', () => {
    const bad = keys('1/0=')
    expect(bad.error).toBe('除数不能为零')
    expect(applyKey(bad, '5').error).toBe('')
  })
})

describe('keypad：预览', () => {
  it('预览值等于按 = 会得到的值', () => {
    const typing = keys('12+3×4')
    expect(preview(typing)).toBe('24')
    expect(applyKey(typing, '=').result).toBe('24')
  })

  it('刚按完运算符时显示的是已经算出来的部分', () => {
    expect(preview(keys('12+'))).toBe('12')
  })

  it('已经按过 = 之后不再显示预览（屏幕上是大结果）', () => {
    expect(preview(keys('1+2='))).toBe('')
  })
})

describe('keypad：历史回填的状态', () => {
  it('回填一个表达式后可以接着编辑', () => {
    const recalled: CalcState = { ...INITIAL, input: '12+3', result: '15' }
    expect(preview(recalled)).toBe('15')
    expect(applyKey(recalled, '×').input).toBe('12+3×')
  })

  it('C 清空一切', () => {
    expect(keys('1+2=C')).toEqual(INITIAL)
  })
})
