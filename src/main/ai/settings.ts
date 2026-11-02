/**
 * AI 侧配置（userData/ai/config.json）：provider 列表、默认模型、系统提示词。
 *
 * 与根 config.ts 分开的理由：AI 配置的读写频率与敏感度都不同（密钥、模型列表），
 * 混进全局 config 会让"改个快捷键"也去重写一份密钥引用。
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  AI_PRESETS,
  DEFAULT_SYSTEM_PROMPT,
  type AiConfig,
  type AiProviderConfig,
  type AiProviderView,
  type AiSettingsView
} from '../../shared/ai'
import { fetchModels } from './client'
import { maskKey, modelId, modelsEndpoint, normalizeProvider, parseModelId } from './provider'
import { hasSecret, readSecret, removeSecret, saveSecret } from './secrets'

const DEFAULTS: AiConfig = {
  providers: [],
  defaultModel: '',
  maxSessions: 100,
  systemPrompt: DEFAULT_SYSTEM_PROMPT
}

let config: AiConfig = { ...DEFAULTS }
let loaded = false

function configFile(): string {
  return join(app.getPath('userData'), 'ai', 'config.json')
}

export function loadAiConfig(): AiConfig {
  try {
    if (existsSync(configFile())) {
      const raw = JSON.parse(readFileSync(configFile(), 'utf-8')) as Partial<AiConfig>
      const providers: AiProviderConfig[] = []
      for (const item of Array.isArray(raw.providers) ? raw.providers : []) {
        const normalized = normalizeProvider(item)
        // 缺 id 的旧数据没法寻址，直接跳过（比给它编一个 id 更不容易出错）
        if (normalized && normalized.id) providers.push(normalized)
      }
      config = {
        providers,
        defaultModel: typeof raw.defaultModel === 'string' ? raw.defaultModel : '',
        maxSessions:
          typeof raw.maxSessions === 'number' && raw.maxSessions > 0 ? raw.maxSessions : DEFAULTS.maxSessions,
        systemPrompt:
          typeof raw.systemPrompt === 'string' && raw.systemPrompt.trim()
            ? raw.systemPrompt
            : DEFAULTS.systemPrompt
      }
      // 默认模型指向已删除的 provider 时重置，避免每次发消息都报"模型不存在"
      if (config.defaultModel && !parseModelId(config.defaultModel)) config.defaultModel = ''
    }
  } catch (err) {
    console.error('[ai] 配置读取失败，使用默认值', err)
    config = { ...DEFAULTS }
  }
  loaded = true
  return config
}

export function getAiConfig(): AiConfig {
  if (!loaded) loadAiConfig()
  return config
}

function persist(): void {
  const file = configFile()
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8')
  renameSync(tmp, file)
}

/** 设置页看到的形状：一律不含明文密钥 */
export function settingsView(): AiSettingsView {
  const cfg = getAiConfig()
  const providers: AiProviderView[] = cfg.providers.map((p) => {
    const key = p.keyless ? null : readSecret(p.apiKeyRef)
    return {
      id: p.id,
      presetId: p.presetId,
      name: p.name,
      baseURL: p.baseURL,
      models: [...p.models],
      hasKey: p.keyless || hasSecret(p.apiKeyRef),
      apiKeyHint: key ? maskKey(key) : '',
      keyless: p.keyless
    }
  })
  return { providers, defaultModel: cfg.defaultModel, presets: AI_PRESETS }
}

export interface ProviderInput {
  id?: string
  presetId?: string
  name: string
  baseURL: string
  models: string[]
  /** 明文密钥：只在这一次提交里出现，落盘前就加密 */
  apiKey?: string
  keyless?: boolean
}

/** provider id 用来做模型 id 前缀，只允许 \w.- ，且全局唯一 */
function uniqueProviderId(base: string): string {
  const slug = base
    .toLowerCase()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'provider'
  const exists = (id: string) => getAiConfig().providers.some((p) => p.id === id)
  if (!exists(slug)) return slug
  let n = 2
  while (exists(`${slug}-${n}`)) n++
  return `${slug}-${n}`
}

