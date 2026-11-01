<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, useMessage } from 'naive-ui'
import AppIcon from './AppIcon.vue'

/**
 * 自定义外部应用的编辑表单（内容组件，遮罩/Esc/焦点由 OverlayHost 统一管）。
 *
 * `entry` 为 null 表示新建。图标这里只存"用哪种 + 源路径"，
 * 真正的文件复制在主进程保存时做（那时才知道最终 id）。
 */
const props = defineProps<{
  entry: ShortcutEntry | null
  /** 编辑已有应用时先用列表里的图标做预览（省一次读取） */
  previewIcon?: string | null
}>()
const emit = defineEmits<{ close: []; saved: [] }>()

const message = useMessage()

const name = ref(props.entry?.name ?? '')
const command = ref(props.entry?.command ?? '')
const argsText = ref((props.entry?.args ?? []).join(' '))
const workDir = ref(props.entry?.workDir ?? '')
const keywords = ref((props.entry?.keywords ?? []).join(' '))
const description = ref(props.entry?.description ?? '')
const iconKind = ref<ShortcutEntry['icon']['kind']>(props.entry?.icon.kind ?? 'auto')
const iconPath = ref(props.entry?.icon.path ?? '')
/** 刚选的新图预览（保存前先用它显示） */
const pickedPreview = ref<string | null>(null)
const saving = ref(false)
const pickingIcon = ref(false)
const pickingDir = ref(false)

const preview = computed(() => {
  if (pickedPreview.value) return pickedPreview.value
  return iconKind.value === 'none' ? null : (props.previewIcon ?? null)
})
const isShortcut = computed(() => /\.lnk$/i.test(command.value.trim()))
const canSave = computed(() => !!name.value.trim() && !!command.value.trim() && !saving.value)

async function browseCommand(): Promise<void> {
  const r = await window.panel.pickCommand()
  if (r.canceled) return
  if (!r.ok || !r.path) {
    message.error(r.message ?? '没能选到文件')
    return
  }
  command.value = r.path
  // 名称还空着就顺手填上，省一次输入
  if (!name.value.trim()) {
    const base = r.path.split(/[\\/]/).pop() ?? ''
    name.value = base.replace(/\.[^.]+$/, '')
  }
}

async function browseWorkDir(): Promise<void> {
  if (pickingDir.value) return
  pickingDir.value = true
  try {
    const r = await window.panel.pickDirectory()
    if (r.canceled) return
    if (!r.ok || !r.path) {
      message.error(r.message ?? '没能选到目录')
      return
    }
    workDir.value = r.path
  } finally {
    pickingDir.value = false
  }
}

async function pickIcon(): Promise<void> {
  if (pickingIcon.value) return
  pickingIcon.value = true
  try {
    const r = await window.panel.pickIconImage()
    if (r.canceled) return
    if (!r.ok || !r.path) {
      message.error(r.message ?? '没能选到图片')
      return
    }
    iconKind.value = 'file'
    iconPath.value = r.path
    pickedPreview.value = r.dataUrl ?? null
  } finally {
    pickingIcon.value = false
  }
}

