/**
 * Dashboard route 恢复测试，验证损坏或失效 Token 不会让浏览器失去重新授权所需的 flow CSRF。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const routeDependencies = vi.hoisted(() => ({
  isTokenConnected: vi.fn<() => Promise<boolean>>(),
  verifyOwnerSession: vi.fn(async () => true),
  snapshot: vi.fn(),
}))

/** 固定本地 Web origin 与完整配置状态。 */
vi.mock('@/server/config', () => ({
  getRuntimeConfig: () => ({ appBaseUrl: 'http://127.0.0.1:3000' }),
  isConfigured: () => true,
}))

/** 用失败可控的 Token 探针模拟服务端持久化损坏。 */
vi.mock('@/server/youtubeAuth', () => ({
  isTokenConnected: routeDependencies.isTokenConnected,
}))

/** 用确定性 owner 与 flow token 隔离路由的恢复响应。 */
vi.mock('@/server/session', () => ({
  FLOW_COOKIE: 'lp_flow',
  OWNER_COOKIE: 'lp_owner',
  csrfToken: (sessionId: string) => 'csrf:' + sessionId,
  newOpaqueId: () => 'new-flow',
  verifyCsrf: () => true,
  verifyOwnerSession: routeDependencies.verifyOwnerSession,
}))

/** 观察失败认证时是否错误进入真实 YouTube snapshot。 */
vi.mock('@/server/liveService', () => ({
  liveService: { snapshot: routeDependencies.snapshot },
}))

/** 为 disconnected snapshot 提供固定公开 quota。 */
vi.mock('@/server/quotaState', () => ({
  getQuotaState: () => ({ exceeded: false, resetsAt: null, used: 0, limit: 10_000 }),
}))

import { GET } from '@/app/api/dashboard/route'
import { LivePilotError } from '@/server/errors'

/** 验证 Dashboard 在认证存储失败时仍返回安全、可恢复的公开状态。 */
describe('dashboard route auth recovery', () => {
  /** 每个用例恢复有效 owner 与空调用记录。 */
  beforeEach(() => {
    routeDependencies.verifyOwnerSession.mockResolvedValue(true)
    routeDependencies.snapshot.mockReset()
    routeDependencies.isTokenConnected.mockReset()
  })

  /** 验证 TOKEN_INVALID 被脱敏放入 disconnected snapshot，并签发 flow-bound CSRF。 */
  it('returns a reconnectable disconnected snapshot when token storage is invalid', async () => {
    routeDependencies.isTokenConnected.mockRejectedValue(
      new LivePilotError('TOKEN_INVALID', '服务端加密状态无法解密。', { retryable: false }),
    )
    const request = new NextRequest('http://127.0.0.1:3000/api/dashboard', {
      headers: {
        Host: '127.0.0.1:3000',
        Cookie: 'lp_flow=flow-session; lp_owner=owner-session',
      },
    })

    const response = await GET(request)
    const body = await response.json() as {
      ok: boolean
      data: { snapshot: { connected: boolean; error: { code: string } | null }; csrfToken: string }
    }

    expect(body.ok).toBe(true)
    expect(body.data.snapshot.connected).toBe(false)
    expect(body.data.snapshot.error?.code).toBe('TOKEN_INVALID')
    expect(body.data.csrfToken).toBe('csrf:flow-session')
    expect(routeDependencies.snapshot).not.toHaveBeenCalled()
  })
})
