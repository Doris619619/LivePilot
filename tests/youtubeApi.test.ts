/**
 * YouTube API adapter contract tests，验证分页、去重、Stream 创建参数和错误映射均停留在服务端。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const dependencies = vi.hoisted(() => ({
  getValidAccessToken: vi.fn(async () => 'server-access-token'),
  addQuotaUsage: vi.fn(),
  markQuotaExceeded: vi.fn(),
  getQuotaState: vi.fn(() => ({ exceeded: false, resetsAt: null, used: 0, limit: 10_000 })),
}))

/** 用服务端 token 替身隔离 Google OAuth 网络边界。 */
vi.mock('@/server/youtubeAuth', () => ({
  getValidAccessToken: dependencies.getValidAccessToken,
}))

/** 用可观察的 quota 替身验证 API 成功和配额失败行为。 */
vi.mock('@/server/quotaState', () => ({
  addQuotaUsage: dependencies.addQuotaUsage,
  markQuotaExceeded: dependencies.markQuotaExceeded,
  getQuotaState: dependencies.getQuotaState,
}))

import {
  createLiveStream,
  listLiveBroadcasts,
  transitionBroadcast,
} from '@/server/youtubeApi'

/** 构造 Google API 风格的 JSON Response。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** 构造具有确定排序时间的最小 Broadcast 资源。 */
function broadcast(id: string, title: string, scheduledStartTime: string) {
  return {
    id,
    snippet: { title, description: '', scheduledStartTime },
    status: { lifeCycleStatus: 'ready', privacyStatus: 'unlisted' },
  }
}

/** 覆盖 server-only YouTube REST adapter 的关键请求契约。 */
describe('youtubeApi', () => {
  /** 每个用例重置 fetch 与 quota 观察值，防止请求计数互相污染。 */
  beforeEach(() => {
    vi.restoreAllMocks()
    dependencies.getValidAccessToken.mockResolvedValue('server-access-token')
    dependencies.getQuotaState.mockReturnValue({ exceeded: false, resetsAt: null, used: 0, limit: 10_000 })
  })

  /** 验证 active/upcoming 都会翻页，重复资源去重后按计划时间稳定排序。 */
  it('paginates active and upcoming broadcasts before de-duplicating them', async () => {
    /** 根据 YouTube query 返回两组各两页的确定数据。 */
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
      void _init
      const url = new URL(String(input))
      const status = url.searchParams.get('broadcastStatus')
      const page = url.searchParams.get('pageToken')
      if (status === 'active' && !page) {
        return jsonResponse({
          items: [broadcast('shared', 'active copy', '2026-09-01T01:00:00Z')],
          nextPageToken: 'active-2',
        })
      }
      if (status === 'active' && page === 'active-2') {
        return jsonResponse({ items: [broadcast('active-2', 'active second page', '2026-09-01T04:00:00Z')] })
      }
      if (status === 'upcoming' && !page) {
        return jsonResponse({
          items: [
            broadcast('shared', 'upcoming copy wins', '2026-09-01T01:00:00Z'),
            broadcast('upcoming-1', 'upcoming first page', '2026-09-01T02:00:00Z'),
          ],
          nextPageToken: 'upcoming-2',
        })
      }
      if (status === 'upcoming' && page === 'upcoming-2') {
        return jsonResponse({ items: [broadcast('upcoming-2', 'upcoming second page', '2026-09-01T05:00:00Z')] })
      }
      throw new Error('Unexpected YouTube request: ' + url)
    })
    vi.stubGlobal('fetch', fetchMock)

    const items = await listLiveBroadcasts()

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(items.map((item) => item.id)).toEqual(['shared', 'upcoming-1', 'active-2', 'upcoming-2'])
    expect(items[0].snippet.title).toBe('upcoming copy wins')
    expect(fetchMock.mock.calls.every((call) => call[1]?.cache === 'no-store')).toBe(true)
    expect(fetchMock.mock.calls.every((call) => new Headers(call[1]?.headers).get('Authorization') === 'Bearer server-access-token')).toBe(true)
  })

  /** 验证创建 reusable RTMP Stream 时使用官方必需字段，且请求体不包含任何现有密钥。 */
  it('creates a reusable variable RTMP stream without sending a stream key', async () => {
    /** 返回只供 server-side orchestration 使用的 ingest secret。 */
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
      void _input
      void _init
      return jsonResponse({
        id: 'stream-1',
        snippet: { title: 'LivePilot reusable stream' },
        cdn: {
          ingestionInfo: {
            streamName: 'server-only-stream-key',
            rtmpsIngestionAddress: 'rtmps://a.rtmps.youtube.com/live2',
          },
        },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const secret = await createLiveStream()
    const request = fetchMock.mock.calls[0]
    const body = JSON.parse(String(request[1]?.body)) as Record<string, unknown>

    expect(secret.streamName).toBe('server-only-stream-key')
    expect(body).toMatchObject({
      cdn: { ingestionType: 'rtmp', resolution: 'variable', frameRate: 'variable' },
      contentDetails: { isReusable: true },
    })
    expect(JSON.stringify(body)).not.toContain('server-only-stream-key')
    expect(String(request[0])).toContain('/liveStreams?')
  })

  /** 验证 Google quotaExceeded reason 会打开本地 quota gate 并保留行动化错误代码。 */
  it('maps quotaExceeded into the local quota safety gate', async () => {
    /** 模拟 YouTube transition 的结构化 quota 错误。 */
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      error: {
        message: 'Daily quota exhausted',
        errors: [{ reason: 'quotaExceeded' }],
      },
    }, 403)))

    await expect(transitionBroadcast('broadcast-1', 'live')).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    expect(dependencies.markQuotaExceeded).toHaveBeenCalledOnce()
  })
})
