/**
 * 一条回答里「过程」与「最终回答」的分界。
 *
 * 放在独立 .ts 里是为了能单测：`.vue` 不参与 tsconfig，也跑不了断言，
 * 而这条规则一旦错了不会崩——只会把过渡句当成答案、或者把结论折叠进"过程"，
 * 只有在真对话里翻历史时才会发现。
 */
import type { AiChatMessage } from '../../../src/shared/ai'

/**
 * 最终回答从哪一段正文开始。
 *
 * 分界是**最后一次工具调用之后的第一段正文**，不是"最后一段正文"：
 * 模型拿到工具结果后经常先说一句过渡（"我再确认一下""已经查到了，整理如下"），
 * 按最后一段切会把这句过渡算进答案、反而把结论前面几段塞进折叠的"过程"里。
 *
 * 工具之后还没出正文时退回最后一段正文——否则答案区会空着，
 * 用户只看到一行"调用 2 个工具"，不知道模型到底说了什么。
 */
export function answerStart(message: AiChatMessage): number {
  let lastTool = -1
  for (let i = message.parts.length - 1; i >= 0; i--) {
    const p = message.parts[i]
    if (p.type === 'tool_call' || p.type === 'tool_result') {
      lastTool = i
      break
    }
  }
  for (let i = lastTool + 1; i < message.parts.length; i++) {
    const p = message.parts[i]
    if (p.type === 'text' && p.text.trim()) return i
  }
  for (let i = message.parts.length - 1; i >= 0; i--) {
    const p = message.parts[i]
    if (p.type === 'text' && p.text.trim()) return i
  }
  return message.parts.length
}
