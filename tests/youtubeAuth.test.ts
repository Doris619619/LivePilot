/**
 * YouTube OAuth 服务端测试，验证 PKCE/state 一次性消费、Token 密文和 refresh/disconnect 竞态。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetRuntimeConfigForTests } from '@/server/config'
import {
  clearTokens,
  consumeOAuthTransaction,
  createOAuthTransaction,
  getTokens,
  getValidAccessToken,
  saveTokens,
} from '@/server/youtubeAuth'

const TEST_ENVIRONMENT = {
  YOUTUBE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  YOUTUBE_CLIENT_SECRET: 'test-client-secret',
  LIVEPILOT_BASE_URL: 'http://127.0.0.1:3000',
  YOUTUBE_REDIRECT_URI: 'http://127.0.0.1:3000/api/auth/callback',
  LIVEPILOT_APP_SECRET: 'unit-test-application-secret-with-more-than-32-bytes',
}

let testDataDirectory = ''
let previousEnvironment: Record<string, string | undefined> = {}

/** 构造 Google OAuth endpoint 风格的 JSON Response。 */
function tokenResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** 恢复单个环境变量，避免测试配置泄漏到同一 worker 的后续模块。 */
function restoreEnvironmentValue(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

/** 覆盖 OAuth transaction 与 Token persistence 的服务端安全性质。 */
describe('youtubeAuth', () => {
  /** 每个用例创建独立私有目录和假 OAuth 配置，不读取任何真实凭据。 */
  beforeEach(async () => {
    testDataDirectory = await mkdtemp(join(tmpdir(), 'livepilot-auth-test-'))
    const environment = { ...TEST_ENVIRONMENT, LIVEPILOT_DATA_DIR: testDataDirectory }
    previousEnvironment = Object.fromEntries(
      Object.keys(environment).map(
        /** 保存测试即将覆盖的环境变量原值。 */
        (name) => [name, process.env[name]],
      ),
    )
    Object.assign(process.env, environment)
    resetRuntimeConfigForTests()
    vi.restoreAllMocks()
  })

  /** 每个用例删除精确的 mkdtemp 目录并恢复配置缓存与环境。 */
  afterEach(async () => {
    vi.unstubAllGlobals()
    await clearTokens()
    await rm(testDataDirectory, { recursive: true, force: true })
    for (const [name, value] of Object.entries(previousEnvironment)) restoreEnvironmentValue(name, value)
    resetRuntimeConfigForTests()
  })

  /** 验证授权 URL 只携带公开 PKCE challenge，且 transaction 成功后无法重放。 */
  it('binds a one-time state and PKCE transaction to the initiating browser flow', async () => {
    const transaction = await createOAuthTransaction('browser-flow', 'guarded-channel')
    const authorizationUrl = new URL(transaction.authorizationUrl)
    const state = authorizationUrl.searchParams.get('state')

    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorizationUrl.searchParams.get('code_challenge')).toBeTruthy()
    expect(authorizationUrl.searchParams.has('code_verifier')).toBe(false)
    expect(transaction.authorizationUrl).not.toContain(TEST_ENVIRONMENT.YOUTUBE_CLIENT_SECRET)

    const consumed = await consumeOAuthTransaction(transaction.transactionId, 'browser-flow', state)
    expect(consumed.guardedChannelId).toBe('guarded-channel')
    expect(consumed.codeVerifier.length).toBeGreaterThan(40)
    await expect(consumeOAuthTransaction(transaction.transactionId, 'browser-flow', state))
      .rejects.toMatchObject({ code: 'OAUTH_FAILED' })
  })

  /** 验证错误浏览器对 transaction 的第一次领取也会消费文件，从而失败关闭。 */
  it('atomically consumes a transaction even when browser binding validation fails', async () => {
    const transaction = await createOAuthTransaction('correct-flow', null)
    const state = new URL(transaction.authorizationUrl).searchParams.get('state')

    await expect(consumeOAuthTransaction(transaction.transactionId, 'wrong-flow', state))
      .rejects.toMatchObject({ code: 'OAUTH_FAILED' })
    await expect(consumeOAuthTransaction(transaction.transactionId, 'correct-flow', state))
      .rejects.toMatchObject({ code: 'OAUTH_FAILED' })
  })

  /** 验证 Token 文件只含 AES-GCM envelope，而服务端仍可认证解密原值。 */
  it('persists access and refresh tokens only as authenticated ciphertext', async () => {
    const tokens = {
      accessToken: 'plaintext-access-token',
      refreshToken: 'plaintext-refresh-token',
      expiresAt: Date.now() + 60 * 60 * 1000,
    }
    await saveTokens(tokens)

    const stored = await readFile(join(testDataDirectory, 'youtube-tokens.enc'), 'utf8')
    expect(stored.startsWith('v1.')).toBe(true)
    expect(stored).not.toContain(tokens.accessToken)
    expect(stored).not.toContain(tokens.refreshToken)
    await expect(getTokens()).resolves.toEqual(tokens)
  })

  /** 验证多个并发 API 请求共享一次 refresh，且 Google 未返回新 refresh token 时保留旧值。 */
  it('single-flights concurrent refresh requests and preserves the refresh token', async () => {
    await saveTokens({
      accessToken: 'expired-access',
      refreshToken: 'stable-refresh',
      expiresAt: Date.now() - 1,
    })
    /** 返回一个新的 Access Token，但模拟 Google 省略 refresh_token。 */
    const fetchMock = vi.fn(async () => tokenResponse({ access_token: 'fresh-access', expires_in: 3600 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(Promise.all([getValidAccessToken(), getValidAccessToken()]))
      .resolves.toEqual(['fresh-access', 'fresh-access'])
    expect(fetchMock).toHaveBeenCalledOnce()
    await expect(getTokens()).resolves.toMatchObject({
      accessToken: 'fresh-access',
      refreshToken: 'stable-refresh',
    })
  })

  /** 验证 disconnect 改变认证 epoch 后，较晚完成的旧 refresh 不能恢复已删除 Token。 */
  it('drops a refresh result that completes after disconnect', async () => {
    await saveTokens({
      accessToken: 'expired-access',
      refreshToken: 'refresh-before-disconnect',
      expiresAt: Date.now() - 1,
    })
    let resolveGoogle: ((response: Response) => void) | undefined
    /** 暂停 Google 响应，使测试能在网络请求途中执行 disconnect。 */
    const googleResponse = new Promise<Response>((resolve) => { resolveGoogle = resolve })
    const fetchMock = vi.fn(async () => googleResponse)
    vi.stubGlobal('fetch', fetchMock)

    const refreshing = getValidAccessToken()
    await vi.waitFor(
      /** 等待 refresh 请求真正离开服务端后再清除本地凭据。 */
      () => expect(fetchMock).toHaveBeenCalledOnce(),
    )
    await clearTokens()
    resolveGoogle?.(tokenResponse({ access_token: 'late-access', expires_in: 3600 }))

    await expect(refreshing).rejects.toMatchObject({ code: 'NOT_CONNECTED' })
    await expect(getTokens()).resolves.toBeNull()
  })

  /** Verifies that two OAuth connections use separate encrypted files instead of a global token slot. */
  it('isolates encrypted tokens by OAuth connection ID', async () => {
    const first = 'connection-alpha'
    const second = 'connection-bravo'
    await saveTokens({ accessToken: 'access-a', refreshToken: 'refresh-a', expiresAt: 1 }, first)
    await saveTokens({ accessToken: 'access-b', refreshToken: 'refresh-b', expiresAt: 2 }, second)

    await expect(getTokens(first)).resolves.toMatchObject({ refreshToken: 'refresh-a' })
    await expect(getTokens(second)).resolves.toMatchObject({ refreshToken: 'refresh-b' })
    await expect(getTokens()).resolves.toBeNull()
  })
})
