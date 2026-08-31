/**
 * 管理服务端私有文件路径与原子读写操作，为 OAuth Token、事务和所有者会话提供落盘边界。
 */
import 'server-only'

import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { requireConfigured } from './config'

/**
 * 在已校验的私有数据根目录下拼接服务端路径。
 * segments 必须来自受信任的服务端常量或不透明 ID，不得直接接收浏览器提供的路径片段。
 */
export function dataPath(...segments: string[]): string {
  return join(requireConfigured().dataDir, ...segments)
}

/**
 * 读取服务端私有文本文件；文件不存在时返回 null，其他 I/O 错误继续抛出以避免静默降级。
 * path 必须由服务端控制，调用方不得借此向浏览器开放任意文件读取能力。
 */
export async function readPrivateFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * 以 0700 目录、0600 临时文件、fsync 和原子 rename 持久化私有内容，避免部分写入被读取。
 * path 与 content 均应停留在服务端；函数不会对浏览器输入执行路径净化或内容脱敏。
 */
export async function writePrivateFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = path + '.' + randomBytes(8).toString('hex') + '.tmp'
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
}

/**
 * 幂等删除指定服务端私有文件；调用方必须传入精确受控路径，避免扩大删除范围。
 */
export async function deletePrivateFile(path: string): Promise<void> {
  await rm(path, { force: true })
}

/**
 * 通过同目录原子 rename 独占领取一次性私有文件，使并发请求最多只有一个消费者成功。
 * 成功返回的 claimed 路径仍包含敏感数据，调用方必须在 finally 中将其删除。
 */
export async function claimPrivateFile(path: string): Promise<string | null> {
  const claimed = path + '.' + randomBytes(8).toString('hex') + '.claimed'
  try {
    await rename(path, claimed)
    return claimed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
