/**
 * Orchestrates the server-side YouTube Broadcast lifecycle for the single-account Web
 * MVP, adapted from pjmdesi/stream-manager's mature state machine. Every mutation
 * re-reads remote state and takes a filesystem lease; browser requests can supply only
 * validated Broadcast IDs, never OAuth credentials or Stream Keys.
 */
import 'server-only'

import type {
  AppSnapshot,
  ChannelInfo,
  CreateBroadcastInput,
  LiveBroadcast,
  StreamSummary,
} from '@/shared/types'
import { isConfigured } from './config'
import { LivePilotError } from './errors'
import { withOperationLock } from './operationLock'
import { getQuotaState } from './quotaState'
import {
  clearBroadcastRisk,
  markBroadcastRisk,
  readSafetyState,
  reconcileBroadcastRisk,
} from './runtimeState'
import * as youtubeApi from './youtubeApi'
import type {
  BroadcastContentDetails,
  LiveStreamSecret,
  StreamIngestStatus,
} from './youtubeApi'

const ACTIVE_LIFE_CYCLES = new Set(['testing', 'testStarting', 'live', 'liveStarting'])

export interface LiveServiceApi {
  /** Reads the Channel associated with the server-held OAuth token. */
  getCurrentChannel: () => Promise<ChannelInfo>
  /** Lists active/upcoming Broadcasts without exposing credentials. */
  listLiveBroadcasts: () => Promise<LiveBroadcast[]>
  /** Reads one Broadcast by its exact YouTube ID. */
  getBroadcastById: (broadcastId: string) => Promise<LiveBroadcast | null>
  /** Creates a Broadcast from server-validated scheduling input. */
  createBroadcast: (input: CreateBroadcastInput) => Promise<LiveBroadcast>
  /** Selects or creates the unambiguous server-only ingest Stream. */
  getOrCreateLiveStream: () => Promise<LiveStreamSecret>
  /** Loads the server-only ingest secret for a bound Stream ID. */
  getLiveStreamById: (streamId: string) => Promise<LiveStreamSecret | null>
  /** Binds a Broadcast to a Stream and confirms the remote result. */
  bindBroadcast: (broadcastId: string, streamId: string) => Promise<void>
  /** Reads transition and binding safety controls for one Broadcast. */
  getBroadcastContentDetails: (broadcastId: string) => Promise<BroadcastContentDetails | null>
  /** Reads the authoritative YouTube Broadcast lifecycle. */
  getBroadcastLifeCycleStatus: (broadcastId: string) => Promise<string | null>
  /** Reads non-secret ingest and health state for one Stream. */
  getStreamStatus: (streamId: string) => Promise<StreamIngestStatus>
  /** Requests one allowlisted Broadcast lifecycle transition. */
  transitionBroadcast: (broadcastId: string, target: 'testing' | 'live' | 'complete') => Promise<void>
}

export interface LiveServiceOptions {
  confirmationPollMs?: number
  confirmationMaxAttempts?: number
  transitionRetryMs?: number
  transitionMaxAttempts?: number
  /** Test seam for asynchronous retry delays; production uses a Node.js timer. */
  sleep?: (milliseconds: number) => Promise<void>
  /** Test seam for Broadcast scheduling time; production reads the server clock. */
  now?: () => Date
  /** Test seam for mutation serialization; production uses the filesystem lease. */
  lock?: <T>(operation: string, action: () => Promise<T>) => Promise<T>
  /** Account/Channel-scoped risk persistence; defaults to the legacy singleton store. */
  safety?: {
    read: () => Promise<{ riskBroadcastId: string; guardedChannelId: string; markedAt: number } | null>
    mark: (broadcastId: string, channelId: string) => Promise<void>
    clear: (broadcastId?: string) => Promise<void>
    reconcile: (channelId: string, activeBroadcastIds: string[]) => Promise<void>
  }
  /** Exact Channel-owned reusable Stream reference, never a browser-provided value. */
  preferredStreamId?: string | null
}

interface Inventory {
  channel: ChannelInfo
  broadcasts: LiveBroadcast[]
  activeIds: string[]
}

