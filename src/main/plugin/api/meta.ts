import { PLUGIN_PERMISSIONS, type PluginPermission } from '../../../shared/pluginApi'
import { defineApi } from './define'

const KNOWN = new Set<string>(PLUGIN_PERMISSIONS)

/** 自述信息：manifest 里的权限可能含历史/拼错的值，回给插件前先过滤成已知集合 */
export const metaApi = [
  defineApi('plugin:info', {
    handle: ({ rec }) => ({
      id: rec.manifest.id,
      name: rec.manifest.name,
      version: rec.manifest.version,
      permissions: (rec.manifest.permissions ?? []).filter((p): p is PluginPermission => KNOWN.has(p))
    })
  })
]
