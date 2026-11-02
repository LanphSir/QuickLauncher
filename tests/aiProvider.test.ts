import { describe, expect, it } from 'vitest'
import {
  buildChatRequest,
  chatEndpoint,
  isValidHttpUrl,
  maskKey,
  modelId,
  modelOptions,
  modelsEndpoint,
  normalizeProvider,
  parseModelId
} from '../src/main/ai/provider'
import type { AiProviderConfig } from '../src/shared/ai'

const provider: AiProviderConfig = {
  id: 'deepseek',
  presetId: 'deepseek',
  name: 'DeepSeek',
  baseURL: 'https://api.deepseek.com/v1',
  models: ['deepseek-chat'],
  apiKeyRef: 'provider-deepseek',
  keyless: false
}

describe('provider 地址与模型 id', () => {
  it('拼 /chat/completions 时容忍末尾多余斜杠', () => {
    expect(chatEndpoint('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(chatEndpoint('https://api.deepseek.com/v1//')).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(modelsEndpoint('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1/models')
  })

  it('只接受 http(s) 地址', () => {
    expect(isValidHttpUrl('https://api.x.com/v1')).toBe(true)
    expect(isValidHttpUrl('http://127.0.0.1:11434/v1')).toBe(true)
    expect(isValidHttpUrl('api.x.com/v1')).toBe(false)
    expect(isValidHttpUrl('file:///c:/x')).toBe(false)
    expect(isValidHttpUrl('')).toBe(false)
  })

  it('模型 id 按第一个斜杠切分，provider 段不能为空', () => {
    expect(parseModelId('deepseek/deepseek-chat')).toEqual({ providerId: 'deepseek', model: 'deepseek-chat' })
    // 网关型模型名可能自带斜杠：/ 后面的整体算模型
    expect(parseModelId('vllm/Qwen/Qwen3-8B')).toEqual({ providerId: 'vllm', model: 'Qwen/Qwen3-8B' })
    expect(parseModelId('/model')).toBeNull()
    expect(parseModelId('model')).toBeNull()
    expect(parseModelId('deepseek/')).toBeNull()
    expect(modelId('ollama', 'qwen2.5:7b')).toBe('ollama/qwen2.5:7b')
  })

  it('密钥掩码只留头 3 尾 4，短密钥不会原样回显', () => {
    expect(maskKey('sk-1234567890abcdef')).toBe('sk-…cdef')
    expect(maskKey('short')).toBe('s…')
    expect(maskKey('')).toBe('')
  })
})

describe('provider 配置清洗', () => {
  it('缺名字/地址/模型一律拒绝', () => {
    const base = { name: 'X', baseURL: 'https://a.com/v1', models: ['m'] }
    expect(normalizeProvider({ ...base, name: '' })).toBeNull()
    expect(normalizeProvider({ ...base, baseURL: 'a.com' })).toBeNull()
    expect(normalizeProvider({ ...base, models: [] })).toBeNull()
    expect(normalizeProvider(null)).toBeNull()
  })

  it('模型去空去重、非法 id 丢掉（留给上层重新生成）', () => {
    const p = normalizeProvider({
      id: 'has space',
      name: 'X',
      baseURL: 'https://a.com/v1',
      models: [' m1 ', 'm1', '', 42, 'm2']
    })
    expect(p?.models).toEqual(['m1', 'm2'])
    expect(p?.id).toBe('')
    expect(p?.presetId).toBe('custom')
  })

  it('摊平模型列表时带上 provider 信息', () => {
    const list = modelOptions([provider, { ...provider, id: 'local', name: '本地', keyless: true, models: ['q'] }])
    expect(list.map((m) => m.id)).toEqual(['deepseek/deepseek-chat', 'local/q'])
    expect(list[1].keyless).toBe(true)
    expect(list[0].providerName).toBe('DeepSeek')
  })
})

describe('请求体构造', () => {
  it('带密钥时加 Authorization，流式固定开启', () => {
    const built = buildChatRequest(provider, 'deepseek-chat', 'sk-test', [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' }
    ])
    expect(built.url).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(built.headers.Authorization).toBe('Bearer sk-test')
    expect(built.body).toMatchObject({ model: 'deepseek-chat', stream: true })
    expect(built.body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' }
    ])
  })

  it('免密钥端点不带 Authorization（本地 Ollama 不认这个头也不该收到）', () => {
    const local: AiProviderConfig = { ...provider, id: 'ollama', keyless: true, apiKeyRef: '' }
    const built = buildChatRequest(local, 'qwen2.5:7b', null, [{ role: 'user', content: 'hi' }])
    expect(built.headers.Authorization).toBeUndefined()
  })
})
