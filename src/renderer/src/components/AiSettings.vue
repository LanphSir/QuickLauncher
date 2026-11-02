<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NPopconfirm, NSelect, useMessage } from 'naive-ui'
import AppIcon from './AppIcon.vue'
import AiProviderEdit from './AiProviderEdit.vue'
import { closeOverlay, openOverlay } from '../composables/useOverlay'

const message = useMessage()
const settings = ref<AiSettingsView | null>(null)

const modelOptions = computed(() => {
  const list: { label: string; value: string }[] = []
  for (const p of settings.value?.providers ?? []) {
    for (const m of p.models) list.push({ label: `${p.name} · ${m}`, value: `${p.id}/${m}` })
  }
  return list
})

const testing = ref('')

async function load(): Promise<void> {
  settings.value = await window.panel.aiGetSettings()
}

onMounted(() => void load())

function addProvider(): void {
  let id = 0
  id = openOverlay({
    component: AiProviderEdit,
    label: 'ai-provider-edit',
    initialFocus: 'first',
    props: {
      provider: null,
      presets: settings.value?.presets ?? [],
      onClose: () => closeOverlay(id),
      onSaved: (next: AiSettingsView) => {
        settings.value = next
      }
    }
  })
}

function editProvider(provider: AiProviderView): void {
  let id = 0
  id = openOverlay({
    component: AiProviderEdit,
    label: 'ai-provider-edit',
    initialFocus: 'first',
    props: {
      provider,
      presets: settings.value?.presets ?? [],
      onClose: () => closeOverlay(id),
      onSaved: (next: AiSettingsView) => {
        settings.value = next
      }
    }
  })
}

async function removeProvider(provider: AiProviderView): Promise<void> {
  const r = await window.panel.aiDeleteProvider(provider.id)
  if (r.ok && r.settings) {
    settings.value = r.settings
    message.success('已删除')
  } else {
    message.error(r.message ?? '删除失败')
  }
}

async function testProvider(provider: AiProviderView): Promise<void> {
  testing.value = provider.id
  try {
    const r = await window.panel.aiTestProvider(provider.id)
    if (r.ok) message.success(r.message ?? '连接成功')
    else message.error(r.message ?? '连接失败')
  } finally {
    testing.value = ''
  }
}

async function setDefault(model: string): Promise<void> {
  const r = await window.panel.aiSetDefaultModel(model)
  if (r.ok && r.settings) settings.value = r.settings
  else message.error(r.message ?? '设置失败')
}
</script>

<template>
  <section class="card">
    <div class="card-head">
      <h3>默认模型</h3>
      <span class="count">{{ modelOptions.length }} 个可用</span>
    </div>
    <NSelect
      v-if="modelOptions.length"
      :value="settings?.defaultModel || null"
      :options="modelOptions"
      size="small"
      placeholder="选一个默认模型"
      @update:value="(v: string) => setDefault(v)"
    />
    <p v-else class="empty">
      还没有可用模型。先在下面添加一个服务（DeepSeek / 通义 / Kimi / OpenAI / 本地 Ollama 都行），
      填好密钥就能开始对话。
    </p>
    <p class="hint">
      默认模型决定「AI」应用打开时用哪个。会话里也可以随时切换，切过的会话会记住自己的模型。
    </p>
  </section>

  <section class="card">
    <div class="card-head">
      <h3>模型服务</h3>
      <span class="count">{{ settings?.providers.length ?? 0 }}</span>
      <NButton size="tiny" secondary @click="addProvider">
        <template #icon><AppIcon name="plus" :size="12" /></template>
        添加
      </NButton>
    </div>

    <div v-for="p in settings?.providers ?? []" :key="p.id" class="provider">
      <div class="p-main">
        <div class="p-name">
          {{ p.name }}
          <span v-if="p.keyless" class="p-tag">免密钥</span>
          <span v-else-if="!p.hasKey" class="p-tag warn">缺密钥</span>
        </div>
        <div class="p-sub mono">{{ p.baseURL }}</div>
        <div class="p-meta">
          {{ p.models.length }} 个模型
          <span v-if="p.apiKeyHint"> · 密钥 {{ p.apiKeyHint }}</span>
        </div>
      </div>
      <div class="p-actions">
        <NButton size="tiny" quaternary :loading="testing === p.id" @click="testProvider(p)">测试</NButton>
        <NButton size="tiny" quaternary @click="editProvider(p)">编辑</NButton>
        <NPopconfirm @positive-click="removeProvider(p)">
          <template #trigger>
            <NButton size="tiny" quaternary type="error">删除</NButton>
          </template>
          删除「{{ p.name }}」？密钥会一并清掉。
        </NPopconfirm>
      </div>
    </div>

    <p v-if="!settings?.providers.length" class="empty">还没有服务。点「添加」选一个预设，或填任何 OpenAI 兼容端点。</p>

    <p class="hint">
      密钥由主进程用系统加密（safeStorage）保存，只会以掩码回显，插件页拿不到明文。
      「测试」会请求 <code>/models</code> 验证地址与密钥，不会消耗对话额度。
    </p>
  </section>
</template>

<style scoped>
.card {
  border: 1px solid #eceeef;
  border-radius: 12px;
  padding: 14px 16px;
  margin-bottom: 12px;
}

.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.card-head h3 {
  flex: 1;
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  color: #1f2329;
}

.count {
  font-size: 12px;
  color: #a1a6ad;
}

.provider {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 0;
  border-top: 1px solid #f4f5f6;
}

.provider:first-of-type {
  border-top: none;
}

.p-main {
  flex: 1;
  min-width: 0;
}

.p-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #1f2329;
}

.p-sub {
  margin-top: 2px;
  font-size: 11.5px;
  color: #8f959e;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.p-meta {
  margin-top: 2px;
  font-size: 11.5px;
  color: #a1a6ad;
}

.p-tag {
  padding: 0 5px;
  border-radius: 4px;
  background: #eef6f0;
  color: #2f7d4f;
  font-size: 11px;
  line-height: 16px;
}

.p-tag.warn {
  background: #fff4e6;
  color: #b25d09;
}

.p-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
}

.empty {
  margin: 0;
  padding: 10px 0;
  font-size: 12.5px;
  color: #8f959e;
  line-height: 1.7;
}

.hint {
  margin-top: 8px;
  font-size: 12px;
  color: #8f959e;
  line-height: 1.6;
}

.hint code {
  padding: 0 3px;
  border-radius: 4px;
  background: #f4f5f6;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11.5px;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}
</style>
