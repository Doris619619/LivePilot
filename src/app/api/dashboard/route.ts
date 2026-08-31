/**
 * 仪表盘只读 API：校验本地主机和 owner session，并返回不含密钥的当前快照。
 */
import { NextRequest } from 'next/server'
import { liveService } from '@/server/liveService'
import { isConfigured } from '@/server/config'
import { toPublicError } from '@/server/errors'
import { isTokenConnected } from '@/server/youtubeAuth'
import {
  FLOW_COOKIE,
  OWNER_COOKIE,
  csrfToken,
  verifyOwnerSession,
} from '@/server/session'
import {
  assertAllowedHost,
  browserCookieOptions,
  disconnectedSnapshot,
  ensureFlowId,
  failure,
  ok,
  payload,
  readBroadcastId,
} from '@/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** 读取可选 Broadcast 选择，并为当前浏览器 flow 返回快照和 CSRF token。 */
export async function GET(request: NextRequest) {
  const flow = ensureFlowId(request)
  try {
    assertAllowedHost(request)
    const ownerId = request.cookies.get(OWNER_COOKIE)?.value ?? null
    const ownerValid = await verifyOwnerSession(ownerId)
    let connected = false
    let authenticationError: ReturnType<typeof toPublicError> | null = null
    if (ownerValid && isConfigured()) {
      try {
        connected = await isTokenConnected()
      } catch (error) {
        // 返回 flow-bound CSRF 与脱敏错误，让损坏/失效 Token 的浏览器可以重新授权而不被卡死。
        authenticationError = toPublicError(error)
      }
    }
    const selectedValue = request.nextUrl.searchParams.get('broadcastId')
    const selectedId = selectedValue ? readBroadcastId(selectedValue) : null
    const snapshot = connected
      ? await liveService.snapshot(selectedId)
      : { ...disconnectedSnapshot(), error: authenticationError }
    const csrf = isConfigured() ? csrfToken(connected ? ownerId as string : flow.flowId) : ''
    const response = ok(payload(snapshot, csrf))
    if (flow.isNew) response.cookies.set(FLOW_COOKIE, flow.flowId, browserCookieOptions(24 * 60 * 60, true))
    return response
  } catch (error) {
    const response = failure(error)
    if (flow.isNew) response.cookies.set(FLOW_COOKIE, flow.flowId, browserCookieOptions(24 * 60 * 60, true))
    return response
  }
}
