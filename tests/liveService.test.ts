/**
 * LiveService 状态机单元测试，验证 bind、ingest gate、transition 顺序和安全阻断。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** 用稳定的已配置状态隔离生命周期测试。 */
vi.mock('@/server/config', () => ({ isConfigured: () => true }))
/** 用固定的未超额 quota 隔离 YouTube 状态机测试。 */
vi.mock('@/server/quotaState', () => ({
  getQuotaState: () => ({ exceeded: false, resetsAt: null, used: 0, limit: 10_000 }),
}))
const safety = vi.hoisted(() => ({
  mark: vi.fn(async () => undefined),
  clear: vi.fn(async () => undefined),
  read: vi.fn(async () => null),
  reconcile: vi.fn(async () => undefined),
}))
/** 把持久化风险状态替换为可断言的测试替身。 */
vi.mock('@/server/runtimeState', () => ({
  markBroadcastRisk: safety.mark,
  clearBroadcastRisk: safety.clear,
  readSafetyState: safety.read,
  reconcileBroadcastRisk: safety.reconcile,
}))

import type { LiveBroadcast } from '@/shared/types'
import { LiveService, type LiveServiceApi } from '@/server/liveService'

const STREAM = {
  streamId: 'stream-1',
  title: 'LivePilot reusable stream',
  streamName: 'server-only-youtube-key',
  ingestionAddress: 'rtmps://a.rtmps.youtube.com/live2',
}

const ACTIVE_INGEST = {
  streamId: STREAM.streamId,
  title: STREAM.title,
  streamStatus: 'active',
  healthStatus: 'good',
  configurationIssues: [],
}

/** 构造只包含浏览器可见字段的测试 Broadcast。 */
function broadcast(id = 'broadcast-1', lifeCycleStatus = 'ready'): LiveBroadcast {
  return {
    id,
    snippet: { title: 'Test ' + id, description: 'memory only' },
    status: { lifeCycleStatus, privacyStatus: 'unlisted' },
  }
}

/** 构造具有合理默认行为的 YouTube API 替身，并允许单个测试覆盖目标调用。 */
function makeApi(overrides: Partial<LiveServiceApi> = {}): LiveServiceApi {
  let boundStreamId: string | undefined
  return {
    getCurrentChannel: vi.fn(async () => ({ id: 'channel-1', title: 'Test channel' })),
    listLiveBroadcasts: vi.fn(async () => [broadcast()]),
    getBroadcastById: vi.fn(async () => broadcast()),
    createBroadcast: vi.fn(async () => broadcast()),
    getOrCreateLiveStream: vi.fn(async () => STREAM),
    getLiveStreamById: vi.fn(async () => STREAM),
    bindBroadcast: vi.fn(async (_broadcastId, streamId) => { boundStreamId = streamId }),
    getBroadcastContentDetails: vi.fn(async () => ({
      enableMonitorStream: true,
      enableAutoStart: false,
      boundStreamId,
    })),
    getBroadcastLifeCycleStatus: vi.fn(async () => 'ready'),
    getStreamStatus: vi.fn(async () => ACTIVE_INGEST),
    transitionBroadcast: vi.fn(async () => undefined),
    ...overrides,
  }
}

/** 以零等待和内存锁创建可快速、确定性执行的 LiveService。 */
function service(api: LiveServiceApi): LiveService {
  return new LiveService(api, {
    confirmationPollMs: 0,
    confirmationMaxAttempts: 4,
    transitionRetryMs: 0,
    transitionMaxAttempts: 2,
    sleep: vi.fn(async () => undefined),
    lock: async (_operation, action) => action(),
    now: () => new Date('2026-08-31T00:00:00.000Z'),
  })
}

