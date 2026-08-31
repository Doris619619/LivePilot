/**
 * YouTube 断开 API：先确认没有活动直播风险，再撤销 token 和本地 owner session。
 */
import { NextRequest } from 'next/server'
import { liveService } from '@/server/liveService'
import { clearOwnerSession, csrfToken, FLOW_COOKIE, OWNER_COOKIE } from '@/server/session'
import { revokeAndClearTokens } from '@/server/youtubeAuth'
import {
  browserCookieOptions,
  disconnectedSnapshot,
  failure,
  ok,
  payload,
  validateMutation,
} from '@/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** 在安全门通过后撤销授权，并返回未连接的公开快照。 */
export async function POST(request: NextRequest) {
  try {
    const security = await validateMutation(request, true)
    await liveService.assertSafeToDisconnect()
    await revokeAndClearTokens()
    await clearOwnerSession()
    const response = ok(payload(disconnectedSnapshot(), csrfToken(security.flowId)))
    response.cookies.set(OWNER_COOKIE, '', browserCookieOptions(0, true))
    response.cookies.set(FLOW_COOKIE, security.flowId, browserCookieOptions(24 * 60 * 60, true))
    return response
  } catch (error) {
    return failure(error)
  }
}
