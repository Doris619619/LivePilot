/**
 * Google OAuth callback：原子消费 transaction，验证频道后保存 token 并建立 owner session。
 */
import { NextRequest, NextResponse } from 'next/server'
import { getRuntimeConfig } from '@/server/config'
import { toPublicError, LivePilotError } from '@/server/errors'
import { assertAllowedHost, browserCookieOptions, NO_STORE_HEADERS } from '@/server/http'
import { getCurrentChannelWithAccessToken } from '@/server/youtubeApi'
import {
  consumeOAuthTransaction,
  exchangeAuthorizationCode,
  saveTokens,
} from '@/server/youtubeAuth'
import { upsertAuthorizedChannel } from '@/server/controlPlaneStore'
import {
  FLOW_COOKIE,
  OAUTH_COOKIE,
  OWNER_COOKIE,
  createOwnerSession,
} from '@/server/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** 处理 Google redirect；成功或失败都清除一次性 OAuth cookie 并返回首页。 */
export async function GET(request: NextRequest) {
  const home = new URL('/', getRuntimeConfig().appBaseUrl)
  try {
    assertAllowedHost(request)
    const transaction = await consumeOAuthTransaction(
      request.cookies.get(OAUTH_COOKIE)?.value,
      request.cookies.get(FLOW_COOKIE)?.value,
      request.nextUrl.searchParams.get('state'),
    )
    const oauthError = request.nextUrl.searchParams.get('error')
    if (oauthError) throw new LivePilotError('OAUTH_FAILED', 'Google OAuth 返回错误：' + oauthError)
    const code = request.nextUrl.searchParams.get('code')
    if (!code) throw new LivePilotError('OAUTH_FAILED', 'Google callback 缺少 authorization code。')
    const candidate = await exchangeAuthorizationCode(code, transaction.codeVerifier)
    const channel = await getCurrentChannelWithAccessToken(candidate.accessToken)
    if (transaction.guardedChannelId && channel.id !== transaction.guardedChannelId) {
      throw new LivePilotError(
        'INVALID_STATE',
        '重新授权的 Channel 与可能仍在直播的原 Channel 不一致。',
        { action: '重新连接原 Channel，或先在 YouTube Studio 结束原直播。', retryable: false },
      )
    }
    const authorized = await upsertAuthorizedChannel(channel)
    await saveTokens(candidate, authorized.connection.id)
    const owner = await createOwnerSession()
    home.searchParams.set('auth', 'connected')
    const response = NextResponse.redirect(home, { headers: NO_STORE_HEADERS })
    response.cookies.set(OWNER_COOKIE, owner.id, browserCookieOptions(7 * 24 * 60 * 60, true))
    response.cookies.set(OAUTH_COOKIE, '', browserCookieOptions(0, true))
    return response
  } catch (error) {
    home.searchParams.set('auth', 'error')
    home.searchParams.set('code', toPublicError(error).code)
    const response = NextResponse.redirect(home, { headers: NO_STORE_HEADERS })
    response.cookies.set(OAUTH_COOKIE, '', browserCookieOptions(0, true))
    return response
  }
}