/** Coordinates safe single-account Broadcast selection, binding, and transitions. */
export class LiveService {
  private readonly api: LiveServiceApi
  private readonly options: Required<Omit<LiveServiceOptions, 'sleep' | 'now' | 'lock' | 'safety' | 'preferredStreamId'>>
  /** Wait implementation used by bounded lifecycle polling and retries. */
  private readonly sleepFn: (milliseconds: number) => Promise<void>
  /** Server clock used only when constructing a new test Broadcast schedule. */
  private readonly now: () => Date
  /** Cross-request serializer guarding all state-changing operations. */
  private readonly lock: <T>(operation: string, action: () => Promise<T>) => Promise<T>
  /** Persists uncertain lifecycle state inside the owning Channel/Run scope. */
  private readonly safety: Required<NonNullable<LiveServiceOptions['safety']>>
  /** Keeps repeated Runs on the exact durable Channel Stream when it is still valid. */
  private readonly preferredStreamId: string | null

  /**
   * Creates a lifecycle service around the server-only YouTube adapter.
   * Optional timing, clock, and lock dependencies exist for deterministic tests; default
   * production dependencies keep credentials and critical sections on the server.
   */
  constructor(api: LiveServiceApi, options: LiveServiceOptions = {}) {
    this.api = api
    this.options = {
      confirmationPollMs: options.confirmationPollMs ?? 2_000,
      confirmationMaxAttempts: options.confirmationMaxAttempts ?? 15,
      transitionRetryMs: options.transitionRetryMs ?? 5_000,
      transitionMaxAttempts: options.transitionMaxAttempts ?? 3,
    }
    this.sleepFn = options.sleep ?? (
      /* Pause polling asynchronously without blocking other web requests. */
      (milliseconds) => new Promise(
        /* Resolve the injected delay only after its timer expires. */
        (resolve) => setTimeout(resolve, milliseconds),
      )
    )
    this.now = options.now ?? (
      /* Read wall-clock time only when a new Broadcast schedule is constructed. */
      () => new Date()
    )
    this.lock = options.lock ?? withOperationLock
    this.safety = options.safety ?? {
      read: readSafetyState,
      mark: markBroadcastRisk,
      clear: clearBroadcastRisk,
      reconcile: reconcileBroadcastRisk,
    }
    this.preferredStreamId = options.preferredStreamId ?? null
  }

  /**
   * Builds a fresh browser-safe dashboard snapshot from authoritative YouTube state.
   * An optional Broadcast ID selects the view but cannot inject tokens or Stream Keys;
   * bound ingest data is reduced to a non-secret status summary.
   */
  async snapshot(broadcastId?: string | null): Promise<AppSnapshot> {
    const inventory = await this.inventory()
    const selected = broadcastId
      ? inventory.broadcasts.find(
        /* Reuse the freshly listed resource only when its exact YouTube ID matches. */
        (item) => item.id === broadcastId,
      ) ?? await this.api.getBroadcastById(broadcastId)
      : null
    let stream: StreamSummary | null = null
    if (selected) {
      const details = await this.api.getBroadcastContentDetails(selected.id)
      if (details?.boundStreamId) {
        const status = await this.api.getStreamStatus(details.boundStreamId)
        stream = this.toStreamSummary(status)
      }
    }
    return this.makeSnapshot(inventory, selected, stream)
  }

  /**
   * Validates and prepares a selected Broadcast/Stream binding under the write lease.
   * The returned snapshot exposes ingest health but never the server-only Stream secret.
   */
  async prepareBroadcast(broadcastId: string): Promise<AppSnapshot> {
    return this.lock(
      'prepare-broadcast',
      /* Keep binding and its confirming snapshot inside one serialized operation. */
      async () => {
        await this.prepareInternal(broadcastId)
        return this.snapshot(broadcastId)
      },
    )
  }

  /**
   * Creates an unlisted, manually started test Broadcast and prepares its Stream binding.
   * Creation is refused while another active lifecycle exists and the whole mutation is
   * serialized to preserve the single-account safety invariant.
   */
  async createTestBroadcast(): Promise<AppSnapshot> {
    return this.lock(
      'create-broadcast',
      /* Serialize the active-state check, creation, binding, and confirmation snapshot. */
      async () => {
        const inventory = await this.inventory()
        this.assertNoActiveBroadcast(inventory, '创建新的测试 Broadcast')
        const now = this.now()
        const scheduled = new Date(now.getTime() + 5 * 60 * 1000)
        const created = await this.api.createBroadcast({
          title: 'LivePilot 测试直播 ' + new Intl.DateTimeFormat('zh-CN', {
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
          }).format(now),
          description: '由 LivePilot 单账号 Web MVP 创建。',
          scheduledStartTime: scheduled.toISOString(),
          privacyStatus: 'unlisted',
        })
        await this.prepareInternal(created.id)
        return this.snapshot(created.id)
      },
    )
  }

