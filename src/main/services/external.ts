import { spawn } from 'node:child_process'
import { shell } from 'electron'
import type { PluginRecord } from '../plugin/manager'

/** 拉起 external 型插件：URL 用默认浏览器打开，命令行用子进程启动（分离、不随主程序退出） */
export function launchExternalPlugin(rec: PluginRecord): { ok: boolean; message?: string } {
  const command = rec.manifest.command!
  const args = rec.manifest.args ?? []
  if (/^https?:\/\//i.test(command)) {
    void shell.openExternal(command)
    return { ok: true }
  }
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.on('error', (err) => {
      console.error(`[external] 启动失败 ${command}`, err)
    })
    child.unref()
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[external] 启动失败 ${command}`, message)
    return { ok: false, message: `无法启动: ${command}` }
  }
}
