/**
 * AI 能力的线上契约：主进程、AI 插件页、设置页共用同一份定义。
 *
 * 与 shared/pluginApi.ts 的分工：
 * - pluginApi 定义「通道怎么走」（通道名、权限、入参/返回值类型）；
 * - 本文件定义「AI 数据长什么样」（消息、会话、模型、流式事件）。
 *
 * 本文件必须保持"纯数据与类型"：不 import electron / node，插件页能安全引用。
 */

/** 消息角色。system 只由主进程拼（用户看不到它，也不占会话消息） */
export type AiRole = 'user' | 'assistant' | 'system'

/** 正文；推理型模型（deepseek-reasoner 等）的思维链走 reasoning 另存 */
export interface AiTextPart {
  type: 'text'
  text: string
}

export interface AiReasoningPart {
  type: 'reasoning'
  text: string
}

export type AiMessagePart = AiTextPart | AiReasoningPart

export interface AiChatMessage {
  id: string
  role: AiRole
  /** 顺序即展示顺序；reasoning 不参与请求，只用于回看 */
  parts: AiMessagePart[]
  createdAt: number
  /** 生成这条回答用的模型（`providerId/model`），便于事后分辨 */
  model?: string
  /** 用户中途停止：内容保留、界面显示「已停止」，不是失败 */
  stopped?: boolean
  /** 请求失败的原因（有它时界面显示重试，而不是当成空回答） */
  error?: string
}

export interface AiSessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  /** 上次使用的模型；会话内可随时切换 */
  model?: string
}

export interface AiSessionDetail extends AiSessionMeta {
  messages: AiChatMessage[]
}

/** 模型条目：id 是 "providerId/model"，全程用它定位，避免模型重名 */
export interface AiModelOption {
  id: string
  providerId: string
  providerName: string
  model: string
  /** 本地/免密钥端点（Ollama、LM Studio）：不需要 apiKey */
  keyless: boolean
}

/** provider 的只读视图：永远不含 apiKey 明文，只有掩码与"是否已配" */
export interface AiProviderView {
  id: string
  presetId: string
  name: string
  baseURL: string
  models: string[]
  hasKey: boolean
  /** 形如 `sk-…a1b2`；没配时为空串 */
  apiKeyHint: string
  keyless: boolean
}

export interface AiPreset {
  id: string
  name: string
  /** API 根地址，要写到 /v1 这一级 */
  baseURL: string
  /** 只是填表建议，用户可改 */
  models: string[]
  keyless: boolean
  hint?: string
}

export interface AiSettingsView {
  providers: AiProviderView[]
  /** "providerId/model"；空串表示还没配 */
  defaultModel: string
  presets: AiPreset[]
}

/** 主进程内保存的 provider 配置（含密钥引用，不含密钥本身） */
export interface AiProviderConfig {
  id: string
  presetId: string
  name: string
  baseURL: string
  models: string[]
  /** secrets.bin 里的键名；keyless 时为空串 */
  apiKeyRef: string
  keyless: boolean
}

/** 主进程内保存的整体配置 */
export interface AiConfig {
  providers: AiProviderConfig[]
  defaultModel: string
  /** 会话上限，超过后按最旧删除（v0.6.1 换成摘要） */
  maxSessions: number
  systemPrompt: string
}

/**
 * 流式事件：主进程推给 AI 插件页。
 * 用 seq 单调递增，渲染层按它拼接——本地 IPC 不丢包，seq 主要用来丢弃重启前的旧流。
 */
export type AiStreamEvent =
  | { type: 'start'; sessionId: string; messageId: string; model: string }
  | { type: 'text'; sessionId: string; messageId: string; delta: string }
  | { type: 'reasoning'; sessionId: string; messageId: string; delta: string }
  | { type: 'usage'; sessionId: string; messageId: string; input: number; output: number }
  | { type: 'done'; sessionId: string; messageId: string; stopped?: boolean; error?: string }

/** 发一条消息：sessionId 缺省表示新建会话 */
export interface AiSendRequest {
  sessionId?: string
  text: string
  /** 覆盖会话默认模型；空则用 defaultModel */
  model?: string
}

export interface AiSendResult {
  ok: boolean
  sessionId: string
  messageId: string
  /** ok=false 时的原因（未配置模型 / 缺密钥 / 请求失败） */
  message?: string
}

/**
 * 内置预设。baseURL 都写到 /v1（OpenAI 兼容端点的统一约定），
 * models 只是给表单填空用，用户可自行增删。
 */
export const AI_PRESETS: AiPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyless: false,
    hint: 'API Key 在 platform.deepseek.com 创建'
  },
  {
    id: 'dashscope',
    name: '通义千问（阿里云百炼）',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
    keyless: false,
    hint: '用百炼的 API Key，走 OpenAI 兼容模式'
  },
  {
    id: 'moonshot',
    name: 'Kimi（月之暗面）',
    baseURL: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    keyless: false
  },
  {
    id: 'ollama',
    name: 'Ollama（本地）',
    baseURL: 'http://127.0.0.1:11434/v1',
    models: ['qwen2.5:7b', 'llama3.1:8b'],
    keyless: true,
    hint: '本机已运行 ollama serve 即可，不需要密钥'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o'],
    keyless: false
  },
  {
    id: 'custom',
    name: '自定义（OpenAI 兼容）',
    baseURL: '',
    models: [],
    keyless: false,
    hint: 'vLLM / LM Studio / one-api 等任何 OpenAI 兼容端点'
  }
]

export const DEFAULT_SYSTEM_PROMPT =
  '你是 QuickLauncher 桌面启动器内置的 AI 助手。回答直接、具体，先给结论再给理由；' +
  '代码用围栏并标注语言。不确定的事情直说不确定，不要编造。'

/** 会话里最多保留的消息条数（超出从最旧丢，v0.6.1 换成滚动摘要） */
export const MAX_SESSION_MESSAGES = 200