  /**
   * Starts a prepared Broadcast only after exact lifecycle, binding, and active-ingest
   * checks. Testing is used only when YouTube's monitor configuration requires it, and
   * every transition is remotely confirmed before a live snapshot is returned.
   */
  async startBroadcast(broadcastId: string): Promise<AppSnapshot> {
    return this.lock(
      'start-broadcast',
      /* Keep all safety re-reads and transition confirmations under the write lease. */
      async () => {
        const inventory = await this.inventory()
        this.assertNoOtherActiveBroadcast(inventory, broadcastId)
        const initial = await this.requireBroadcast(broadcastId)
        if (initial.status.lifeCycleStatus === 'live') return this.snapshot(broadcastId)
        if (initial.status.lifeCycleStatus === 'complete') {
          throw new LivePilotError('INVALID_STATE', '此 Broadcast 已完成，不能再次开始。', { retryable: false })
        }

        const { stream } = await this.prepareInternal(broadcastId)
        const ingest = await this.api.getStreamStatus(stream.streamId)
        if (ingest.streamStatus !== 'active') {
          const issue = ingest.configurationIssues[0]
          throw new LivePilotError(
            'INGEST_NOT_ACTIVE',
            issue ? 'YouTube ingest 未 active：' + issue : 'YouTube ingest 尚未进入 active。',
          )
        }

        // Re-read after OBS/selection time; never transition from a stale lifecycle.
        let current = await this.api.getBroadcastLifeCycleStatus(broadcastId)
        const details = await this.api.getBroadcastContentDetails(broadcastId)
        if (!current || !details) throw new LivePilotError('NO_BROADCAST', 'Broadcast 状态无法读取。')
        if (current === 'live') return this.snapshot(broadcastId)
        if (current === 'complete') {
          throw new LivePilotError('INVALID_STATE', '此 Broadcast 已完成，不能再次开始。', { retryable: false })
        }

        await this.safety.mark(broadcastId, inventory.channel.id)
        if (current === 'liveStarting') {
          current = await this.waitForLifeCycle(broadcastId, ['live'])
          if (current !== 'live') throw new LivePilotError('LIVE_TRANSITION_FAILED', 'YouTube 未确认 liveStarting 进入 live。')
          return this.snapshot(broadcastId)
        }

        if (current === 'testing' || current === 'testStarting') {
          current = current === 'testing'
            ? 'testing'
            : await this.waitForLifeCycle(broadcastId, ['testing', 'live'])
          if (current === 'live') return this.snapshot(broadcastId)
          if (current !== 'testing') {
            throw new LivePilotError('TESTING_TRANSITION_FAILED', 'YouTube 未确认 testStarting 进入 testing。')
          }
        } else if (details.enableMonitorStream === true) {
          await this.transitionAndConfirmTesting(broadcastId)
        } else if (details.enableMonitorStream !== false) {
          throw new LivePilotError(
            'INVALID_STATE',
            'YouTube 未返回 monitorStream.enableMonitorStream；LivePilot 不会猜测 testing 路径。',
          )
        }

        await this.transitionAndConfirmLive(broadcastId)
        return this.snapshot(broadcastId)
      },
    )
  }

  /**
   * Completes a currently active Broadcast and clears its safety marker only after
   * YouTube confirms the terminal lifecycle. Non-active states fail closed.
   */
  async stopBroadcast(broadcastId: string): Promise<AppSnapshot> {
    return this.lock(
      'stop-broadcast',
      /* Serialize terminal transition, confirmation, marker cleanup, and snapshot. */
      async () => {
        const current = await this.api.getBroadcastLifeCycleStatus(broadcastId)
        if (current === 'complete') {
          await this.safety.clear(broadcastId)
          return this.snapshot(broadcastId)
        }
        if (!current) throw new LivePilotError('NO_BROADCAST', 'YouTube 找不到当前 Broadcast。')
        if (!ACTIVE_LIFE_CYCLES.has(current)) {
          throw new LivePilotError(
            'INVALID_STATE',
            '当前 Broadcast 状态为 ' + current + '，不能执行 complete。',
            { retryable: false },
          )
        }
        await this.transitionAndConfirmComplete(broadcastId)
        await this.safety.clear(broadcastId)
        return this.snapshot(broadcastId)
      },
    )
  }

