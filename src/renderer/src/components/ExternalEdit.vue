<script setup lang="ts">
import { ref } from 'vue'
import { NButton, useMessage } from 'naive-ui'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ plugin: PluginSummary }>()
const emit = defineEmits<{ close: []; saved: [] }>()

const message = useMessage()
const command = ref(props.plugin.command ?? '')
const argsText = ref((props.plugin.args ?? []).join(' '))

async function save(): Promise<void> {
  const r = await window.panel.savePluginOverride(props.plugin.id, {
    command: command.value,
    args: argsText.value
  })
  if (r.ok) {
    message.success(command.value.trim() ? '启动命令已更新' : '已恢复默认命令')
    emit('saved')
    emit('close')
  } else {
    message.error(r.message ?? '保存失败')
  }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal">
      <header class="head">
        <h2>编辑启动命令</h2>
        <button class="close" title="关闭" @click="emit('close')">
          <AppIcon name="x" :size="16" />
        </button>
      </header>
      <p class="desc">
        覆盖「{{ plugin.name }}」的启动配置（保存在全局配置中，插件文件不会被修改）。命令留空保存即恢复默认。
      </p>
      <div class="form">
        <label>启动命令（exe 路径、命令或 http(s) 链接）</label>
        <input v-model="command" class="field mono" type="text" spellcheck="false" placeholder="C:/Program Files/.../app.exe" />
        <label>启动参数（空格分隔）</label>
        <input v-model="argsText" class="field mono" type="text" spellcheck="false" placeholder="--new-window" />
      </div>
      <footer class="foot">
        <NButton size="small" type="primary" @click="save">保存</NButton>
        <NButton size="small" quaternary @click="emit('close')">取消</NButton>
        <span class="spacer" />
        <NButton v-if="command.trim()" size="small" quaternary @click="command = ''; argsText = ''">
          恢复默认
        </NButton>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: rgba(15, 18, 25, 0.32);
  display: grid;
  place-items: center;
}

.modal {
  width: 440px;
  max-width: calc(100vw - 48px);
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
  margin-top: 8px;
  font-size: 12.5px;
  color: #8f959e;
  line-height: 1.6;
}

.form {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form label {
  font-size: 12px;
  color: #646a73;
}

.field {
  height: 34px;
  padding: 0 10px;
  border: 1px solid #dfe1e4;
  border-radius: 8px;
  outline: none;
  font-size: 12.5px;
  color: #1f2329;
}

.field:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
}

.mono {
  font-family: ui-monospace, Consolas, monospace;
}

.foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 18px;
}

.spacer {
  flex: 1;
}
</style>
