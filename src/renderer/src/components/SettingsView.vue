<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NButton, NSwitch, useMessage } from 'naive-ui'

const emit = defineEmits<{ back: [] }>()
const message = useMessage()

const config = ref<LauncherConfig | null>(null)
const hotkeyDraft = ref('')
const hotkeyEl = ref<HTMLElement | null>(null)

onMounted(async () => {
  config.value = await window.panel.getConfig()
  hotkeyDraft.value = config.value.hotkey
})

const KEY_MODIFIERS = new Set(['Alt', 'Control', 'Shift', 'Meta', 'Dead', 'Unidentified'])

function captureHotkey(e: KeyboardEvent): void {
  e.preventDefault()
  const mods: string[] = []
  if (e.altKey) mods.push('Alt')
  if (e.ctrlKey) mods.push('CommandOrControl')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Super')
  let key = e.key
  if (KEY_MODIFIERS.has(key)) return // 未构成组合键
  if (key === ' ') key = 'Space'
  else if (key.length === 1) key = key.toUpperCase()
  if (!mods.length) {
    message.warning('快捷键需至少包含一个修饰键（Alt / Ctrl / Shift / Win）')
    return
  }
  hotkeyDraft.value = [...new Set(mods), key].join('+')
}

async function applyHotkey(): Promise<void> {
  if (!config.value || !hotkeyDraft.value) return
  if (hotkeyDraft.value === config.value.hotkey) return
  const result = await window.panel.updateConfig({ hotkey: hotkeyDraft.value })
  if (result.ok && result.config) {
    config.value = result.config
    message.success('快捷键已更新，立即生效')
  } else {
    hotkeyDraft.value = config.value.hotkey
    message.error(result.message ?? '快捷键注册失败')
  }
}

async function resetHotkey(): Promise<void> {
  hotkeyDraft.value = 'Alt+Space'
  await applyHotkey()
}

async function toggleAutostart(enabled: boolean): Promise<void> {
  const result = await window.panel.updateConfig({ autostart: enabled })
  if (result.ok && result.config) {
    config.value = result.config
    message.success(enabled ? '已开启开机自启' : '已关闭开机自启')
  } else {
    message.error(result.message ?? '设置失败')
  }
}
</script>

<template>
  <div class="settings">
    <header class="settings-header">
      <button class="back" @click="emit('back')">
        <svg viewBox="0 0 24 24" width="16" height="16">
          <path d="M15 4 7 12l8 8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        返回
      </button>
      <h2>设置</h2>
      <span class="spacer" />
    </header>

    <div class="settings-body" v-if="config">
      <section class="card">
        <h3>唤起快捷键</h3>
        <div class="row">
          <div
            ref="hotkeyEl"
            class="hotkey-box"
            :class="{ capturing: false }"
            tabindex="0"
            title="点击后按下新的组合键"
            @keydown="captureHotkey"
          >
            <kbd v-for="part in hotkeyDraft.split('+')" :key="part">{{ part }}</kbd>
          </div>
          <NButton size="small" type="primary" :disabled="hotkeyDraft === config.hotkey" @click="applyHotkey">
            应用
          </NButton>
          <NButton size="small" quaternary @click="resetHotkey">恢复默认</NButton>
        </div>
        <p class="hint">点击输入框后直接按下组合键（如 Alt+Space）。若与其他程序冲突会提示。</p>
      </section>

      <section class="card">
        <h3>启动</h3>
        <div class="row space">
          <div>
            <div class="row-title">开机自启</div>
            <p class="hint">登录 Windows 后自动在托盘运行</p>
          </div>
          <NSwitch :value="config.autostart" size="small" @update:value="toggleAutostart" />
        </div>
        <p v-if="!config.isPackaged" class="hint warn">开发模式下不修改系统登录项，打包安装后此开关才实际生效。</p>
      </section>

      <section class="card">
        <h3>关于</h3>
        <p class="hint">
          QuickLauncher v0.1.0 — 全局快捷键唤起的插件化工具面板。<br />
          Electron + Vue 3 · 插件进程级隔离 · 自定义插件协议（见 docs/plugin-dev-guide.md）
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.settings {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 16px;
  border: 1px solid rgba(0, 0, 0, 0.06);
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.2);
  overflow: hidden;
}

.settings-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 20px 10px;
}

.settings-header h2 {
  font-size: 17px;
  font-weight: 600;
}

.back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: #646a73;
  padding: 5px 10px 5px 6px;
  border-radius: 8px;
}

.back:hover {
  background: #f2f3f5;
  color: #1f2329;
}

.spacer {
  flex: 1;
}

.settings-body {
  flex: 1;
  overflow-y: auto;
  padding: 6px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.card {
  border: 1px solid #eceeef;
  border-radius: 12px;
  padding: 14px 16px;
}

.card h3 {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 12px;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.row.space {
  justify-content: space-between;
}

.row-title {
  font-size: 14px;
}

.hotkey-box {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 34px;
  padding: 5px 10px;
  border: 1px solid #dfe1e4;
  border-radius: 8px;
  outline: none;
  cursor: pointer;
}

.hotkey-box:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
}

kbd {
  font-family: inherit;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 5px;
  background: #f2f3f5;
  border: 1px solid #e0e2e5;
  box-shadow: 0 1px 0 #e0e2e5;
}

.hint {
  margin-top: 8px;
  font-size: 12px;
  color: #8f959e;
  line-height: 1.6;
}

.hint.warn {
  color: #d48806;
}
</style>
