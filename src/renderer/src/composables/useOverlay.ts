import { markRaw, nextTick, shallowReadonly, shallowReactive, type Component } from 'vue'

/**
 * 面板内的浮层栈。
 *
 * 以前每个浮层各写一套：详情 z-index 70、编辑 80、右键菜单 60，
 * 遮罩色/Esc/点击关闭/焦点管理全都不一样，"详情→编辑"切换时还有一帧焦点掉到 body。
 * 现在统一由 OverlayHost 渲染，这里只管栈。
 *
 * 另一件必须由这里做的事：**打开期间登记面板可见性**。
 * 面板是"失焦即隐藏"，鼠标从弹窗移出去（哪怕是去点输入法候选窗）就会把面板连弹窗一起收掉——
 * 这正是"在弹窗里操作，移出去一下就没了"的根因。
 */

/** dim=半透明遮罩（模态框）；transparent=透明点击层（右键菜单）；none=完全不拦点击 */
export type OverlayBackdrop = 'dim' | 'transparent' | 'none'

export interface OverlayOptions {
  component: Component
  props?: Record<string, unknown>
  backdrop?: OverlayBackdrop
  /** 点遮罩 / 按 Esc 是否关闭（默认 true）。不可关闭的浮层只能由内容自己 emit */
  dismissible?: boolean
  /** 打开后是否把焦点移进浮层（默认 true）。右键菜单这类"点了就走"的应当关掉 */
  autoFocus?: boolean
  /**
   * 焦点落到哪：`container`（默认，落在浮层容器上，不显示焦点环）/
   * `first`（落在第一个可聚焦元素，适合"打开就要输入"的表单）
   */
  initialFocus?: 'container' | 'first'
  /** 调试标签，只出现在 DOM 的 data-overlay 上 */
  label?: string
  /** 关闭后的回调（无论怎么关的都会调用） */
  onClose?: () => void
}

export interface OverlayEntry {
  id: number
  /** 主进程那边登记可见性用的 token */
  token: string
  component: Component
  props: Record<string, unknown>
  backdrop: OverlayBackdrop
  dismissible: boolean
  autoFocus: boolean
  initialFocus: 'container' | 'first'
  label: string
  onClose?: () => void
  /** 打开前的焦点元素：关闭后还回去，键盘用户不会掉到 body */
  previousFocus: HTMLElement | null
}

const stack = shallowReactive<OverlayEntry[]>([])
export const overlayStack = shallowReadonly(stack)

/** 可聚焦元素的选择器：宿主做 Tab 循环、开层时找首个焦点都用它 */
export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * 把焦点移进指定的浮层。
 *
 * 不能靠"监听栈长度变化"来触发：点击菜单里的"应用详情"是同一 tick 内 pop 菜单 + push 详情，
 * 长度回到原值，watch 拿到的新旧值相等，回调根本不会跑（第一版就是这么坏的，
 * 表现是弹窗打开后焦点还留在搜索框，Tab 会跑到遮罩下面的应用磁贴上）。
 */
function focusEntry(entry: OverlayEntry): void {
  const layer = document.querySelector<HTMLElement>(`[data-overlay-id="${entry.id}"]`)
  if (!layer) return
  if (entry.initialFocus === 'first') {
    // 表单场景要的是"能直接打字"，所以输入框优先于排在前面的关闭按钮
    const first =
      layer.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled])') ??
      layer.querySelector<HTMLElement>(FOCUSABLE)
    if (first) {
      first.focus()
      return
    }
  }
  // 容器自己（tabindex=-1）：不画焦点环，但键盘 Tab 会从这里进入层内第一个可聚焦元素
  layer.focus()
}

let seq = 0

function activeFocus(): HTMLElement | null {
  const el = document.activeElement
  return el instanceof HTMLElement ? el : null
}

function layerEl(id: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-overlay-id="${id}"]`)
}

/**
 * 新浮层的"焦点还原目标"。
 *
 * 直接取 activeElement 是不够的：右键菜单 →「应用详情」时，焦点还在菜单项上，
 * 而菜单马上就要被移除——详情关掉后 focus() 落到一个已经不在 DOM 里的按钮上，
 * 结果就是焦点掉到 body（键盘用户得从头 Tab 一遍）。
 * 这里向上追溯：焦点在哪一层里，就用那一层记录的还原目标。
 */
function resolvePreviousFocus(): HTMLElement | null {
  let el = activeFocus()
  // 最多追 4 层，足够覆盖「菜单 → 详情 → 编辑」；再深就是病态用法，兜底回原值
  for (let i = 0; i < 4 && el; i++) {
    const target = el
    const owner = stack.find((entry) => layerEl(entry.id)?.contains(target) ?? false)
    if (!owner || !owner.previousFocus || owner.previousFocus === el) break
    el = owner.previousFocus
  }
  return el
}

/**
 * 打开一个浮层，返回 id（一般不用管，关闭时传 undefined 就是关栈顶）。
 * 组件通过 props 拿回调，比如 `{ plugin, onClose: () => closeOverlay() }`。
 */
export function openOverlay(options: OverlayOptions): number {
  const id = ++seq
  const token = `overlay-${id}`
  const entry: OverlayEntry = {
    id,
    token,
    // 组件定义不能进响应式代理，否则 Vue 会警告"把组件变成了 reactive object"
    component: markRaw(options.component),
    props: options.props ?? {},
    backdrop: options.backdrop ?? 'dim',
    dismissible: options.dismissible ?? true,
    autoFocus: options.autoFocus ?? true,
    initialFocus: options.initialFocus ?? 'container',
    label: options.label ?? '',
    onClose: options.onClose,
    previousFocus: resolvePreviousFocus()
  }
  stack.push(entry)
  // 登记期间面板失焦不收起
  void window.panel.holdVisible(token)
  // 等 DOM 补丁完（Teleport 把内容挂到 body 之后）再聚焦
  if (entry.autoFocus) void nextTick(() => focusEntry(entry))
  return id
}

export function closeOverlay(id?: number): void {
  const index = id === undefined ? stack.length - 1 : stack.findIndex((e) => e.id === id)
  if (index < 0) return
  const [entry] = stack.splice(index, 1)
  void window.panel.releaseVisible(entry.token)
  // 焦点还原与回调都推到本轮渲染之后：浮层 DOM 还在时抢焦点会失败
  queueMicrotask(() => {
    // 只在栈空了才还原焦点——"详情→编辑"这种接力切换交给新浮层自己聚焦
    if (!stack.length) entry.previousFocus?.focus?.()
    entry.onClose?.()
  })
}

export function closeAllOverlays(): void {
  while (stack.length) closeOverlay()
}

/** 栈顶条目（Esc / Tab 只对栈顶生效，下层浮层不该抢键盘） */
export function topOverlay(): OverlayEntry | undefined {
  return stack[stack.length - 1]
}
