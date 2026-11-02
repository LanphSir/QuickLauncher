<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NSwitch, useMessage } from 'naive-ui'
import AppIcon from './AppIcon.vue'

const props = defineProps<{
  provider?: AiProviderView | null
  presets: AiPresetView[]
  onClose?: () => void
  onSaved?: (settings: AiSettingsView) => void
}>()

const message = useMessage()
const editing = computed(() => Boolean(props.provider))

const presetId = ref(props.provider?.presetId ?? 'deepseek')
const name = ref(props.provider?.name ?? '')
const baseURL = ref(props.provider?.baseURL ?? '')
const modelsText = ref((props.provider?.models ?? []).join(', '))
const apiKey = ref('')
const keyless = ref(props.provider?.keyless ?? false)
const saving = ref(false)
const testing = ref(false)
const error = ref('')

/** 新建时选预设就把名字/地址/模型带出来，用户只补密钥 */
function applyPreset(id: string): void {
  presetId.value = id
  const preset = props.presets.find((p) => p.id === id)
  if (!preset) return
  name.value = preset.name
  baseURL.value = preset.baseURL
  modelsText.value = preset.models.join(', ')
  keyless.value = preset.keyless
}

if (!editing.value) applyPreset(presetId.value)

const keyPlaceholder = computed(() => {
  if (keyless.value) return '本地端点不需要密钥'
  if (props.provider?.hasKey) return `已保存（${props.provider.apiKeyHint}），留空则不修改`
  return 'sk-...'
})

const models = computed(() =>
  modelsText.value
    .split(/[,，\s]+/)
    .map((m) => m.trim())
    .filter(Boolean)
)

async function save(): Promise<void> {
  error.value = ''
  if (!name.value.trim()) {
    error.value = '给这个服务起个名字（只用于界面显示）'
    return
  }
  if (!/^https?:\/\//i.test(baseURL.value.trim())) {
    error.value = '接口地址必须以 http:// 或 https:// 开头'
    return
  }
  if (!models.value.length) {
    error.value = '至少填一个模型名'
    return
  }
  saving.value = true
  try {
    const r = await window.panel.aiSaveProvider({
      id: props.provider?.id,
      presetId: presetId.value,
      name: name.value.trim(),
      baseURL: baseURL.value.trim(),
      models: models.value,
      apiKey: apiKey.value.trim() || undefined,
      keyless: keyless.value
    })
    if (!r.ok) {
      error.value = r.message ?? '保存失败'
      return
    }
    if (r.settings) props.onSaved?.(r.settings)
    if (!keyless.value && !apiKey.value.trim() && !props.provider?.hasKey) {
      message.warning('已保存，但没有密钥还发不出请求；点「编辑」补上即可')
    } else {
      message.success('已保存')
    }
    props.onClose?.()
  } finally {
    saving.value = false
  }
}

async function test(): Promise<void> {
  if (!props.provider) return
  error.value = ''
  testing.value = true
  try {
    const r = await window.panel.aiTestProvider(props.provider.id)
    if (r.ok) message.success(r.message ?? '连接成功')
    else error.value = r.message ?? '连接失败'
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <div class="modal">
    <header class="head">
      <h2>{{ editing ? '编辑模型服务' : '添加模型服务' }}</h2>
      <button class="close" title="关闭" @click="props.onClose?.()">
        <AppIcon name="x" :size="16" />
      </button>
    </header>
    <p class="desc">
      支持任何 OpenAI 兼容端点（DeepSeek / 通义 / Kimi / OpenAI / Ollama / LM Studio / one-api）。
      密钥由系统加密保存在本机，不会写进配置文件明文。
    </p>

    <div class="form">
      <template v-if="!editing">
        <label>服务预设</label>
        <select class="field" :value="presetId" @change="applyPreset(($event.target as HTMLSelectElement).value)">
          <option v-for="p in presets" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </template>

      <label>显示名称</label>
      <input v-model="name" class="field" type="text" spellcheck="false" placeholder="例如：DeepSeek" />

      <label>接口地址<span class="req">*</span></label>
      <input
        v-model="baseURL"
        class="field mono"
        type="text"
        spellcheck="false"
        placeholder="https://api.deepseek.com/v1"
      />
      <p class="hint">要写到 <code>/v1</code> 这一级；程序会在后面拼 <code>/chat/completions</code>。</p>

      <label>模型<span class="req">*</span>（逗号分隔，可多个）</label>
      <input
        v-model="modelsText"
        class="field mono"
        type="text"
        spellcheck="false"
        placeholder="deepseek-chat, deepseek-reasoner"
      />

      <div class="key-head">
        <label>API Key</label>
        <span class="switch">
          <NSwitch v-model:value="keyless" size="small" />
          <span class="switch-label">本地模型（免密钥）</span>
        </span>
      </div>
      <input
        v-model="apiKey"
        class="field mono"
        type="password"
        spellcheck="false"
        autocomplete="off"
        :disabled="keyless"
        :placeholder="keyPlaceholder"
      />
      <p v-if="!editing && !keyless && !apiKey" class="hint warn">
        可以先保存、之后再填密钥，但填之前发不出请求。
      </p>

      <p v-if="error" class="err">{{ error }}</p>
    </div>

    <footer class="foot">
      <NButton v-if="editing" size="small" quaternary :loading="testing" @click="test">测试连接</NButton>
      <span class="spacer" />
      <NButton size="small" type="primary" :loading="saving" @click="save">保存</NButton>
      <NButton size="small" quaternary @click="props.onClose?.()">取消</NButton>
    </footer>
  </div>
</template>

<style scoped>
.modal {
  width: 460px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 72px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #fff;
  border-radius: 16px;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.24);
  padding: 20px;
  animation: pop 0.16s ease;
}

@keyframes pop {
  from {
    transform: scale(0.96);
    opacity: 0.5;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}

.head {
  flex: none;
  display: flex;
  align-items: center;
}

.head h2 {
  flex: 1;
  font-size: 16px;
  font-weight: 600;
}

.close {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  color: #a1a6ad;
}

.close:hover {
  background: #f2f3f5;
  color: #1f2329;
}

.desc {
  flex: none;
  margin-top: 8px;
  font-size: 12.5px;
  color: #8f959e;
  line-height: 1.6;
}

.form {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin-top: 14px;
  padding-right: 4px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

label {
  margin-top: 6px;
  font-size: 12px;
  color: #5c6470;
}

.req {
  margin-left: 2px;
  color: #d03050;
}

.field {
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: 1px solid #e5e6eb;
  border-radius: 8px;
  font-size: 13px;
  color: #1f2329;
  background: #fff;
  outline: none;
}

.field:focus {
  border-color: #6b9cf7;
  box-shadow: 0 0 0 3px rgba(64, 128, 255, 0.12);
}

.field:disabled {
  background: #f7f8f9;
  color: #a1a6ad;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12.5px;
}

.key-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.key-head label {
  margin-top: 0;
  flex: 1;
}

.switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.switch-label {
  font-size: 12px;
  color: #8f959e;
}

.hint {
  margin: 0;
  font-size: 11.5px;
  color: #a1a6ad;
  line-height: 1.6;
}

.hint.warn {
  color: #b25d09;
}

.hint code {
  padding: 0 3px;
  border-radius: 4px;
  background: #f4f5f6;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

.err {
  margin: 4px 0 0;
  font-size: 12px;
  color: #d03050;
  line-height: 1.6;
}

.foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid #f4f5f6;
}

.spacer {
  flex: 1;
}
</style>