/** 覆盖单账号 Broadcast 生命周期的允许路径与失败安全门。 */
describe('LiveService', () => {
  /** 每个用例前清空持久化风险状态替身，避免断言相互污染。 */
  beforeEach(() => {
    safety.mark.mockClear()
    safety.clear.mockClear()
    safety.read.mockResolvedValue(null)
    safety.reconcile.mockClear()
  })

  /** 验证完整顺序为 bind、ingest active、testing 确认和 live 确认。 */
  it('binds, rechecks active ingest, confirms testing, then confirms live', async () => {
    const events: string[] = []
    let lifecycle = 'ready'
    let bound = false
    const api = makeApi({
      listLiveBroadcasts: vi.fn(async () => [broadcast('broadcast-1', lifecycle)]),
      getBroadcastById: vi.fn(async () => broadcast('broadcast-1', lifecycle)),
      getBroadcastContentDetails: vi.fn(async () => ({
        enableMonitorStream: true,
        enableAutoStart: false,
        boundStreamId: bound ? STREAM.streamId : undefined,
      })),
      bindBroadcast: vi.fn(async () => { events.push('bind'); bound = true }),
      getStreamStatus: vi.fn(async () => { events.push('ingest:active'); return ACTIVE_INGEST }),
      getBroadcastLifeCycleStatus: vi.fn(async () => {
        if (lifecycle !== 'ready') events.push('confirm:' + lifecycle)
        return lifecycle
      }),
      transitionBroadcast: vi.fn(async (_id, target) => {
        events.push('transition:' + target)
        lifecycle = target
      }),
    })

    const snapshot = await service(api).startBroadcast('broadcast-1')

    expect(events).toContain('bind')
    expect(events).toContain('ingest:active')
    expect(events).toContain('transition:testing')
    expect(events).toContain('confirm:testing')
    expect(events).toContain('transition:live')
    expect(events).toContain('confirm:live')
    expect(events.indexOf('ingest:active')).toBeLessThan(events.indexOf('transition:testing'))
    expect(snapshot.stage).toBe('live')
    expect(safety.mark).toHaveBeenCalledWith('broadcast-1', 'channel-1')
  })

  /** 验证明确关闭 monitor stream 时不会错误调用 testing transition。 */
  it('skips testing when monitor stream is explicitly disabled', async () => {
    let lifecycle = 'ready'
    const transition = vi.fn(async (_id: string, target: 'testing' | 'live' | 'complete') => {
      lifecycle = target
    })
    const api = makeApi({
      listLiveBroadcasts: vi.fn(async () => [broadcast('broadcast-1', lifecycle)]),
      getBroadcastById: vi.fn(async () => broadcast('broadcast-1', lifecycle)),
      getBroadcastContentDetails: vi.fn(async () => ({
        enableMonitorStream: false,
        enableAutoStart: false,
        boundStreamId: STREAM.streamId,
      })),
      getBroadcastLifeCycleStatus: vi.fn(async () => lifecycle),
      transitionBroadcast: transition,
    })

    await service(api).startBroadcast('broadcast-1')

    expect(transition).not.toHaveBeenCalledWith('broadcast-1', 'testing')
    expect(transition).toHaveBeenCalledWith('broadcast-1', 'live')
  })

  /** 验证 ingest 非 active 时任何生命周期 transition 都不会发生。 */
  it('never transitions when ingest is not active', async () => {
    const transition = vi.fn(async () => undefined)
    const api = makeApi({
      getBroadcastContentDetails: vi.fn(async () => ({
        enableMonitorStream: false,
        enableAutoStart: false,
        boundStreamId: STREAM.streamId,
      })),
      getStreamStatus: vi.fn(async () => ({ ...ACTIVE_INGEST, streamStatus: 'inactive' })),
      transitionBroadcast: transition,
    })

    await expect(service(api).startBroadcast('broadcast-1')).rejects.toMatchObject({ code: 'INGEST_NOT_ACTIVE' })
    expect(transition).not.toHaveBeenCalled()
  })

  /** 验证已绑定的精确 Stream 会被复用，且公开快照不含 Stream Key。 */
  it('reuses the exact bound stream and never guesses or rebinds', async () => {
    const bind = vi.fn(async () => undefined)
    const getById = vi.fn(async () => STREAM)
    const api = makeApi({
      bindBroadcast: bind,
      getLiveStreamById: getById,
      getBroadcastContentDetails: vi.fn(async () => ({
        enableMonitorStream: false,
        enableAutoStart: false,
        boundStreamId: STREAM.streamId,
      })),
    })

    const snapshot = await service(api).prepareBroadcast('broadcast-1')

    expect(getById).toHaveBeenCalledWith(STREAM.streamId)
    expect(bind).not.toHaveBeenCalled()
    expect(JSON.stringify(snapshot)).not.toContain(STREAM.streamName)
  })

  /** Uses the Channel's persisted reusable Stream ID when preparing an unbound Broadcast. */
  it('uses the exact persisted Channel stream before generic Stream discovery', async () => {
    let bound = false
    const getById = vi.fn(async () => STREAM)
    const discover = vi.fn(async () => STREAM)
    const api = makeApi({
      getLiveStreamById: getById,
      getOrCreateLiveStream: discover,
      bindBroadcast: vi.fn(async () => { bound = true }),
      getBroadcastContentDetails: vi.fn(async () => ({
        enableMonitorStream: false, enableAutoStart: false,
        boundStreamId: bound ? STREAM.streamId : undefined,
      })),
    })
    const subject = new LiveService(api, {
      lock: async (_operation, action) => action(),
      preferredStreamId: STREAM.streamId,
    })

    await subject.prepareBroadcast('broadcast-1')

    expect(getById).toHaveBeenCalledWith(STREAM.streamId)
    expect(discover).not.toHaveBeenCalled()
  })

  /** Persists a created Broadcast ID before a later Stream preparation failure can occur. */
  it('reports a created Broadcast before Stream preparation', async () => {
    const created = broadcast('created-broadcast')
    const seen: string[] = []
    const api = makeApi({
      listLiveBroadcasts: vi.fn(async () => []),
      createBroadcast: vi.fn(async () => created),
      getBroadcastById: vi.fn(async () => created),
      getOrCreateLiveStream: vi.fn(async () => { throw new Error('stream preparation failed') }),
    })
    const subject = new LiveService(api, {
      lock: async (_operation, action) => action(),
      onBroadcastCreated: async (item) => { seen.push(item.id) },
    })

    await expect(subject.createTestBroadcast()).rejects.toThrow('stream preparation failed')
    expect(seen).toEqual(['created-broadcast'])
  })

  /** 验证其他活动 Broadcast 会阻止新建和切换，避免控制错误直播。 */
  it('blocks create and switching when another broadcast is active', async () => {
    const create = vi.fn(async () => broadcast('new-one'))
    const api = makeApi({
      listLiveBroadcasts: vi.fn(async () => [broadcast('active-one', 'testing'), broadcast('ready-one', 'ready')]),
      createBroadcast: create,
      getBroadcastById: vi.fn(async (id) => broadcast(id, id === 'active-one' ? 'testing' : 'ready')),
    })
    const subject = service(api)

    await expect(subject.createTestBroadcast()).rejects.toMatchObject({ code: 'INVALID_STATE' })
    await expect(subject.prepareBroadcast('ready-one')).rejects.toMatchObject({ code: 'INVALID_STATE' })
    expect(create).not.toHaveBeenCalled()
    expect(api.bindBroadcast).not.toHaveBeenCalled()
  })

  /** 验证启用 YouTube Auto Start 的 Broadcast 在创建或 bind 前即被拒绝。 */
  it('rejects Auto Start before creating or binding a stream', async () => {
    const api = makeApi({
      getBroadcastContentDetails: vi.fn(async () => ({ enableAutoStart: true, enableMonitorStream: false })),
    })

    await expect(service(api).prepareBroadcast('broadcast-1')).rejects.toMatchObject({ code: 'INVALID_STATE' })
    expect(api.getOrCreateLiveStream).not.toHaveBeenCalled()
    expect(api.bindBroadcast).not.toHaveBeenCalled()
  })

  /** 验证仅活动生命周期允许 complete，且已 complete 的请求保持幂等。 */
  it('only completes active lifecycles and treats complete as idempotent', async () => {
    const readyApi = makeApi({ getBroadcastLifeCycleStatus: vi.fn(async () => 'ready') })
    await expect(service(readyApi).stopBroadcast('broadcast-1')).rejects.toMatchObject({ code: 'INVALID_STATE' })
    expect(readyApi.transitionBroadcast).not.toHaveBeenCalled()

    const completeApi = makeApi({
      getBroadcastLifeCycleStatus: vi.fn(async () => 'complete'),
      getBroadcastById: vi.fn(async () => broadcast('broadcast-1', 'complete')),
      listLiveBroadcasts: vi.fn(async () => []),
    })
    const snapshot = await service(completeApi).stopBroadcast('broadcast-1')
    expect(snapshot.stage).toBe('complete')
    expect(completeApi.transitionBroadcast).not.toHaveBeenCalled()
    expect(safety.clear).toHaveBeenCalledWith('broadcast-1')
  })
})
