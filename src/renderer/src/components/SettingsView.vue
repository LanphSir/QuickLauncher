<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NButton, NSwitch, NPopconfirm, useMessage } from 'naive-ui'
import AppIcon from './AppIcon.vue'
import HotkeyInput from './HotkeyInput.vue'
import ShortcutEdit from './ShortcutEdit.vue'
import ShortcutImport from './ShortcutImport.vue'
import { closeOverlay, openOverlay } from '../composables/useOverlay'
import type { IconName } from './icons'
import { useLauncherStore } from '../stores/launcher'

const emit = defineEmits<{ back: [] }>()
const message = useMessage()
const store = useLauncherStore()

const config = ref<LauncherConfig | null>(null)
const hotkeyDraft = ref('')

/** 设置分组：卡片一多就得滚着找，"快捷键 / 面板 / 应用 / 关于"分开更好定位 */
type SettingsTab = 'hotkeys' | 'panel' | 'apps' | 'about'
const tab = ref<SettingsTab>('hotkeys')
const bodyEl = ref<HTMLElement | null>(null)

const tabs = computed<{ key: SettingsTab; label: string; icon: IconName; badge: number }[]>(() => [
  { key: 'hotkeys', label: '快捷键', icon: 'zap', badge: 0 },
  { key: 'panel', label: '面板', icon: 'settings', badge: 0 },
  { key: 'apps', label: '应用', icon: 'grid', badge: store.plugins.length },
  { key: 'about', label: '关于', icon: 'info', badge: 0 }
])

// 切分组要回到顶部：上一个分组滚到一半，切过去会停在"空白"处
watch(tab, () => bodyEl.value?.scrollTo(0, 0))

/** 自定义外部应用（source='shortcut'）：它们和插件同表，只是这里单独一块管 */
const shortcutPlugins = computed(() => store.plugins.filter((p) => p.source === 'shortcut'))

function addShortcut(): void {
  let id = 0
  id = openOverlay({
    component: ShortcutEdit,
    label: 'shortcut-edit',
    // 打开就能填名称，不用先点一下输入框
    initialFocus: 'first',
    props: { entry: null, onClose: () => closeOverlay(id), onSaved: () => void store.load() }
  })
}

async function editShortcut(p: PluginSummary): Promise<void> {
  const entry = await window.panel.getShortcut(p.id)
  if (!entry) {
    message.error('没找到这个应用的配置，可能已被删除')
    await store.load()
    return
  }
  let id = 0
  id = openOverlay({
    component: ShortcutEdit,
    label: 'shortcut-edit',
    initialFocus: 'first',
    props: {
      entry,
      // 列表里已有图标 dataURL，直接复用当预览，省一次文件读取
      previewIcon: p.icon,
      onClose: () => closeOverlay(id),
      onSaved: () => void store.load()
    }
  })
}

function importShortcuts(): void {
  let id = 0
  id = openOverlay({
    component: ShortcutImport,
    label: 'shortcut-import',
    props: { onClose: () => closeOverlay(id), onImported: () => void store.load() }
  })
}

async function removeShortcut(p: PluginSummary): Promise<void> {
  const r = await window.panel.deleteShortcut(p.id)
  if (r.ok) {
    message.success(`已删除「${p.name}」`)
    await store.load()
  } else {
    message.error(r.message ?? '删除失败')
  }
}

/** 失焦行为三档：默认的"延迟"是给误触留的余地，不是反应慢 */
const BLUR_OPTIONS: { value: BlurBehavior; label: string; hint: string }[] = [
  { value: 'delay', label: '延迟收起', hint: '默认。移出去约 0.16 秒内点回来就不收起' },
  { value: 'immediate', label: '立即收起', hint: '传统的"点到外面就消失"' },
  { value: 'never', label: '不自动收起', hint: '只能按 Esc 或唤起快捷键隐藏' }
]

onMounted(async () => {
  config.value = await window.panel.getConfig()
  hotkeyDraft.value = config.value.hotkey
})

/** 「应用」按钮的文案：清空后是解绑，不是"应用一个空键" */
const hotkeyLabel = computed(() => {
  if (!config.value || hotkeyDraft.value === config.value.hotkey) return '应用'
  return hotkeyDraft.value ? '应用' : '清除'
})

