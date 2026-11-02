/**
 * OpenAI 兼容 provider 的纯逻辑：地址归一、请求体构造、模型 id 解析、密钥掩码。
 *
 * 为什么只做 OpenAI 兼容：DeepSeek / 通义百炼 / Kimi / Ollama / LM Studio / vLLM
 * 全都提供这一套端点，一套代码覆盖九成场景；等真有非兼容需求（Anthropic 协议）
 * 再加适配层，而不是提前抽象。
 */
import { AI_PRESETS, type AiModelOption, type AiPreset, type AiProviderConfig } from '../../shared/ai'

/** 多模态内容块。纯文本消息仍然走 string，只有带图时才用数组 */
export type ApiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ApiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ApiContentPart[]
}

export interface BuiltRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

export function findPreset(id: string): AiPreset | undefined {
  return AI_PRESETS.find((p) => p.id === id)
}

/** 去掉末尾斜杠，拼出 chat/completions。baseURL 约定写到 /v1 这一级 */
export function chatEndpoint(baseURL: string): string {
  return `${baseURL.trim().replace(/\/+$/, '')}/chat/completions`
}

export function modelsEndpoint(baseURL: string): string {
  return `${baseURL.trim().replace(/\/+$/, '')}/models`
}

export function isValidHttpUrl(raw: string): boolean {
  const value = raw.trim()
  if (!/^https?:\/\//i.test(value)) return false
  try {
    const url = new URL(value)
    return Boolean(url.hostname)
  } catch {
    return false
  }
}

/** `providerId/model` → 两段。provider id 不含 `/`，所以按第一个斜杠切 */
export function parseModelId(id: string): { providerId: string; model: string } | null {
  const value = String(id ?? '').trim()
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return null
  return { providerId: value.slice(0, slash), model: value.slice(slash + 1) }
}

export function modelId(providerId: string, model: string): string {
  return `${providerId}/${model}`
}

/** `sk-abcdef123456` → `sk-…3456`：够认人，不够用来泄漏 */
export function maskKey(key: string): string {
  const value = key.trim()
  if (!value) return ''
  if (value.length <= 8) return `${value.slice(0, 1)}…`
  return `${value.slice(0, 3)}…${value.slice(-4)}`
}

/**
 * 清洗一条 provider 配置（来自设置页提交或磁盘上的旧数据）。
 * 合法性只到"能发请求"为止：地址必须是 http(s)，模型列表去掉空项。
 */
export function normalizeProvider(raw: unknown): AiProviderConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const baseURL = typeof r.baseURL === 'string' ? r.baseURL.trim() : ''
  if (!isValidHttpUrl(baseURL)) return null
  const name = typeof r.name === 'string' ? r.name.trim() : ''
  if (!name) return null
  const models = Array.isArray(r.models)
    ? [...new Set(r.models.filter((m): m is string => typeof m === 'string').map((m) => m.trim()).filter(Boolean))]
    : []
  if (!models.length) return null
  const contextWindow =
    typeof r.contextWindow === 'number' && Number.isFinite(r.contextWindow) && r.contextWindow >= 1024
      ? Math.floor(r.contextWindow)
      : undefined
  const visionModels = Array.isArray(r.visionModels)
    ? [...new Set(r.visionModels.filter((m): m is string => typeof m === 'string').map((m) => m.trim().toLowerCase()).filter(Boolean))]
    : undefined
  return {
    id: typeof r.id === 'string' && /^[\w.-]+$/.test(r.id) ? r.id : '',
    presetId: typeof r.presetId === 'string' && r.presetId ? r.presetId : 'custom',
    name,
    baseURL,
    models,
    apiKeyRef: typeof r.apiKeyRef === 'string' ? r.apiKeyRef : '',
    keyless: r.keyless === true,
    ...(contextWindow ? { contextWindow } : {}),
    ...(visionModels && visionModels.length ? { visionModels } : {})
  }
}

/** 该 provider 下的这个模型能不能读图（按模型名子串匹配，用户可在设置里改） */
export function supportsVision(provider: AiProviderConfig, model: string): boolean {
  const list = provider.visionModels ?? []
  if (!list.length) return false
  const name = model.toLowerCase()
  return list.some((token) => name.includes(token))
}

/** 把可用的 (provider, model) 摊平成扁平列表，设置页与插件页共用 */
export function modelOptions(providers: AiProviderConfig[]): AiModelOption[] {
  const out: AiModelOption[] = []
  for (const p of providers) {
    for (const m of p.models) {
      out.push({
        id: modelId(p.id, m),
        providerId: p.id,
        providerName: p.name,
        model: m,
        keyless: p.keyless
      })
    }
  }
  return out
}

/**
 * 拼一次流式聊天请求。
 * 不带 `stream_options`：部分兼容实现不认这个字段会直接 400，
 * 而 usage 只是可选统计，宁可拿不到也不要整条请求失败。
 */
export function buildChatRequest(
  provider: AiProviderConfig,
  model: string,
  apiKey: string | null,
  messages: ApiMessage[],
  options: { stream?: boolean; maxTokens?: number; temperature?: number } = {}
): BuiltRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (!provider.keyless && apiKey) headers.Authorization = `Bearer ${apiKey}`
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: options.stream !== false
  }
  if (typeof options.maxTokens === 'number' && options.maxTokens > 0) body.max_tokens = options.maxTokens
  if (typeof options.temperature === 'number') body.temperature = options.temperature
  return {
    url: chatEndpoint(provider.baseURL),
    headers,
    body
  }
}
