<script setup lang="ts">
/**
 * MCP 命令确认弹窗（v0.6.4）。
 *
 * 这个弹窗存在的唯一理由：让用户**在真正执行之前**看清那串命令。
 * 所以布局上的取舍很明确——命令行放最大字号、完整不截断、不折叠；
 * 「允许」不是默认按钮，Esc 与「拒绝」都在更顺手的位置。
 */
import { computed, ref } from 'vue'
import { NButton } from 'naive-ui'
import AppIcon from './AppIcon.vue'

const props = defineProps<{
  target: AiMcpServerView
  /** 这条命令之前被批准过、但被改动了（state === 'stale'） */
  onClose?: () => void
  onDecided?: (allow: boolean, message?: string) => void
}>()

const busy = ref(false)
const error = ref('')

const stale = computed(() => props.target.state === 'stale')
const envKeys = computed(() => props.target.envKeys)

async function decide(allow: boolean): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await window.panel.aiMcpDecision(props.target.pluginId, props.target.server, allow)
    if (!result.ok) {
      // 批准失败（命令起不来）也要关窗：原因交给父组件提示，留在这里只会重复点
      props.onDecided?.(allow, result.message)
      return
    }
    props.onDecided?.(allow)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="modal">
    <header class="head">
      <h2>{{ stale ? '命令已改动，请重新确认' : '允许执行这条命令？' }}</h2>
      <button class="close" title="关闭（按拒绝处理）" @click="props.onClose?.()">
        <AppIcon name="x" :size="16" />
      </button>
    </header>

    <p class="desc">
      「{{ target.pluginName }}」想通过 MCP 启动下面这个程序。它会在你的电脑上以<strong>你的用户权限</strong>运行，
      不是沙箱，也不是只读——能做什么取决于这个程序本身。
    </p>

    <div class="cmd">
      <div class="cmd-line">{{ target.commandLine || '(命令为空)' }}</div>
      <dl class="cmd-meta">
        <template v-if="envKeys.length">
          <dt>环境变量</dt>
          <dd class="mono">{{ envKeys.join('、') }}</dd>
        </template>
        <template v-if="target.cwd">
          <dt>工作目录</dt>
          <dd class="mono">{{ target.cwd }}（插件目录内）</dd>
        </template>
        <template v-if="target.timeoutMs">
          <dt>单次超时</dt>
          <dd>{{ Math.round(target.timeoutMs / 1000) }} 秒</dd>
        </template>
      </dl>
    </div>

    <p class="warn">
      <template v-if="stale">
        这条命令和你上次批准的不一样了（参数或环境变量被改过），所以旧批准不再作数。
      </template>
      <template v-else>
        批准绑定的是<strong>这串命令本身</strong>：插件以后改了任何参数，都会重新问你一次。
      </template>
    </p>

    <p v-if="error" class="err">{{ error }}</p>

    <footer class="foot">
      <NButton size="small" :loading="busy" @click="decide(false)">拒绝</NButton>
      <span class="spacer" />
      <NButton size="small" type="error" secondary :loading="busy" @click="decide(true)">允许执行</NButton>
    </footer>
  </div>
</template>

<style scoped>
.modal {
  width: 520px;
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
  font-size: 15.5px;
  font-weight: 600;
  color: #1f2329;
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
  line-height: 1.65;
}

.cmd {
  flex: none;
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid #eceeef;
  border-radius: 10px;
  background: #fafbfc;
}

.cmd-line {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.6;
  color: #1f2329;
  word-break: break-all;
  /* 命令可能很长，但绝不截断：看不全就等于没确认 */
  max-height: 160px;
  overflow-y: auto;
}

.cmd-meta {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 10px;
  margin: 8px 0 0;
  font-size: 11.5px;
  color: #8f959e;
}

.cmd-meta dt {
  color: #a1a6ad;
}

.cmd-meta dd {
  margin: 0;
  word-break: break-all;
}

.warn {
  flex: none;
  margin-top: 10px;
  font-size: 12px;
  color: #b25d09;
  line-height: 1.65;
}

.err {
  flex: none;
  margin-top: 8px;
  font-size: 12px;
  color: #c0392b;
}

.foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
}

.spacer {
  flex: 1;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}
</style>