/**
 * 应用唤起键。空值 = 解绑：允许"不用全局快捷键"（只用托盘/面板入口），
 * 主进程会把它从系统里注销，不会留下一个按了没反应的键。
 */
async function applyHotkey(): Promise<void> {
  if (!config.value) return
  if (hotkeyDraft.value === config.value.hotkey) return
  const result = await window.panel.updateConfig({ hotkey: hotkeyDraft.value })
  if (result.ok && result.config) {
    config.value = result.config
    message.success(
      hotkeyDraft.value ? '快捷键已更新，立即生效' : '已清除唤起快捷键，可从托盘图标打开面板'
    )
  } else {
    hotkeyDraft.value = config.value.hotkey
    message.error(result.message ?? '快捷键注册失败')
  }
}

async function clearHotkey(): Promise<void> {
  hotkeyDraft.value = ''
  await applyHotkey()
}

async function resetHotkey(): Promise<void> {
  const fallback = config.value?.defaultHotkey
  if (!fallback) {
    message.warning('拿不到默认快捷键，请手动按一个组合键')
    return
  }
  hotkeyDraft.value = fallback
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

async function setBlurBehavior(value: BlurBehavior): Promise<void> {
  if (!config.value || config.value.blurBehavior === value) return
  const result = await window.panel.updateConfig({ blurBehavior: value })
  if (result.ok && result.config) {
    config.value = result.config
    message.success('已保存，立即生效')
  } else {
    message.error(result.message ?? '设置失败')
  }
}

/**
 * 保存插件快捷键。全量重取插件列表的原因：注册结果（是否被占用）只有主进程知道，
 * 保存后必须把 hotkeyError 一起刷回来，否则界面显示"设上了"但实际没生效。
 */
async function savePluginHotkey(p: PluginSummary, accelerator: string): Promise<void> {
  const r = await window.panel.setPluginHotkey(p.id, accelerator)
  await store.load()
  if (r.ok) {
    message.success(accelerator ? `「${p.name}」快捷键已设为 ${accelerator}` : `已清除「${p.name}」的快捷键`)
  } else {
    message.error(r.message ?? '快捷键注册失败')
  }
}

async function clearPluginHotkey(p: PluginSummary): Promise<void> {
  await savePluginHotkey(p, '')
}

async function useSuggestion(p: PluginSummary): Promise<void> {
  if (p.hotkeySuggestion) await savePluginHotkey(p, p.hotkeySuggestion)
}

async function setPluginEnabled(p: PluginSummary, enabled: boolean): Promise<void> {
  const r = await window.panel.setPluginDisabled(p.id, !enabled)
  if (r.ok) message.success(enabled ? `已启用「${p.name}」` : `已停用「${p.name}」`)
  else message.error('操作失败')
}

async function uninstallPlugin(p: PluginSummary): Promise<void> {
  const r = await window.panel.uninstallPlugin(p.id)
  if (r.ok) message.success(r.message ?? '已卸载')
  else message.error(r.message ?? '卸载失败')
}

async function revealDir(p: PluginSummary): Promise<void> {
  await window.panel.revealPluginDir(p.id)
}
</script>

<template>
  <div class="settings">
    <header class="settings-header">
      <button class="back" @click="emit('back')">
        <AppIcon name="chevron-left" :size="16" />
        返回
      </button>
      <h2>设置</h2>
      <span class="spacer" />
    </header>

    <div v-if="config" class="settings-main">
      <!-- 左侧分组：卡片多了以后一屏放不下，按用途分开省得一路滚 -->
      <nav class="settings-nav">
        <button
          v-for="t in tabs"
          :key="t.key"
          class="nav-item"
          :class="{ active: tab === t.key }"
          @click="tab = t.key"
        >
          <AppIcon :name="t.icon" :size="15" />
          <span class="nav-label">{{ t.label }}</span>
          <span v-if="t.badge" class="nav-badge">{{ t.badge }}</span>
        </button>
      </nav>

      <div ref="bodyEl" class="settings-body">
        <template v-if="tab === 'hotkeys'">
          <section class="card">
            <h3>唤起快捷键</h3>
            <div class="row">
              <HotkeyInput v-model="hotkeyDraft" placeholder="按下组合键" @invalid="(m) => message.warning(m)" />
              <NButton
                size="small"
                :type="hotkeyDraft ? 'primary' : 'default'"
                :disabled="hotkeyDraft === config.hotkey"
                @click="applyHotkey"
              >
                {{ hotkeyLabel }}
              </NButton>
              <NButton size="small" quaternary @click="resetHotkey">恢复默认</NButton>
              <button
                v-if="config.hotkey"
                class="p-act clear-hotkey"
                title="清除唤起快捷键（之后只能用托盘打开）"
                @click="clearHotkey"
              >
                <AppIcon name="x" :size="14" />
              </button>
            </div>
            <p v-if="!config.hotkey" class="hint warn">
              当前没有全局唤起键：只能通过托盘图标或「全部应用」页打开面板。
              想恢复点「恢复默认」，或在框里按一个新组合键。
            </p>
            <p class="hint">
              点击输入框后直接按下组合键（默认 {{ config.defaultHotkey ?? 'Ctrl+Shift+Space' }}）。
              退格或「清除」可解绑，允许完全不用全局快捷键；若与其他程序冲突会提示。
            </p>
          </section>

          <section class="card">
            <div class="card-head">
              <h3>插件快捷键</h3>
              <span class="count">{{ store.plugins.filter((x) => x.hotkey).length }} / {{ store.plugins.length }}</span>
            </div>
            <div v-for="p in store.plugins" :key="p.id" class="hotkey-row">
              <div class="p-icon">
                <img v-if="p.icon" :src="p.icon" alt="" draggable="false" />
                <span v-else class="p-fallback"><AppIcon name="grid" :size="14" /></span>
              </div>
              <div class="hk-info">
                <div class="p-name">
                  {{ p.name }}
                  <span v-if="p.type === 'external'" class="p-tag ext">外部程序</span>
                </div>
                <div v-if="p.hotkeyError" class="hk-error">{{ p.hotkeyError }}</div>
                <div v-else-if="!p.hotkey && p.hotkeySuggestion" class="hk-suggest">
                  作者建议
                  <button class="link" @click="useSuggestion(p)">{{ p.hotkeySuggestion }}</button>
                </div>
                <div v-else-if="p.disabled && p.hotkey" class="hk-muted">插件已停用，快捷键暂不生效</div>
                <div v-else class="hk-muted">
                  {{ p.hotkey ? (p.type === 'external' ? '按下即启动程序' : '按下即打开插件') : '未设置' }}
                </div>
              </div>
              <div class="hk-actions">
                <HotkeyInput
                  :model-value="p.hotkey ?? ''"
                  :disabled="p.disabled"
                  placeholder="未设置"
                  @update:model-value="(v: string) => savePluginHotkey(p, v)"
                  @invalid="(m: string) => message.warning(m)"
                />
                <button v-if="p.hotkey" class="p-act" title="清除快捷键" @click="clearPluginHotkey(p)">
                  <AppIcon name="x" :size="14" />
                </button>
              </div>
            </div>
            <p class="hint">
              给常用插件挂一个全局键：按下直接打开（外部程序型直接启动），不用先唤起面板。
              在框里按退格、或点右侧 × 即可清除；与唤起键或其他插件重复时会提示。
            </p>
          </section>
        </template>

        <template v-else-if="tab === 'panel'">
          <section class="card">
            <h3>面板行为</h3>
            <div class="row-title">点到面板外面时</div>
            <div class="seg">
              <button
                v-for="opt in BLUR_OPTIONS"
                :key="opt.value"
                class="seg-item"
                :class="{ active: config.blurBehavior === opt.value }"
                :title="opt.hint"
                @click="setBlurBehavior(opt.value)"
              >
                {{ opt.label }}
              </button>
            </div>
            <p class="hint">
              {{ BLUR_OPTIONS.find((o) => o.value === config.blurBehavior)?.hint }}。
              弹窗、右键菜单打开期间一律不收起，与这项设置无关。
            </p>
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
        </template>

        <template v-else-if="tab === 'apps'">
          <section class="card">
            <div class="card-head">
              <h3>外部应用</h3>
              <div class="card-actions">
                <NButton size="tiny" @click="addShortcut">
                  <template #icon><AppIcon name="plus" :size="12" /></template>
                  添加
                </NButton>
                <NButton size="tiny" quaternary @click="importShortcuts">从系统导入</NButton>
              </div>
            </div>
            <div v-for="p in shortcutPlugins" :key="p.id" class="shortcut-row">
              <div class="p-icon">
                <img v-if="p.icon" :src="p.icon" alt="" draggable="false" />
                <span v-else class="p-fallback"><AppIcon name="grid" :size="14" /></span>
              </div>
              <div class="p-info">
                <div class="p-name">{{ p.name }}</div>
                <div class="p-id">{{ p.command || p.id }}</div>
              </div>
              <div class="p-actions">
                <button class="p-act" title="编辑" @click="editShortcut(p)">
                  <AppIcon name="pencil" :size="14" />
                </button>
                <NPopconfirm @positive-click="removeShortcut(p)">
                  <template #trigger>
                    <button class="p-act danger" title="删除"><AppIcon name="trash" :size="14" /></button>
                  </template>
                  删除「{{ p.name }}」？只是从启动器移除，不会动硬盘上的程序。
                </NPopconfirm>
                <NSwitch
                  size="small"
                  :value="!p.disabled"
                  @update:value="(v: boolean) => setPluginEnabled(p, v)"
                />
              </div>
            </div>
            <p v-if="!shortcutPlugins.length" class="hint">
              还没有自定义应用。能接 exe、快捷方式（.lnk）、网址，也能一键从开始菜单/桌面导入。
            </p>
            <p class="hint">
              存在 <code>%APPDATA%/quick-launcher/shortcuts.json</code>，可备份、可手改；
              删除只从启动器移除，不碰硬盘上的程序。
            </p>
          </section>

          <section class="card">
            <h3>插件管理</h3>
            <div v-for="p in store.plugins" :key="p.id" class="plugin-row">
              <div class="p-icon">
                <img v-if="p.icon" :src="p.icon" alt="" draggable="false" />
                <span v-else class="p-fallback"><AppIcon name="grid" :size="14" /></span>
              </div>
              <div class="p-info">
                <div class="p-name">
                  {{ p.name }}
                  <span v-if="p.source === 'installed'" class="p-tag installed">已安装</span>
                  <span v-if="p.source === 'shortcut'" class="p-tag shortcut">自定义</span>
                  <span v-if="p.type === 'external'" class="p-tag ext">外部程序</span>
                </div>
                <div class="p-id">{{ p.id }}</div>
              </div>
              <div class="p-actions">
                <button v-if="p.source !== 'shortcut'" class="p-act" title="打开插件目录" @click="revealDir(p)">
                  <AppIcon name="folder" :size="14" />
                </button>
                <NPopconfirm v-if="p.source === 'installed'" @positive-click="uninstallPlugin(p)">
                  <template #trigger>
                    <button class="p-act danger" title="卸载"><AppIcon name="trash" :size="14" /></button>
                  </template>
                  卸载「{{ p.name }}」？（插件文件删除，数据保留）
                </NPopconfirm>
                <NSwitch
                  size="small"
                  :value="!p.disabled"
                  @update:value="(v: boolean) => setPluginEnabled(p, v)"
                />
              </div>
            </div>
            <p class="hint">
              手动把含 plugin.json 的目录（或其 dist/）放入
              <code>%APPDATA%/quick-launcher/plugins/installed/</code> 后重启即可生效；
              也可在"全部应用"页从目录/ZIP 安装。
            </p>
          </section>
        </template>

        <template v-else>
          <section class="card">
            <h3>关于</h3>
            <p class="hint">
              QuickLauncher v0.4.14 — 全局快捷键唤起的插件化工具面板。<br />
              Electron + Vue 3 · 插件进程级隔离 · 自定义插件协议（见 docs/plugin-dev-guide.md）
            </p>
          </section>
        </template>
      </div>
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

.settings-main {
  flex: 1;
  min-height: 0;
  display: flex;
}

/* 侧栏：只放分组入口，宽度固定，内容区自己滚 */
.settings-nav {
  flex: none;
  /* 118 是"应用 + 数字徽标"不被截断的最小值，别再往回收 */
  width: 118px;
  padding: 2px 8px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-right: 1px solid #f2f3f5;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 8px;
  border-radius: 8px;
  font-size: 13px;
  color: #646a73;
  text-align: left;
}

.nav-item:hover {
  background: #f5f6f7;
  color: #1f2329;
}

.nav-item.active {
  background: #eef0ff;
  color: #4f46e5;
  font-weight: 500;
}

.nav-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nav-badge {
  flex: none;
  font-size: 10px;
  line-height: 16px;
  padding: 0 5px;
  border-radius: 999px;
  background: #f2f3f5;
  color: #8f959e;
}

.nav-item.active .nav-badge {
  background: #dfe3ff;
  color: #4f46e5;
}

.settings-body {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 6px 18px 18px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.count {
  font-size: 11px;
  color: #a1a6ad;
  font-variant-numeric: tabular-nums;
}

.clear-hotkey {
  margin-left: -4px;
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
  /* 面板最窄 520px：唤起键一行放着 HotkeyInput + 应用 + 恢复默认 + 清除，
     不换行就会互相压住（按钮叠在按键标签上） */
  flex-wrap: wrap;
  gap: 8px 10px;
}

.row > * {
  flex: none;
}

.row.space {
  justify-content: space-between;
}

.row-title {
  font-size: 14px;
}

.seg {
  display: inline-flex;
  gap: 4px;
  margin-top: 10px;
  padding: 3px;
  border-radius: 9px;
  background: #f5f6f7;
}

.seg-item {
  padding: 5px 12px;
  border-radius: 7px;
  font-size: 12.5px;
  color: #646a73;
}

.seg-item:hover {
  color: #1f2329;
}

.seg-item.active {
  background: #fff;
  color: #1f2329;
  font-weight: 500;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.card-head h3 {
  flex: 1;
  margin-bottom: 0;
}

.card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.shortcut-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px solid #f5f6f7;
}

.shortcut-row:last-of-type {
  border-bottom: none;
}

.hint code {
  font-family: ui-monospace, Consolas, monospace;
  padding: 1px 4px;
  border-radius: 4px;
  background: #f2f3f5;
}

.hotkey-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px solid #f5f6f7;
}

.hotkey-row:last-of-type {
  border-bottom: none;
}

.hk-info {
  flex: 1;
  min-width: 0;
}

.hk-error {
  margin-top: 2px;
  font-size: 11px;
  color: #d5304f;
}

.hk-muted {
  margin-top: 2px;
  font-size: 11px;
  color: #a1a6ad;
}

.hk-suggest {
  margin-top: 2px;
  font-size: 11px;
  color: #8f959e;
  display: flex;
  align-items: center;
  gap: 5px;
}

.hk-suggest .link {
  font-size: 11px;
  font-family: inherit;
  color: #6366f1;
  padding: 0 4px;
  border-radius: 4px;
  background: #eef0ff;
}

.hk-suggest .link:hover {
  background: #e0e3ff;
}

.hk-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
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

.plugin-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 0;
  border-bottom: 1px solid #f5f6f7;
}

.plugin-row:last-of-type {
  border-bottom: none;
}

.p-icon {
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  overflow: hidden;
}

.p-icon img {
  width: 24px;
  height: 24px;
  object-fit: contain;
}

.p-fallback {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  color: #fff;
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
}

.p-info {
  flex: 1;
  min-width: 0;
}

.p-name {
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.p-tag {
  font-size: 10px;
  padding: 0.5px 6px;
  border-radius: 999px;
  background: #e8f7ef;
  color: #0a7d43;
}

.p-tag.ext {
  background: #fef3e2;
  color: #b25e09;
}

.p-tag.shortcut {
  background: #eef0ff;
  color: #4f46e5;
}

.p-id {
  font-size: 11px;
  color: #a1a6ad;
  font-family: ui-monospace, Consolas, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.p-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
}

.p-act {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  color: #646a73;
}

.p-act:hover {
  background: #f2f3f5;
  color: #1f2329;
}

.p-act.danger:hover {
  color: #d5304f;
  background: #fdecef;
}
</style>
