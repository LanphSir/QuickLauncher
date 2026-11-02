/**
 * 把流式 tool_calls 碎片拼成完整调用（v0.6.3）。
 *
 * 端点发过来的形状是「一帧一个碎片」：第一帧给 id 和函数名，后面每帧只带
 * arguments 的一小段字符串。拼的时候有三件事容易做错：
 *
 * 1. **按 index 归并，不能按到达顺序追加**。模型一次要求并行调用两个工具时，
 *    两路碎片是交错来的；按顺序拼会把 A 的参数接到 B 上。
 * 2. **id 只在第一帧出现**，后续帧为空——不能拿「这一帧没有 id」当作新调用。
 * 3. **参数是字符串碎片**，必须原样拼完再解析 JSON；边拼边解析一定失败。
 */
import type { ToolCallDelta } from './chunk'

/** 模型发起的一次调用（碎片已拼好，参数还没解析） */
export interface RawToolCall {
  id: string
  apiName: string
  /** 参数原文（JSON 字符串），可能是空串或不合法 */
  argsText: string
}

interface Accum {
  id: string
  name: string
  args: string
}

export class ToolCallCollector {
  private readonly slots = new Map<number, Accum>()

  push(delta: ToolCallDelta): void {
    let slot = this.slots.get(delta.index)
    if (!slot) {
      slot = { id: '', name: '', args: '' }
      this.slots.set(delta.index, slot)
    }
    if (delta.id && !slot.id) slot.id = delta.id
    if (delta.name && !slot.name) slot.name = delta.name
    if (delta.args) slot.args += delta.args
  }

  get size(): number {
    return this.slots.size
  }

  /**
   * 取出拼好的调用（按 index 排序，保持模型要求的顺序）。
   * 没有函数名的槽位直接丢掉：那种帧通常是网关的占位，执行它只会得到一句
   * 「未知工具」，反而干扰模型。
   */
  take(): RawToolCall[] {
    return [...this.slots.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, slot], order) => ({
        id: slot.id || `call_${index}_${order}`,
        apiName: slot.name,
        argsText: slot.args
      }))
      .filter((call) => Boolean(call.apiName))
  }
}
