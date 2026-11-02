<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NPopconfirm, NSelect, NSwitch, useMessage } from 'naive-ui'
import AppIcon from './AppIcon.vue'
import AiProviderEdit from './AiProviderEdit.vue'
import AiMcpConfirm from './AiMcpConfirm.vue'
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
const toolPlugins = ref<AiToolPluginView[]>([])
const toolBusy = ref('')
const mcpServers = ref<AiMcpServerView[]>([])
const mcpBusy = ref('')

const grantedCount = computed(() => toolPlugins.value.filter((p) => p.granted).length)
const approvedMcp = computed(() => mcpServers.value.filter((s) => s.state === 'approved').length)

const MCP_STATE_LABEL: Record<AiMcpServerView['state'], string> = {
  pending: '待确认',
  approved: '已允许',
  rejected: '已拒绝',
  stale: '命令已改，需重新确认',
  disabled: '已停用'
}

async function load(): Promise<void> {
  settings.value = await window.panel.aiGetSettings()
  toolPlugins.value = await window.panel.aiTools()
  mcpServers.value = await window.panel.aiMcpServers()
}

onMounted(() => void load())

const RISK_LABEL: Record<AiToolRiskView, string> = {
  read: '只读',
  write: '需确认',
  dangerous: '每次确认'
}

async function toggleGrant(view: AiToolPluginView, granted: boolean): Promise<void> {
  toolBusy.value = view.pluginId
  try {
    const r = await window.panel.aiSetToolGrant(view.pluginId, granted)
    if (!r.ok) {
      message.error(r.message ?? '设置失败')
      return
    }
    // 重新拉一遍而不是本地改标志位：插件可能刚被停用、tools.json 可能刚被改
    toolPlugins.value = await window.panel.aiTools()
  } finally {
    toolBusy.value = ''
  }
}

async function refreshMcp(): Promise<void> {
  mcpServers.value = await window.panel.aiMcpServers()
}

/**
 * 允许要过确认弹窗（完整 argv），拒绝可以直接点——拒绝没有任何风险，
 * 多一道门只会让人以为「连拒绝都要打报告」。
 */
function askApprove(row: AiMcpServerView): void {
  let id = 0
  id = openOverlay({
    component: AiMcpConfirm,
    label: 'ai-mcp-confirm',
    initialFocus: 'first',
    props: {
      target: row,
      onClose: () => closeOverlay(id),
      onDecided: async (allow: boolean, reason?: string) => {
        closeOverlay(id)
        mcpBusy.value = `${row.pluginId}::${row.server}`
        try {
          await refreshMcp()
          if (reason) message.error(reason)
          else message.success(allow ? '已允许，工具会随下一次对话下发' : '已拒绝')
        } finally {
          mcpBusy.value = ''
        }
      }
    }
  })
}