export function saveProvider(input: ProviderInput): { ok: boolean; message?: string; settings?: AiSettingsView } {
  const cfg = getAiConfig()
  const existing = input.id ? cfg.providers.find((p) => p.id === input.id) : undefined
  const presetId = input.presetId?.trim() || existing?.presetId || 'custom'
  const id = existing?.id ?? uniqueProviderId(presetId === 'custom' ? input.name : presetId)

  const normalized = normalizeProvider({
    id,
    presetId,
    name: input.name,
    baseURL: input.baseURL,
    models: input.models,
    keyless: input.keyless === true,
    apiKeyRef: existing?.apiKeyRef ?? (input.keyless ? '' : `provider-${id}`)
  })
  if (!normalized) {
    return { ok: false, message: '名称、接口地址（http/https）与至少一个模型名都是必填' }
  }
  if (!normalized.keyless && !normalized.apiKeyRef) normalized.apiKeyRef = `provider-${id}`

  const key = input.apiKey?.trim() ?? ''
  if (!normalized.keyless && key) {
    const saved = saveSecret(normalized.apiKeyRef, key)
    if (!saved.ok) return { ok: false, message: saved.message }
  }
  if (!normalized.keyless && !hasSecret(normalized.apiKeyRef)) {
    // 允许先存空（用户可能之后填），但要明确告诉他现在还不能用
    console.warn(`[ai] provider ${id} 还没有密钥`)
  }

  const next = cfg.providers.filter((p) => p.id !== id)
  next.push(normalized)
  config = { ...cfg, providers: next }
  if (!config.defaultModel) {
    config.defaultModel = modelId(normalized.id, normalized.models[0])
  }
  persist()
  return { ok: true, settings: settingsView() }
}

export function deleteProvider(id: string): { ok: boolean; message?: string; settings?: AiSettingsView } {
  const cfg = getAiConfig()
  const target = cfg.providers.find((p) => p.id === id)
  if (!target) return { ok: false, message: '没有这个 provider' }
  removeSecret(target.apiKeyRef)
  const providers = cfg.providers.filter((p) => p.id !== id)
  const parsed = parseModelId(cfg.defaultModel)
  const defaultModel =
    parsed && parsed.providerId === id
      ? providers[0]
        ? modelId(providers[0].id, providers[0].models[0])
        : ''
      : cfg.defaultModel
  config = { ...cfg, providers, defaultModel }
  persist()
  return { ok: true, settings: settingsView() }
}

export function setDefaultModel(id: string): { ok: boolean; message?: string; settings?: AiSettingsView } {
  const cfg = getAiConfig()
  const parsed = parseModelId(id)
  const provider = parsed ? cfg.providers.find((p) => p.id === parsed.providerId) : undefined
  if (!parsed || !provider || !provider.models.includes(parsed.model)) {
    return { ok: false, message: '模型不存在（先在 provider 的模型列表里添加）' }
  }
  config = { ...cfg, defaultModel: id }
  persist()
  return { ok: true, settings: settingsView() }
}

/** 探活：地址 + 密钥一起验，顺带把真实模型列表带回来（用户可一键改成实际可用名） */
export async function testProvider(id: string): Promise<{ ok: boolean; message?: string; models?: string[] }> {
  const provider = getAiConfig().providers.find((p) => p.id === id)
  if (!provider) return { ok: false, message: '没有这个 provider' }
  const key = provider.keyless ? null : readSecret(provider.apiKeyRef)
  if (!provider.keyless && !key) return { ok: false, message: '还没填密钥' }
  const r = await fetchModels(modelsEndpoint(provider.baseURL), key)
  if (!r.ok) return r
  return { ok: true, models: r.models, message: r.models?.length ? `可用模型 ${r.models.length} 个` : '连接成功' }
}

export type ResolvedModel =
  | { ok: true; provider: AiProviderConfig; model: string; apiKey: string | null }
  | { ok: false; message: string }

/** 把 "provider/model" 解析成可发请求的组合；所有"发不出去"的原因都在这里说清 */
export function resolveModel(modelRef?: string): ResolvedModel {
  const cfg = getAiConfig()
  const id = modelRef?.trim() || cfg.defaultModel
  if (!id) return { ok: false, message: '还没有配置模型：打开 设置 → AI 添加一个 provider' }
  const parsed = parseModelId(id)
  if (!parsed) return { ok: false, message: `模型 id 不合法：${id}` }
  const provider = cfg.providers.find((p) => p.id === parsed.providerId)
  if (!provider) return { ok: false, message: `找不到 provider「${parsed.providerId}」` }
  if (!provider.models.includes(parsed.model)) {
    return { ok: false, message: `「${provider.name}」没有模型 ${parsed.model}，先在设置里添加` }
  }
  const apiKey = provider.keyless ? null : readSecret(provider.apiKeyRef)
  if (!provider.keyless && !apiKey) {
    return { ok: false, message: `「${provider.name}」还没填 API Key` }
  }
  return { ok: true, provider, model: parsed.model, apiKey }
}