  /**
   * Proves that no active or unconfirmed Broadcast remains before OAuth disconnect.
   * The guard runs under the write lease so token removal cannot race a transition.
   */
  async assertSafeToDisconnect(): Promise<void> {
    await this.lock(
      'disconnect',
      /* Reconcile remote inventory and the persisted risk marker atomically. */
      async () => {
        const inventory = await this.inventory()
        const risk = await this.safety.read()
        if (inventory.activeIds.length > 0 || risk) {
          throw new LivePilotError(
            'INVALID_STATE',
            '账号仍有 testing / live Broadcast，或上一次 transition 尚未确认安全结束。',
            {
              action: '先选择活动 Broadcast 并确认 complete；故障时立即在 YouTube Studio 手工结束。',
              retryable: false,
            },
          )
        }
      },
    )
  }

  /**
   * Rebuilds the authorized Channel inventory and reconciles persisted risk state.
   * A risk marker from a different Channel fails closed, and clearing requires an exact
   * authoritative lifecycle read rather than absence from the abbreviated list.
   */
  private async inventory(): Promise<Inventory> {
    const channel = await this.api.getCurrentChannel()
    const broadcasts = await this.api.listLiveBroadcasts()
    const activeIds = broadcasts
      .filter(
        /* Retain only lifecycles in which LivePilot must guard transitions/disconnect. */
        (item) => ACTIVE_LIFE_CYCLES.has(item.status.lifeCycleStatus),
      )
      .map(
        /* Persist and compare only YouTube Broadcast IDs, not the mutable resource body. */
        (item) => item.id,
      )
    const existingRisk = await this.safety.read()
    if (existingRisk && existingRisk.guardedChannelId !== channel.id) {
      throw new LivePilotError(
        'INVALID_STATE',
        '当前授权频道与尚未确认结束的原频道不一致。',
        { action: '重新授权原频道，或先在 YouTube Studio 确认原直播已结束。', retryable: false },
      )
    }
    if (activeIds.length > 0) {
      await this.safety.reconcile(channel.id, activeIds)
    } else if (existingRisk) {
      const exact = await this.api.getBroadcastLifeCycleStatus(existingRisk.riskBroadcastId)
      if (exact && ACTIVE_LIFE_CYCLES.has(exact)) {
        activeIds.push(existingRisk.riskBroadcastId)
      } else if (exact) {
        await this.safety.clear(existingRisk.riskBroadcastId)
      }
    }
    return { channel, broadcasts, activeIds }
  }

  /**
   * Ensures one Broadcast has an unambiguous reusable Stream binding.
   * It refuses completed resources, unsafe Auto Start, active rebinding, or uncertain
   * bind confirmation; the returned Stream secret remains inside server orchestration.
   */
  private async prepareInternal(broadcastId: string): Promise<{ stream: LiveStreamSecret }> {
    const inventory = await this.inventory()
    this.assertNoOtherActiveBroadcast(inventory, broadcastId)
    const broadcast = await this.requireBroadcast(broadcastId)
    const lifeCycle = broadcast.status.lifeCycleStatus
    if (lifeCycle === 'complete') {
      throw new LivePilotError('INVALID_STATE', '已完成的 Broadcast 不能再次绑定。', { retryable: false })
    }
    const details = await this.api.getBroadcastContentDetails(broadcastId)
    if (!details) throw new LivePilotError('NO_BROADCAST', 'Broadcast contentDetails 无法读取。')
    if (details.enableAutoStart === true && !ACTIVE_LIFE_CYCLES.has(lifeCycle)) {
      throw new LivePilotError(
        'INVALID_STATE',
        '此 Broadcast 启用了 Auto Start；OBS 推流可能绕过网页“开始直播”。',
        { action: '在 YouTube Studio 关闭 Auto Start，或使用 LivePilot 创建测试直播。', retryable: false },
      )
    }
    const stream = details.boundStreamId
      ? await this.api.getLiveStreamById(details.boundStreamId)
      : this.preferredStreamId
        ? await this.api.getLiveStreamById(this.preferredStreamId)
        : await this.api.getOrCreateLiveStream()
    if (!stream) throw new LivePilotError('NO_STREAM', '已绑定的 YouTube Stream 不存在。')
    if (!details.boundStreamId) {
      if (ACTIVE_LIFE_CYCLES.has(lifeCycle)) {
        throw new LivePilotError('BIND_FAILED', '活动 Broadcast 没有 boundStreamId，服务端不会在直播中改绑。')
      }
      await this.api.bindBroadcast(broadcastId, stream.streamId)
      const confirmed = await this.api.getBroadcastContentDetails(broadcastId)
      if (confirmed?.boundStreamId !== stream.streamId) {
        throw new LivePilotError('BIND_FAILED', '回读 contentDetails 未确认目标 Stream 绑定。')
      }
    }
    return { stream }
  }

