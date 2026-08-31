/**
 * 实现服务端 Google OAuth、PKCE 事务、YouTube Token 加密持久化、刷新去重与撤销流程。
 */
import 'server-only'

import { createHash, randomBytes } from 'node:crypto'
import { requireConfigured } from './config'
import { hashOpaque, safeEqual, sealJson, unsealJson } from './cryptoBox'
import { LivePilotError } from './errors'
import {
  claimPrivateFile,
  dataPath,
  deletePrivateFile,
  readPrivateFile,
  writePrivateFile,
} from './storage'
import { newOpaqueId } from './session'

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke'
const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube'
const OAUTH_TTL_MS = 10 * 60 * 1000

export interface YouTubeTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

interface OAuthTransaction {
  stateHash: string
  browserSessionHash: string
  codeVerifier: string
  guardedChannelId: string | null
  expiresAt: number
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

const globalAuth = globalThis as typeof globalThis & {
  __livePilotRefresh?: Promise<string> | null
  __livePilotAuthEpoch?: number
}
globalAuth.__livePilotRefresh ??= null
globalAuth.__livePilotAuthEpoch ??= 0

/**
 * 返回加密 YouTube Token 的服务端私有存储路径；密文文件不得置于 public 或返回浏览器。
 */
function tokenPath(): string {
  return dataPath('youtube-tokens.enc')
}

/**
 * 为一次性 OAuth 事务生成服务端私有路径；id 必须是服务端产生的不透明随机值。
 */
function transactionPath(id: string): string {
  return dataPath('oauth-transactions', id + '.enc')
}

/**
 * 构建 Google OAuth 授权地址，并强制使用离线授权、明确同意与 S256 PKCE。
 * Client Secret、code verifier 和既有 Token 均不会进入浏览器可见 URL。
 */
export function buildAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  codeChallenge: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: YOUTUBE_SCOPE,
    access_type: 'offline',
    prompt: 'consent select_account',
    include_granted_scopes: 'true',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })
  return AUTHORIZATION_ENDPOINT + '?' + params.toString()
}

/**
 * 创建绑定当前浏览器会话的一次性 OAuth 事务，并将 state 摘要与 PKCE verifier 加密落盘。
 * 返回给浏览器的只有事务 ID 和授权 URL，不包含 Client Secret 或明文 verifier。
 */
export async function createOAuthTransaction(
  browserSessionId: string,
  guardedChannelId: string | null,
): Promise<{ transactionId: string; authorizationUrl: string }> {
  const config = requireConfigured()
  const transactionId = newOpaqueId()
  const state = randomBytes(32).toString('base64url')
  const codeVerifier = randomBytes(48).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  const transaction: OAuthTransaction = {
    stateHash: hashOpaque(state),
    browserSessionHash: hashOpaque(browserSessionId),
    codeVerifier,
    guardedChannelId,
    expiresAt: Date.now() + OAUTH_TTL_MS,
  }
  await writePrivateFile(transactionPath(transactionId), sealJson(transaction))
  return {
    transactionId,
    authorizationUrl: buildAuthorizationUrl(
      config.youtubeClientId,
      config.youtubeRedirectUri,
      state,
      codeChallenge,
    ),
  }
}

/**
 * 原子领取并消费 OAuth 回调事务，验证有效期、state 与发起授权的浏览器会话绑定关系。
 * 无论校验成功或失败都会删除已领取文件，阻止事务重放。
 */
export async function consumeOAuthTransaction(
  transactionId: string | null | undefined,
  browserSessionId: string | null | undefined,
  state: string | null,
): Promise<{ codeVerifier: string; guardedChannelId: string | null }> {
  if (!transactionId || !browserSessionId || !state) {
    throw new LivePilotError('OAUTH_FAILED', 'OAuth callback 缺少一次性事务或 state。', { retryable: false })
  }
  const claimed = await claimPrivateFile(transactionPath(transactionId))
  if (!claimed) {
    throw new LivePilotError('OAUTH_FAILED', 'OAuth 事务不存在、已过期或已被使用。', { retryable: false })
  }
  try {
    const raw = await readPrivateFile(claimed)
    if (!raw) throw new LivePilotError('OAUTH_FAILED', 'OAuth 事务无法读取。', { retryable: false })
    const transaction = unsealJson<OAuthTransaction>(raw)
    if (
      transaction.expiresAt <= Date.now()
      || !safeEqual(transaction.stateHash, hashOpaque(state))
      || !safeEqual(transaction.browserSessionHash, hashOpaque(browserSessionId))
    ) {
      throw new LivePilotError('OAUTH_FAILED', 'OAuth state 已过期或不属于当前浏览器会话。', { retryable: false })
    }
    return {
      codeVerifier: transaction.codeVerifier,
      guardedChannelId: transaction.guardedChannelId,
    }
  } finally {
    await deletePrivateFile(claimed)
  }
}

/**
 * 从 Google Token endpoint 读取 JSON；空或无法解析的错误响应按空对象处理并交由状态检查统一报错。
 * 此 helper 不记录响应内容，避免潜在 Token 或上游诊断信息进入日志。
 */
function emptyTokenResponse(): TokenResponse {
  return {}
}

/**
 * 仅从服务端向 Google OAuth Token endpoint 发起带超时的表单请求，并标准化网络与协议错误。
 * body 可能包含 Client Secret、授权码或 Refresh Token，不得记录或转发到浏览器。
 */
