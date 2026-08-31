/**
 * 提供服务端密文封装、不可逆摘要、CSRF 签名与常量时间比较，避免敏感状态暴露给浏览器。
 */
import 'server-only'

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { requireConfigured } from './config'
import { LivePilotError } from './errors'

/**
 * 从服务端应用密钥派生固定长度的 AES-256 密钥；派生结果仅在当前调用栈内使用且不得持久化。
 */
function key(secret = requireConfigured().appSecret): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest()
}

/**
 * 使用随机 IV 的 AES-256-GCM 对 JSON 值进行认证加密，供服务端私有持久化使用。
 * 返回的 envelope 可安全落盘但仍应视为敏感数据，不应作为浏览器可见状态传播。
 */
export function sealJson(value: unknown, secret?: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv)
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.')
}

/**
 * 验证并解密服务端生成的 AES-GCM envelope，再恢复为调用方声明的 JSON 类型。
 * 任何格式、认证标签或解析失败都会统一映射为非重试 Token 错误，避免泄露解密细节。
 */
export function unsealJson<T>(sealed: string, secret?: string): T {
  try {
    const [version, iv, tag, encrypted] = sealed.split('.')
    if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('invalid envelope')
    const decipher = createDecipheriv('aes-256-gcm', key(secret), Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    const clear = Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
    return JSON.parse(clear) as T
  } catch (error) {
    throw new LivePilotError('TOKEN_INVALID', '服务端加密状态无法解密。', { cause: error, retryable: false })
  }
}

/**
 * 为不透明标识生成不可逆 SHA-256 摘要，使会话记录无需保存可直接使用的原始凭据。
 */
export function hashOpaque(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url')
}

/**
 * 使用服务端应用密钥将 CSRF Token 绑定到指定会话 ID，浏览器无法自行伪造有效签名。
 */
export function csrfForSession(sessionId: string, secret = requireConfigured().appSecret): string {
  return createHmac('sha256', secret).update('csrf:' + sessionId, 'utf8').digest('base64url')
}

/**
 * 在长度一致时以常量时间比较两个敏感字符串，降低普通字符串比较造成的时序侧信道风险。
 */
export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
