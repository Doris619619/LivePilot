/**
 * HTTP security boundary tests，验证所有修改型 API 在进入 YouTube 业务逻辑前拒绝跨站与未授权请求。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const security = vi.hoisted(() => ({
  verifyCsrf: vi.fn((sessionId: string, received: string | null) => received === 'csrf:' + sessionId),
  verifyOwnerSession: vi.fn(async (ownerId: string | null | undefined) => ownerId === 'owner-session'),
}))

/** 固定允许的本地 origin，确保测试只观察请求校验逻辑。 */
vi.mock('@/server/config', () => ({
  getRuntimeConfig: () => ({ appBaseUrl: 'http://127.0.0.1:3000' }),
  isConfigured: () => true,
}))

/** 用确定性会话签名替身模拟服务端签发的 flow、owner 和 CSRF token。 */
vi.mock('@/server/session', () => ({
  FLOW_COOKIE: 'lp_flow',
  OWNER_COOKIE: 'lp_owner',
  csrfToken: (sessionId: string) => 'csrf:' + sessionId,
  newOpaqueId: () => 'new-flow',
  verifyCsrf: security.verifyCsrf,
  verifyOwnerSession: security.verifyOwnerSession,
}))

/** 仪表盘辅助函数所需的 quota 状态与本组安全测试无关，使用固定值隔离。 */
vi.mock('@/server/quotaState', () => ({
  getQuotaState: () => ({ exceeded: false, resetsAt: null, used: 0, limit: 10_000 }),
}))

import { assertAllowedHost, failure, validateMutation } from '@/server/http'

interface RequestOverrides {
  host?: string
  origin?: string
  fetchSite?: string
  contentType?: string
  cookie?: string
  csrf?: string
}

/** 构造与真实控制端点等价的 NextRequest，并允许单项破坏安全前提。 */
function mutationRequest(overrides: RequestOverrides = {}): NextRequest {
  return new NextRequest('http://127.0.0.1:3000/api/runs/start', {
    method: 'POST',
    headers: {
      Host: overrides.host ?? '127.0.0.1:3000',
      Origin: overrides.origin ?? 'http://127.0.0.1:3000',
      'Sec-Fetch-Site': overrides.fetchSite ?? 'same-origin',
      'Content-Type': overrides.contentType ?? 'application/json',
      Cookie: overrides.cookie ?? 'lp_flow=flow-session; lp_owner=owner-session',
      'X-LivePilot-CSRF': overrides.csrf ?? 'csrf:owner-session',
    },
    body: '{}',
  })
}

/** 覆盖 Host、Origin、Fetch Metadata、owner session 与 CSRF 的组合安全门。 */
describe('HTTP mutation security', () => {
  /** 每个测试恢复 owner 与 CSRF 替身的默认严格行为。 */
  beforeEach(() => {
    security.verifyCsrf.mockImplementation((sessionId, received) => received === 'csrf:' + sessionId)
    security.verifyOwnerSession.mockImplementation(async (ownerId) => ownerId === 'owner-session')
  })

  /** 验证全部同源凭据有效时，服务端返回 owner-bound 安全上下文。 */
  it('accepts an exact-origin owner request with a session-bound CSRF token', async () => {
    await expect(validateMutation(mutationRequest(), true)).resolves.toEqual({
      flowId: 'flow-session',
      ownerId: 'owner-session',
      csrfToken: 'csrf:owner-session',
    })
  })

  /** 验证 Host header 不能把 callback 或控制接口引向未配置的 origin。 */
  it('rejects a foreign Host header', () => {
    expect(() => assertAllowedHost(mutationRequest({ host: 'attacker.example' }))).toThrowError(
      expect.objectContaining({ code: 'UNAUTHORIZED' }),
    )
  })

  /** 验证精确 Origin 比较和 Fetch Metadata 会共同拒绝浏览器跨站控制请求。 */
  it('rejects a foreign Origin and cross-site fetch metadata', async () => {
    await expect(validateMutation(mutationRequest({ origin: 'https://attacker.example' }), true))
      .rejects.toMatchObject({ code: 'CSRF_FAILED' })
    await expect(validateMutation(mutationRequest({ fetchSite: 'cross-site' }), true))
      .rejects.toMatchObject({ code: 'CSRF_FAILED' })
  })

  /** 验证非 JSON 写操作会在解析请求体前被拒绝。 */
  it('rejects a state-changing request without application/json', async () => {
    await expect(validateMutation(mutationRequest({ contentType: 'text/plain' }), true))
      .rejects.toMatchObject({ code: 'CSRF_FAILED' })
  })

  /** 验证 owner cookie 缺失或无效时无法执行 YouTube 控制操作。 */
  it('rejects an invalid owner session', async () => {
    await expect(validateMutation(mutationRequest({ cookie: 'lp_flow=flow-session; lp_owner=wrong-owner' }), true))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  /** 验证 CSRF token 必须绑定 owner session，不能复用 flow token。 */
  it('rejects a CSRF token bound to a different session', async () => {
    await expect(validateMutation(mutationRequest({ csrf: 'csrf:flow-session' }), true))
      .rejects.toMatchObject({ code: 'CSRF_FAILED' })
  })

  /** 验证首次 Connect 允许没有 owner，但仍要求 flow-bound CSRF。 */
  it('allows ownerless OAuth connect only with its flow-bound CSRF token', async () => {
    const request = mutationRequest({
      cookie: 'lp_flow=flow-session',
      csrf: 'csrf:flow-session',
    })
    await expect(validateMutation(request, false)).resolves.toMatchObject({
      flowId: 'flow-session',
      ownerId: null,
      csrfToken: 'csrf:flow-session',
    })
  })

  /** 验证未分类内部异常不会把文件路径或假想密钥写入公开 JSON。 */
  it('redacts the message and cause of an unknown internal exception', async () => {
    const response = failure(new Error('D:\\private\\youtube-tokens.enc contained secret-token'))
    const body = await response.json() as { error: { code: string; message: string } }

    expect(body.error.code).toBe('UNKNOWN')
    expect(body.error.message).not.toContain('D:\\private')
    expect(body.error.message).not.toContain('secret-token')
    expect(response.headers.get('Cache-Control')).toContain('no-store')
  })
})