async function tokenRequest(body: URLSearchParams): Promise<TokenResponse> {
  let response: Response
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    throw new LivePilotError('NETWORK_ERROR', '服务端无法连接 Google OAuth token endpoint。', { cause: error })
  }
  const data = await response.json().catch(emptyTokenResponse) as TokenResponse
  if (!response.ok || data.error) {
    const detail = data.error_description || data.error || 'Google 拒绝了 token 请求。'
    throw new LivePilotError('TOKEN_INVALID', detail)
  }
  return data
}

/**
 * 用一次性授权码与 PKCE verifier 交换首组 YouTube Token，并要求 Google 返回 Refresh Token。
 * Client Secret 只在该服务端请求内使用，返回值必须立即进入加密持久化流程。
 */
export async function exchangeAuthorizationCode(code: string, codeVerifier: string): Promise<YouTubeTokens> {
  const config = requireConfigured()
  const data = await tokenRequest(new URLSearchParams({
    code,
    code_verifier: codeVerifier,
    client_id: config.youtubeClientId,
    client_secret: config.youtubeClientSecret,
    redirect_uri: config.youtubeRedirectUri,
    grant_type: 'authorization_code',
  }))
  if (!data.access_token || !data.refresh_token) {
    throw new LivePilotError(
      'OAUTH_FAILED',
      'Google 未返回 refresh token；请撤销旧授权后重新连接。',
      { retryable: false },
    )
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
  }
}

/**
 * 将 YouTube Token 作为认证密文写入服务端私有文件，禁止把明文 Token 返回浏览器。
 */
export async function saveTokens(tokens: YouTubeTokens): Promise<void> {
  await writePrivateFile(tokenPath(), sealJson(tokens))
}

/**
 * 从服务端私有文件读取并认证解密 YouTube Token；未连接时返回 null。
 * 返回值仅供服务端 Google API 调用链使用。
 */
export async function getTokens(): Promise<YouTubeTokens | null> {
  const raw = await readPrivateFile(tokenPath())
  return raw ? unsealJson<YouTubeTokens>(raw) : null
}

/**
 * 仅以布尔值报告服务端是否持有 Refresh Token，不向浏览器暴露 Token 内容。
 */
export async function isTokenConnected(): Promise<boolean> {
  return Boolean((await getTokens())?.refreshToken)
}

/**
 * 递增认证 epoch 并删除本地 Token 密文，使进行中的旧刷新结果不能重新写回已断开的账号。
 */
export async function clearTokens(): Promise<void> {
  globalAuth.__livePilotAuthEpoch = (globalAuth.__livePilotAuthEpoch ?? 0) + 1
  await deletePrivateFile(tokenPath())
}

/**
 * 为指定认证 epoch 刷新 Access Token，并在持久化前再次确认账号未被并发断开。
 * Refresh Token 与 Client Secret 始终只发送到 Google 的服务端 Token endpoint。
 */
async function refreshAccessTokenForEpoch(epoch: number): Promise<string> {
  const config = requireConfigured()
  const current = await getTokens()
  if (!current?.refreshToken) throw new LivePilotError('NOT_CONNECTED', '尚未连接 YouTube。')
  const data = await tokenRequest(new URLSearchParams({
    refresh_token: current.refreshToken,
    client_id: config.youtubeClientId,
    client_secret: config.youtubeClientSecret,
    grant_type: 'refresh_token',
  }))
  if (!data.access_token) throw new LivePilotError('TOKEN_INVALID', 'Google 未返回新的 access token。')
  if (epoch !== (globalAuth.__livePilotAuthEpoch ?? 0)) {
    throw new LivePilotError('NOT_CONNECTED', '账号已断开，已忽略旧的 token refresh 结果。')
  }
  const updated: YouTubeTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || current.refreshToken,
    expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
  }
  await saveTokens(updated)
  return updated.accessToken
}

/**
 * 在共享刷新 Promise 完成后释放进程内去重槽位，使后续过期检查可以启动新刷新。
 */
function clearRefreshPromise(): void {
  globalAuth.__livePilotRefresh = null
}

/**
 * 返回仍有安全余量的 Access Token，过期临近时以进程级共享 Promise 去重并发刷新。
 * Token 只返回服务端调用方；认证 epoch 防止 disconnect 与 refresh 竞态恢复旧凭据。
 */
export async function getValidAccessToken(): Promise<string> {
  const tokens = await getTokens()
  if (!tokens) throw new LivePilotError('NOT_CONNECTED', '尚未连接 YouTube。')
  if (Date.now() < tokens.expiresAt - 5 * 60 * 1000) return tokens.accessToken
  if (globalAuth.__livePilotRefresh) return globalAuth.__livePilotRefresh

  const epoch = globalAuth.__livePilotAuthEpoch ?? 0
  globalAuth.__livePilotRefresh = refreshAccessTokenForEpoch(epoch).finally(clearRefreshPromise)
  return globalAuth.__livePilotRefresh
}

/**
 * 先权威删除本地 Token，再尽力向 Google 撤销 Refresh Token；远端网络失败不会恢复本地凭据。
 * 撤销请求完全在服务端执行，浏览器不会接触待撤销 Token。
 */
export async function revokeAndClearTokens(): Promise<void> {
  const tokens = await getTokens()
  await clearTokens()
  if (!tokens?.refreshToken) return
  try {
    await fetch(REVOKE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: tokens.refreshToken }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    // Local token removal is authoritative; revocation is best effort.
  }
}