  /**
   * Loads a Broadcast by exact YouTube ID or raises the domain-specific missing error.
   * This authoritative server read prevents callers from acting on browser-cached data.
   */
  private async requireBroadcast(broadcastId: string): Promise<LiveBroadcast> {
    const broadcast = await this.api.getBroadcastById(broadcastId)
    if (!broadcast) throw new LivePilotError('NO_BROADCAST', '选择的 Broadcast 已不存在。')
    return broadcast
  }

  /**
   * Enforces the single-account invariant before creating a new Broadcast.
   * `action` is diagnostic text only and cannot alter the guard decision.
   */
  private assertNoActiveBroadcast(inventory: Inventory, action: string): void {
    if (inventory.activeIds.length === 0) return
    throw new LivePilotError(
      'INVALID_STATE',
      '账号内存在 testing / live Broadcast，不能' + action + '。',
      { action: '先选择活动 Broadcast 并确认 complete。', retryable: false },
    )
  }

  /**
   * Rejects control of `broadcastId` while any different Broadcast is active.
   * IDs originate from the server-side inventory, preventing browser target switching.
   */
  private assertNoOtherActiveBroadcast(inventory: Inventory, broadcastId: string): void {
    if (!inventory.activeIds.some(
      /* Detect only an active ID other than the exact requested control target. */
      (id) => id !== broadcastId,
    )) return
    throw new LivePilotError(
      'INVALID_STATE',
      '另一个 Broadcast 仍处于 testing / live，服务端不会切换控制目标。',
      { action: '先结束当前活动 Broadcast。', retryable: false },
    )
  }

  /**
   * Requests testing once and confirms either testing or an already-live terminal result.
   * Only Google's redundant-transition response is tolerated; fatal server/API failures
   * retain their domain-specific remediation.
   */
  private async transitionAndConfirmTesting(broadcastId: string): Promise<void> {
    try {
      await this.api.transitionBroadcast(broadcastId, 'testing')
    } catch (error) {
      if (!this.isRedundantTransition(error)) this.rethrowFatal(error)
    }
    const confirmed = await this.waitForLifeCycle(broadcastId, ['testing', 'live'])
    if (!confirmed || !['testing', 'live'].includes(confirmed)) {
      throw new LivePilotError('TESTING_TRANSITION_FAILED', 'YouTube 未确认 Broadcast 进入 testing。')
    }
  }

