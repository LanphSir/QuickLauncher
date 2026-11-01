/**
 * 通道入参校验：插件是外部输入，网关在进业务前先把 payload 归一化。
 *
 * 为什么不引 zod：项目规范不允许为这点事加运行时依赖，且这里只需要 5 个组合子；
 * 每个校验器都返回强类型，配合 defineApi 让"实现收到的 payload"自动带上契约类型。
 */

export function fail(message: string): never {
  throw new Error(`参数非法: ${message}`)
}

export type Parser<T> = (input: unknown) => T

export function str(label: string, opts: { max?: number; min?: number; pattern?: RegExp } = {}): Parser<string> {
  const { max = 4096, min = 1, pattern } = opts
  return (input) => {
    if (typeof input !== 'string') fail(`${label} 必须是字符串`)
    if (input.length < min) fail(`${label} 不能为空`)
    if (input.length > max) fail(`${label} 过长（上限 ${max} 字符）`)
    if (pattern && !pattern.test(input)) fail(`${label} 含非法字符`)
    return input
  }
}

export function optional<T>(parser: Parser<T>): Parser<T | undefined> {
  return (input) => (input === undefined || input === null ? undefined : parser(input))
}

/** 仅 http(s)：shell.openExternal 只允许外链，避免被当成命令/本地协议打开 */
export function httpUrl(label = 'url'): Parser<string> {
  const base = str(label, { max: 2048 })
  return (input) => {
    const value = base(input)
    if (!/^https?:\/\//i.test(value)) fail('仅允许 http(s) 链接')
    return value
  }
}

/**
 * 可 JSON 序列化的值 + 体积上限。
 * 主进程是同步写盘的，放任插件塞几十 MB 的 store 会直接卡住整个 UI。
 */
export function jsonValue(label: string, maxBytes: number): Parser<unknown> {
  return (input) => {
    let serialized: string | undefined
    try {
      serialized = JSON.stringify(input)
    } catch {
      fail(`${label} 无法序列化（不能含函数/循环引用）`)
    }
    if (serialized === undefined) fail(`${label} 无法序列化`)
    if (Buffer.byteLength(serialized, 'utf-8') > maxBytes) {
      fail(`${label} 过大（上限 ${Math.round(maxBytes / 1024)}KB）`)
    }
    return input
  }
}

/** 对象按白名单取字段：插件多传的键一律丢弃，不会漏进业务层 */
export function object<S extends Record<string, Parser<unknown>>>(
  shape: S
): Parser<{ [K in keyof S]: ReturnType<S[K]> }> {
  return (input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('参数必须是对象')
    const src = input as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, parse] of Object.entries(shape)) out[key] = parse(src[key])
    return out as { [K in keyof S]: ReturnType<S[K]> }
  }
}

/** 整数（带上下限）：超时、条数这类数值参数用它，字符串数字一律拒绝 */
export function int(label: string, opts: { min?: number; max?: number } = {}): Parser<number> {
  const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = opts
  return (input) => {
    if (typeof input !== 'number' || !Number.isFinite(input) || !Number.isInteger(input)) {
      fail(`${label} 必须是整数`)
    }
    if (input < min || input > max) fail(`${label} 超出范围（${min}~${max}）`)
    return input
  }
}

/** 枚举值（返回字面量联合）：`oneOf('method', ['GET','POST'], { upper: true })` */
export function oneOf<T extends string>(
  label: string,
  values: readonly T[],
  opts: { upper?: boolean } = {}
): Parser<T> {
  const allowed = new Set<string>(values)
  return (input) => {
    if (typeof input !== 'string') fail(`${label} 必须是字符串`)
    const value = opts.upper ? input.toUpperCase() : input
    if (!allowed.has(value)) fail(`${label} 必须是 ${values.join(' / ')} 之一`)
    return value as T
  }
}

/**
 * 字符串字典（如 HTTP 头）：键与值都必须是字符串，限条数与长度。
 * 用 Map 语义而非普通对象，避免 __proto__ 之类的键污染原型。
 */
export function stringRecord(
  label: string,
  opts: { maxKeys?: number; keyMax?: number; valueMax?: number; keyPattern?: RegExp } = {}
): Parser<Record<string, string>> {
  const { maxKeys = 32, keyMax = 64, valueMax = 4096, keyPattern = /^[\w!#$%&'*+.^`|~-]+$/ } = opts
  return (input) => {
    if (input === undefined || input === null) return {}
    if (typeof input !== 'object' || Array.isArray(input)) fail(`${label} 必须是对象`)
    const src = input as Record<string, unknown>
    const entries = Object.entries(src)
    if (entries.length > maxKeys) fail(`${label} 条目过多（上限 ${maxKeys}）`)
    const out: Record<string, string> = {}
    for (const [key, value] of entries) {
      if (key.length > keyMax) fail(`${label} 键过长: ${key.slice(0, 16)}…`)
      if (!keyPattern.test(key)) fail(`${label} 键含非法字符: ${key}`)
      if (typeof value !== 'string') fail(`${label}.${key} 必须是字符串`)
      if (value.length > valueMax) fail(`${label}.${key} 过长（上限 ${valueMax} 字符）`)
      out[key] = value
    }
    return out
  }
}