async function decide(row: AiMcpServerView, allow: boolean): Promise<void> {
  mcpBusy.value = `${row.pluginId}::${row.server}`
  try {
    const r = await window.panel.aiMcpDecision(row.pluginId, row.server, allow)
    if (!r.ok) message.error(r.message ?? '操作失败')
    else if (allow) message.success('已允许，工具会随下一次对话下发')
    await refreshMcp()
  } finally {
    mcpBusy.value = ''
  }
}

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

  <section class="card">
    <div class="card-head">
      <h3>AI 工具</h3>
      <span class="count">{{ grantedCount }}/{{ toolPlugins.length }} 已授权</span>
    </div>

    <div v-for="p in toolPlugins" :key="p.pluginId" class="tool-plugin">
      <div class="p-main">
        <div class="p-name">
          {{ p.pluginName }}
          <span v-if="p.disabled" class="p-tag warn">已停用</span>
          <span v-else-if="p.granted" class="p-tag">可被调用</span>
        </div>
        <div class="p-meta">
          <template v-if="p.tools.length">
            {{ p.tools.length }} 个工具：
            <span v-for="t in p.tools" :key="t.name" class="tool-chip" :title="t.name">
              {{ t.title }}
              <em :class="`risk-${t.risk}`">{{ RISK_LABEL[t.risk] }}</em>
            </span>
          </template>
          <template v-else>没有可用的工具声明</template>
        </div>
        <div v-if="p.skill" class="p-skill">
          <span class="skill-name">{{ p.skill.name }}</span>{{ p.skill.description }}
        </div>
        <div v-for="e in p.errors" :key="e" class="p-error">{{ e }}</div>
      </div>
      <div class="p-actions">
        <NSwitch
          size="small"
          :value="p.granted"
          :disabled="p.disabled || toolBusy === p.pluginId"
          @update:value="(v: boolean) => toggleGrant(p, v)"
        />
      </div>
    </div>

    <p v-if="!toolPlugins.length" class="empty">
      还没有插件声明 AI 能力。插件在自己的 <code>plugin.json</code> 里加
      <code>ai: { "tools": "ai/tools.json" }</code> 并声明 <code>permissions: ["ai"]</code> 后，
      这里就会出现它的开关。
    </p>

    <p class="hint">
      授权的插件，其工具才会出现在模型手上；未授权时工具与技能文档都不下发。
      工具能读到剪贴板、能改你的数据，所以默认全部关闭。
    </p>
  </section>

  <section class="card">
    <div class="card-head">
      <h3>MCP 服务</h3>
      <span class="count">{{ approvedMcp }}/{{ mcpServers.length }} 已允许</span>
    </div>

    <div v-for="s in mcpServers" :key="`${s.pluginId}::${s.server}`" class="mcp">
      <div class="p-main">
        <div class="p-name">
          {{ s.pluginName }}<span class="mcp-server">/{{ s.server }}</span>
          <span class="p-tag" :class="`mcp-tag-${s.state}`">{{ MCP_STATE_LABEL[s.state] }}</span>
          <span v-if="s.running" class="p-tag">运行中 · {{ s.toolCount }} 个工具</span>
        </div>
        <div class="p-sub mono">{{ s.commandLine || '（没有可用的命令）' }}</div>
        <div v-if="s.envKeys.length" class="p-meta">环境变量：{{ s.envKeys.join('、') }}</div>
        <div v-for="e in s.errors" :key="e" class="p-error">{{ e }}</div>
        <div v-if="s.error" class="p-error">{{ s.error }}</div>
      </div>
      <div class="p-actions">
        <NButton
          size="tiny"
          :type="s.state === 'approved' ? 'default' : 'error'"
          :secondary="s.state !== 'approved'"
          :quaternary="s.state === 'approved'"
          :disabled="mcpBusy === `${s.pluginId}::${s.server}`"
          @click="askApprove(s)"
        >
          {{ s.state === 'approved' ? '重新确认' : '查看命令' }}
        </NButton>
        <NButton
          v-if="s.state !== 'rejected'"
          size="tiny"
          quaternary
          :disabled="mcpBusy === `${s.pluginId}::${s.server}`"
          @click="decide(s, false)"
        >
          拒绝
        </NButton>
      </div>
    </div>

    <p v-if="!mcpServers.length" class="empty">
      还没有插件声明 MCP server。插件在 <code>plugin.json</code> 里写
      <code>ai: { "mcp": "ai/mcp.json" }</code> 并声明 <code>permissions: ["ai"]</code> 后，
      这里会列出它想执行的命令。
    </p>

    <p class="hint">
      这些条目是<strong>要在这台机器上执行的命令</strong>，所以默认一条都不跑：必须由你看过完整命令行后逐条允许，
      允许绑定到命令本身——插件改了任何参数都会重新问你。进程只在 AI 需要用到工具时才启动；
      允许某个 server 时会顺带打开该插件在「AI 工具」里的开关，关掉那个开关也会一并停用它的 MCP 工具。
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

/* ---- AI 工具 ---- */
.tool-plugin {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 0;
  border-top: 1px solid #f4f5f6;
}

.tool-plugin:first-of-type {
  border-top: none;
}

.tool-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 2px 4px 2px 0;
  padding: 0 6px;
  border-radius: 5px;
  background: #f4f5f6;
  color: #1f2329;
  font-size: 11.5px;
  line-height: 18px;
  white-space: nowrap;
}

.tool-chip em {
  font-style: normal;
  font-size: 10.5px;
}

.risk-read {
  color: #2f7d4f;
}

.risk-write {
  color: #b25d09;
}

.risk-dangerous {
  color: #c0392b;
}

.p-skill {
  margin-top: 3px;
  font-size: 11.5px;
  color: #8f959e;
  line-height: 1.6;
}

.skill-name {
  margin-right: 6px;
  padding: 0 5px;
  border-radius: 4px;
  background: #f2f0fd;
  color: #6b4fd8;
}

.p-error {
  margin-top: 3px;
  font-size: 11.5px;
  color: #b25d09;
  line-height: 1.6;
}

/* ---- MCP 服务 ---- */
.mcp {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 0;
  border-top: 1px solid #f4f5f6;
}

.mcp:first-of-type {
  border-top: none;
}

.mcp-server {
  color: #8f959e;
  font-size: 12px;
}

.mcp-tag-pending {
  background: #fff4e6;
  color: #b25d09;
}

.mcp-tag-approved {
  background: #eef6f0;
  color: #2f7d4f;
}

.mcp-tag-rejected {
  background: #f4f5f6;
  color: #8f959e;
}

.mcp-tag-stale {
  background: #fdecea;
  color: #c0392b;
}

.mcp-tag-disabled {
  background: #f4f5f6;
  color: #c0392b;
}
</style>
