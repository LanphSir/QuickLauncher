import { spawn, type ChildProcess } from 'node:child_process'
import { shell } from 'electron'
import type { PluginRecord } from '../plugin/manager'

const SPAWN_OPTS = { detached: true, stdio: 'ignore' as const, windowsHide: true }

/** cmd 里带空格/引号的片段一律加双引号（Windows 路径本身不含 `"`，不用再转义） */
function quote(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg}"` : arg
}

/** 走 cmd 解释一整行：批处理这类"不是可执行文件"的目标只能这么起 */
function runShellLine(line: string): ChildProcess {
  return spawn(line, { ...SPAWN_OPTS, shell: true })
}

/**
 * 拉起 external 型插件：
 * - http(s) 链接交给默认浏览器；
 * - `.bat` / `.cmd` 必须经 cmd 解释（直接 spawn 是 EINVAL，用户只会看到"点了没反应"）；
 * - `.lnk` 交给系统 ShellExecute（快捷方式不是可执行文件，spawn 会 ENOENT，参数也透传不了）；
 * - 其余（exe/com 或 PATH 里的命令名）直接 spawn，参数按数组传，路径带空格也不用引号。
 */
export function launchExternalPlugin(rec: PluginRecord): { ok: boolean; message?: string } {
  const command = rec.manifest.command!
  const args = rec.manifest.args ?? []
  if (/^https?:\/\//i.test(command)) {
    void shell.openExternal(command)
    return { ok: true }
  }
  const lower = command.toLowerCase()
  if (lower.endsWith('.lnk')) {
    void shell.openPath(command)
    return { ok: true }
  }
  try {
    const child =
      lower.endsWith('.bat') || lower.endsWith('.cmd')
        ? runShellLine([quote(command), ...args.map(quote)].join(' '))
        : spawn(command, args, SPAWN_OPTS)
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
