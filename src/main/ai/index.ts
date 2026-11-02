/**
 * AI 模块入口：装配配置、注册设置页用的 panel:ai-* 通道。
 *
 * 插件页（对话界面）不经过这里——它走 plugin/* 契约通道 + 网关，
 * 只有核心渲染层（设置页）才用 panel:ai-*。两套分开的原因见 CLAUDE.md 铁律：
 * 插件永远走网关，核心页面才直连 IPC。
 */
import { ipcMain } from 'electron'
import { loadAiConfig, saveProvider, deleteProvider, setDefaultModel, settingsView, testProvider } from './settings'
import { stopAll } from './chat'
import { listToolPlugins, setToolGrant } from './tools'
import { decideMcpServer, listMcpServers, shutdownMcp } from './mcpManager'
import type { ProviderInput } from './settings'

export function initAi(): void {
  loadAiConfig()

  ipcMain.handle('panel:ai-get-settings', () => settingsView())
  ipcMain.handle('panel:ai-save-provider', (_event, input: ProviderInput) =>
    saveProvider({
      id: typeof input?.id === 'string' ? input.id : undefined,
      presetId: typeof input?.presetId === 'string' ? input.presetId : undefined,
      name: String(input?.name ?? ''),
      baseURL: String(input?.baseURL ?? ''),
      models: Array.isArray(input?.models) ? input.models : [],
      apiKey: typeof input?.apiKey === 'string' ? input.apiKey : undefined,
      keyless: input?.keyless === true,
      contextWindow: typeof input?.contextWindow === 'number' ? input.contextWindow : undefined,
      visionModels: Array.isArray(input?.visionModels)
        ? input.visionModels.filter((m): m is string => typeof m === 'string')
        : undefined
    })
  )
  ipcMain.handle('panel:ai-delete-provider', (_event, id: string) => deleteProvider(String(id)))
  ipcMain.handle('panel:ai-test-provider', (_event, id: string) => testProvider(String(id)))
  ipcMain.handle('panel:ai-set-default-model', (_event, id: string) => setDefaultModel(String(id)))

  // 插件工具目录（v0.6.2）：设置页据此展示「谁声明了什么」并逐插件授权。
  // 每次调用都重新算：插件可能刚装上/停用，缓存按文件指纹失效，代价是一次 stat。
  ipcMain.handle('panel:ai-tools', () => listToolPlugins())
  ipcMain.handle('panel:ai-set-tool-grant', (_event, payload: { pluginId?: unknown; granted?: unknown }) =>
    setToolGrant(String(payload?.pluginId ?? ''), payload?.granted === true)
  )

  // MCP（v0.6.4）：列出「有插件想执行哪些命令」，由用户逐条批准。
  // 读的是声明与 config，不启动任何进程——真正的 spawn 发生在批准之后。
  ipcMain.handle('panel:ai-mcp', () => listMcpServers())
  ipcMain.handle(
    'panel:ai-mcp-decision',
    (_event, payload: { pluginId?: unknown; server?: unknown; allow?: unknown }) =>
      decideMcpServer(String(payload?.pluginId ?? ''), String(payload?.server ?? ''), payload?.allow === true)
  )

  const providers = settingsView().providers.length
  console.log(`[ai] 已初始化，provider ${providers} 个`)
}

/** 退出时取消所有在飞的请求，并收掉 MCP 子进程（否则会留下孤儿 node 进程） */
export function shutdownAi(): void {
  stopAll()
  void shutdownMcp()
}
