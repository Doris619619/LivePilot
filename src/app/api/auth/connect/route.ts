/**
 * OAuth 发起 API：为同源浏览器创建一次性 state + PKCE 服务端 transaction。
 */
import { NextRequest } from 'next/server'
import { validateMutation, failure, ok, browserCookieOptions } from '@/server/http'
import { createOAuthTransaction } from '@/server/youtubeAuth'
import { readSafetyState } from '@/server/runtimeState'
import { OAUTH_COOKIE } from '@/server/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** 验证连接请求后返回 Google authorization URL，并设置短期 transaction cookie。 */
export async function POST(request: NextRequest) {
  try {
    const security = await validateMutation(request, false)
    const risk = await readSafetyState()
    const transaction = await createOAuthTransaction(security.flowId, risk?.guardedChannelId ?? null)
    const response = ok({ authorizationUrl: transaction.authorizationUrl })
    response.cookies.set(OAUTH_COOKIE, transaction.transactionId, browserCookieOptions(10 * 60, true))
    return response
  } catch (error) {
    return failure(error)
  }
}
