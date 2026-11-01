import { ipcMain } from 'electron'
import { PLUGIN_PERMS } from '../../shared/pluginApi'
import { getCaller } from './callerRegistry'
import { apiDefs, assertUniqueChannels, type ApiDefinition } from './api'

/**
 * 插件 API 网关：对每个通道统一执行身份锚定、权限/功能校验、入参校验。
 *
 * 本文件不再出现任何具体通道名：能力定义在 plugin/api/ 下逐个声明，权限来自
 * shared/pluginApi 的 PLUGIN_PERMS，功能要求来自定义里的 feature，
 * 入参校验来自定义里的 parse。
 * 这样"注册了通道忘挂权限""实现与类型对不上"这两类漂移在结构上就不可能发生。
 *
 * 权限与功能是两回事：
 * - 权限（permissions）= 能调用哪些系统能力，缺失即拒绝；
 * - 功能（features）  = 以哪种形态参与启动器（如 inline），缺失只影响该形态。
 */
function register([channel, def]: ApiDefinition): void {
  ipcMain.handle(channel, async (event, payload: unknown) => {
    const rec = getCaller(event.sender)
    if (!rec) throw new Error('gateway: 未注册的调用方')

    const perm = PLUGIN_PERMS[channel]
    if (perm && !(rec.manifest.permissions ?? []).includes(perm)) {
      throw new Error(`插件 ${rec.manifest.id} 缺少权限: ${perm}（请在 plugin.json 的 permissions 中声明）`)
    }

    if (def.feature && !(rec.manifest.features ?? []).includes(def.feature)) {
      throw new Error(
        `插件 ${rec.manifest.id} 缺少功能声明: ${def.feature}（请在 plugin.json 的 features 中声明）`
      )
    }

    const input = def.parse ? def.parse(payload) : payload
    return def.handle({ rec, sender: event.sender }, input)
  })
}

export function initGateway(): void {
  assertUniqueChannels(apiDefs)
  for (const def of apiDefs) register(def)
  console.log(`[gateway] 已注册 ${apiDefs.length} 个插件 API 通道`)
}
