/**
 * API Key 的唯一落脚点。
 *
 * 三条规矩：
 * 1. 明文只在主进程内存里出现，落盘一律 safeStorage 加密（Windows 走 DPAPI，
 *    换机器/换用户都解不开）；
 * 2. 渲染层与插件页只能拿到掩码 `sk-…a1b2`，接口层直接把 key 字段抹掉；
 * 3. 系统不支持加密时**拒绝保存**并说清原因，而不是偷偷明文写盘——
 *    用户以为加密了、实际没有，比存不上更糟。
 */
import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

interface SecretsFile {
  version: 1
  /** ref → base64(密文) */
  keys: Record<string, string>
}

function aiDir(): string {
  return join(app.getPath('userData'), 'ai')
}

function secretsFile(): string {
  return join(aiDir(), 'secrets.bin')
}

function readAll(): SecretsFile {
  try {
    if (!existsSync(secretsFile())) return { version: 1, keys: {} }
    const raw = JSON.parse(readFileSync(secretsFile(), 'utf-8')) as Partial<SecretsFile>
    const keys: Record<string, string> = {}
    for (const [ref, value] of Object.entries(raw.keys ?? {})) {
      if (typeof value === 'string' && value) keys[ref] = value
    }
    return { version: 1, keys }
  } catch (err) {
    console.error('[ai] 密钥文件损坏，按空处理', err)
    return { version: 1, keys: {} }
  }
}

function writeAll(data: SecretsFile): void {
  const file = secretsFile()
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data), 'utf-8')
  renameSync(tmp, file)
}

export function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function saveSecret(ref: string, plain: string): { ok: boolean; message?: string } {
  const key = plain.trim()
  if (!key) return { ok: false, message: '密钥为空' }
  if (!encryptionAvailable()) {
    return { ok: false, message: '当前系统不支持加密存储（safeStorage 不可用），为安全起见没有保存密钥' }
  }
  try {
    const all = readAll()
    all.keys[ref] = safeStorage.encryptString(key).toString('base64')
    writeAll(all)
    return { ok: true }
  } catch (err) {
    console.error('[ai] 保存密钥失败', err)
    return { ok: false, message: '保存密钥失败（见主进程日志）' }
  }
}

export function readSecret(ref: string): string | null {
  if (!ref) return null
  const all = readAll()
  const encoded = all.keys[ref]
  if (!encoded) return null
  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
  } catch (err) {
    // 换机器/换用户后 DPAPI 解不开：当成没配，让用户重填，而不是每次请求都抛错
    console.warn('[ai] 密钥解密失败（可能换了机器或系统用户），请重新填写', err)
    return null
  }
}

export function hasSecret(ref: string): boolean {
  if (!ref) return false
  return Boolean(readAll().keys[ref])
}

export function removeSecret(ref: string): void {
  if (!ref) return
  const all = readAll()
  if (!all.keys[ref]) return
  delete all.keys[ref]
  writeAll(all)
}