  /**
   * Retries the live transition within the configured bounded budget and confirms each
   * attempt through an authoritative lifecycle read before reporting success.
   */
  private async transitionAndConfirmLive(broadcastId: string): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < this.options.transitionMaxAttempts; attempt += 1) {
      try {
        await this.api.transitionBroadcast(broadcastId, 'live')
      } catch (error) {
        lastError = error
        if (!this.isRedundantTransition(error)) this.rethrowFatal(error)
      }
      if (await this.waitForLifeCycle(broadcastId, ['live'], false) === 'live') return
      if (attempt + 1 < this.options.transitionMaxAttempts) await this.sleepFn(this.options.transitionRetryMs)
    }
    throw new LivePilotError(
      'LIVE_TRANSITION_FAILED',
      lastError instanceof Error ? lastError.message : 'YouTube 未确认 Broadcast 进入 live。',
      { cause: lastError },
    )
  }

  /**
   * Retries the complete transition within the configured bounded budget.
   * Success requires YouTube to report `complete`; local intent alone never clears risk.
   */
  private async transitionAndConfirmComplete(broadcastId: string): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < this.options.transitionMaxAttempts; attempt += 1) {
      try {
        await this.api.transitionBroadcast(broadcastId, 'complete')
      } catch (error) {
        lastError = error
        if (!this.isRedundantTransition(error)) this.rethrowFatal(error)
      }
      if (await this.waitForLifeCycle(broadcastId, ['complete'], false) === 'complete') return
      if (attempt + 1 < this.options.transitionMaxAttempts) await this.sleepFn(this.options.transitionRetryMs)
    }
    throw new LivePilotError(
      'COMPLETE_TRANSITION_FAILED',
      lastError instanceof Error ? lastError.message : 'YouTube 未确认 Broadcast 进入 complete。',
      { cause: lastError },
    )
  }

  /**
   * Polls the authoritative Broadcast lifecycle until one expected state appears.
   * `fullBudget=false` partitions the total confirmation budget between transition retries;
   * the last observed state is returned for precise failure handling.
   */
  private async waitForLifeCycle(
    broadcastId: string,
    expected: string[],
    fullBudget = true,
  ): Promise<string | null> {
    const attempts = fullBudget
      ? this.options.confirmationMaxAttempts
      : Math.max(2, Math.ceil(this.options.confirmationMaxAttempts / this.options.transitionMaxAttempts))
    let current: string | null = null
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      current = await this.api.getBroadcastLifeCycleStatus(broadcastId)
      if (current && expected.includes(current)) return current
      if (attempt + 1 < attempts) await this.sleepFn(this.options.confirmationPollMs)
    }
    return current
  }

  /**
   * Immediately propagates errors for which retrying a transition is unsafe or useless.
   * Unknown transition errors remain eligible for bounded state confirmation/retry.
   */
  private rethrowFatal(error: unknown): void {
    if (error instanceof LivePilotError && [
      'CONFIG_MISSING',
      'NOT_CONNECTED',
      'TOKEN_INVALID',
      'LIVE_STREAMING_NOT_ENABLED',
      'LIVE_PERMISSION_BLOCKED',
      'QUOTA_EXCEEDED',
      'NETWORK_ERROR',
      'INGEST_NOT_ACTIVE',
    ].includes(error.code)) throw error
  }

  /**
   * Detects YouTube responses meaning the requested lifecycle transition already occurred.
   * The check accepts structured reason codes first and narrowly falls back to text.
   */
  private isRedundantTransition(error: unknown): boolean {
    if (error instanceof LivePilotError && error.apiReasons.includes('redundantTransition')) return true
    return /redundant|already (?:live|complete|testing)/i.test(error instanceof Error ? error.message : String(error))
  }

  /**
   * Reduces server-only Stream status to the browser-safe dashboard shape.
   * Ingestion address and Stream Key are deliberately absent, and issue arrays are copied.
   */
  private toStreamSummary(status: StreamIngestStatus): StreamSummary {
    return {
      id: status.streamId,
      title: status.title,
      streamStatus: status.streamStatus,
      healthStatus: status.healthStatus,
      configurationIssues: [...status.configurationIssues],
    }
  }

  /**
   * Combines reconciled inventory and selected status into the public application snapshot.
   * UI stage is derived from YouTube lifecycle/ingest state and the result contains no
   * OAuth token, client secret, ingestion address, or Stream Key.
   */
  private makeSnapshot(
    inventory: Inventory,
    selected: LiveBroadcast | null,
    stream: StreamSummary | null,
  ): AppSnapshot {
    const lifeCycle = selected?.status.lifeCycleStatus
    const stage = lifeCycle === 'live'
      ? 'live'
      : lifeCycle === 'liveStarting'
        ? 'waiting'
        : lifeCycle === 'testing' || lifeCycle === 'testStarting'
          ? 'testing'
          : lifeCycle === 'complete'
            ? 'complete'
            : stream?.streamStatus === 'active'
              ? 'ready'
              : selected
                ? 'waiting'
                : 'offline'
    return {
      configured: isConfigured(),
      connected: true,
      channel: inventory.channel,
      broadcasts: inventory.broadcasts,
      selectedBroadcastId: selected?.id ?? null,
      selectedBroadcast: selected,
      stream,
      stage,
      quota: getQuotaState(),
      error: null,
    }
  }
}

const globalService = globalThis as typeof globalThis & { __livePilotService?: LiveService }
export const liveService = globalService.__livePilotService ??= new LiveService(youtubeApi)
