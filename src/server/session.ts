/**
 * 管理单账号 Web MVP 的所有者会话与 CSRF Token，使浏览器控制操作绑定到已建立的服务端会话。
 */
import 'server-only'

import { randomBytes } from 'node:crypto'
import { csrfForSession, hashOpaque, safeEqual } from './cryptoBox'
import { dataPath, deletePrivateFile, readPrivateFile, writePrivateFile } from './storage'

export const FLOW_COOKIE = 'lp_flow'
export const OWNER_COOKIE = 'lp_owner'
export const OAUTH_COOKIE = 'lp_oauth'
export const CSRF_COOKIE = 'lp_csrf'

const OWNER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

interface OwnerSessionRecord {
  sessionHash: string
  expiresAt: number
}

/**
 * 生成具有足够熵且适合 Cookie/URL 传递的不透明随机 ID；生成值应按认证凭据保护。
 */
export function newOpaqueId(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

/**
 * 为指定所有者会话派生不可伪造的 CSRF Token，原始应用密钥始终保留在服务端。
 */
export function csrfToken(sessionId: string): string {
  return csrfForSession(sessionId)
}

/**
 * 以常量时间验证请求携带的 CSRF Token 是否属于当前所有者会话，缺失值一律失败关闭。
 */
export function verifyCsrf(sessionId: string, received: string | null): boolean {
  return Boolean(received && safeEqual(csrfToken(sessionId), received))
}

/**
 * 创建新的单账号所有者会话，并仅将会话 ID 摘要和过期时间写入服务端私有存储。
 * 原始 ID 只返回给 Cookie 设置层，不会以明文落盘。
 */
export async function createOwnerSession(): Promise<{ id: string; expiresAt: number }> {
  const id = newOpaqueId()
  const expiresAt = Date.now() + OWNER_SESSION_TTL_MS
  const record: OwnerSessionRecord = { sessionHash: hashOpaque(id), expiresAt }
  await writePrivateFile(dataPath('owner-session.json'), JSON.stringify(record))
  return { id, expiresAt }
}

/**
 * 验证所有者会话是否存在、未过期且摘要匹配；缺失、损坏或伪造记录均返回 false。
 * 比较过程不暴露服务端存储的摘要，也不会自动延长会话有效期。
 */
export async function verifyOwnerSession(id: string | null | undefined): Promise<boolean> {
  if (!id) return false
  const raw = await readPrivateFile(dataPath('owner-session.json'))
  if (!raw) return false
  try {
    const record = JSON.parse(raw) as OwnerSessionRecord
    return record.expiresAt > Date.now() && safeEqual(record.sessionHash, hashOpaque(id))
  } catch {
    return false
  }
}

/**
 * 删除当前单账号所有者会话记录，使后续浏览器控制请求必须重新建立会话。
 */
export async function clearOwnerSession(): Promise<void> {
  await deletePrivateFile(dataPath('owner-session.json'))
}