async function save(): Promise<void> {
  if (!canSave.value) return
  saving.value = true
  try {
    const r = await window.panel.saveShortcut({
      id: props.entry?.id,
      name: name.value,
      command: command.value,
      args: argsText.value,
      workDir: workDir.value,
      keywords: keywords.value,
      description: description.value,
      icon: iconKind.value === 'file' ? { kind: 'file', path: iconPath.value } : { kind: iconKind.value }
    })
    if (r.ok) {
      message.success(props.entry ? '已保存' : `已添加「${name.value.trim()}」`)
      emit('saved')
      emit('close')
    } else {
      message.error(r.message ?? '保存失败')
    }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="modal">
    <header class="head">
      <h2>{{ entry ? '编辑应用' : '添加外部应用' }}</h2>
      <button class="close" title="关闭" @click="emit('close')">
        <AppIcon name="x" :size="16" />
      </button>
    </header>
    <p class="desc">
      把任意程序 / 快捷方式 / 网址接进面板：可搜索、可固定、可挂快捷键，和内置插件用起来一样。
    </p>

    <div class="form">
      <div class="top">
        <div class="icon-cell">
          <img v-if="preview" :src="preview" alt="" draggable="false" />
          <span v-else class="icon-empty"><AppIcon name="grid" :size="20" /></span>
          <button class="icon-btn" title="选择图片" @click="pickIcon">
            <AppIcon name="pencil" :size="12" />
          </button>
        </div>
        <div class="top-fields">
          <label>名称</label>
          <input v-model="name" class="field" type="text" spellcheck="false" placeholder="例如：VS Code" />
        </div>
      </div>

      <label>启动命令<span class="req">*</span></label>
      <div class="field-row">
        <input
          v-model="command"
          class="field mono"
          type="text"
          spellcheck="false"
          placeholder="C:/Program Files/.../app.exe 或 notepad"
        />
        <NButton size="small" class="browse" @click="browseCommand">
          <template #icon><AppIcon name="folder" :size="13" /></template>
          浏览…
        </NButton>
      </div>

      <label>启动参数 <span class="opt">（空格分隔，可留空）</span></label>
      <input v-model="argsText" class="field mono" type="text" spellcheck="false" placeholder="--new-window" />
      <p v-if="isShortcut" class="hint warn">
        快捷方式由系统打开，上面的启动参数不会生效；需要参数请直接选目标程序。
      </p>

      <label>工作目录 <span class="opt">（有些程序必须从自己目录启动）</span></label>
      <div class="field-row">
        <input v-model="workDir" class="field mono" type="text" spellcheck="false" placeholder="留空 = 使用系统默认" />
        <NButton size="small" class="browse" @click="browseWorkDir">
          <template #icon><AppIcon name="folder" :size="13" /></template>
          选择…
        </NButton>
      </div>

      <div class="two-col">
        <div class="col">
          <label>关键词 <span class="opt">（帮助搜到它）</span></label>
          <input v-model="keywords" class="field" type="text" spellcheck="false" placeholder="vscode, 编辑器" />
        </div>
        <div class="col">
          <label>描述 <span class="opt">（可留空）</span></label>
          <input v-model="description" class="field" type="text" spellcheck="false" placeholder="一句话说明" />
        </div>
      </div>

      <label>图标</label>
      <div class="icon-modes">
        <button
          v-for="mode in ([
            { value: 'auto', label: '自动提取', hint: '程序图标；网址抓 favicon' },
            { value: 'file', label: '自定义图片', hint: 'png / ico / jpg / svg' },
            { value: 'none', label: '不用图标', hint: '显示首字母' }
          ] as const)"
          :key="mode.value"
          class="mode"
          :class="{ active: iconKind === mode.value }"
          :title="mode.hint"
          @click="iconKind = mode.value"
        >
          {{ mode.label }}
        </button>
        <button v-if="iconKind === 'file'" class="pick" @click="pickIcon">
          {{ iconPath ? '换一张…' : '选图片…' }}
        </button>
      </div>
      <p v-if="iconKind === 'auto'" class="hint">自动提取失败时会退回"首字母 + 配色"，不会留空白。</p>
    </div>

    <footer class="foot">
      <NButton size="small" type="primary" :disabled="!canSave" :loading="saving" @click="save">保存</NButton>
      <NButton size="small" quaternary @click="emit('close')">取消</NButton>
    </footer>
  </div>
</template>

<style scoped>
.modal {
  width: 480px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 72px);
  display: flex;
  flex-direction: column;
  /* 表单比面板高时只让中间那块滚：头部和"保存"始终在原地，不会遮住字段 */
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

.form label {
  margin-top: 6px;
  font-size: 12px;
  color: #646a73;
}

.req {
  color: #d5304f;
  margin-left: 2px;
}

.opt {
  color: #a1a6ad;
  font-size: 11px;
}

.two-col {
  display: flex;
  gap: 10px;
}

.col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.col label {
  margin-top: 6px;
}

.top {
  display: flex;
  gap: 12px;
  align-items: center;
}

.icon-cell {
  position: relative;
  flex: none;
  width: 46px;
  height: 46px;
  border-radius: 12px;
  border: 1px solid #eceeef;
  display: grid;
  place-items: center;
  overflow: hidden;
  background: #fafbfc;
}

.icon-cell img {
  width: 34px;
  height: 34px;
  object-fit: contain;
}

.icon-empty {
  color: #c9ccd1;
}

.icon-btn {
  position: absolute;
  right: 0;
  bottom: 0;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 6px 0 0 0;
  background: rgba(31, 35, 41, 0.55);
  color: #fff;
}

.icon-btn:hover {
  background: rgba(31, 35, 41, 0.8);
}

.top-fields {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.top-fields label {
  margin-top: 0;
}

.field-row {
  display: flex;
  gap: 8px;
}

.field-row .field {
  flex: 1;
  min-width: 0;
}

.browse {
  flex: none;
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

.hint {
  font-size: 11.5px;
  line-height: 1.5;
  color: #a1a6ad;
}

.hint.warn {
  color: #d48806;
}

.icon-modes {
  display: flex;
  gap: 6px;
  align-items: center;
}

.mode {
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid #dfe1e4;
  font-size: 12px;
  color: #646a73;
}

.mode.active {
  border-color: #6366f1;
  color: #4f46e5;
  background: #eef0ff;
}

.pick {
  font-size: 12px;
  color: #6366f1;
  padding: 5px 8px;
  border-radius: 8px;
}

.pick:hover {
  background: #eef0ff;
}

.foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #f0f1f3;
}
</style>
