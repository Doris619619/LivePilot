/**
 * Orchestrates Channel-scoped Runs in the only safe order: verify inactive OBS, create
 * and bind YouTube resources, start OBS, wait for ingest, then transition live. Stop
 * confirms YouTube complete before touching OBS, so a failed complete never cuts video.
 */
import 'server-only'

import { sealJson, unsealJson } from './cryptoBox'
import { LivePilotError, toPublicError } from './errors'
import { withNamedOperationLock } from './operationLock'
import { ObsControlClient, type ObsEndpoint } from './obsControlClient'
import { createChannelYouTubeApi } from './channelYoutubeApi'
import { LiveService, type LiveServiceApi } from './liveService'
import { createRun, listRecords, observeObs, requireChannel, requireObsForChannel, requireRun, setReusableStream, updateRun } from './controlPlaneStore'

const POLL_MS = 2_000
const POLL_ATTEMPTS = 15

/** Produces a fixed-loopback endpoint by decrypting an OBS password only on the server. */
function endpoint(obs: { host: '127.0.0.1'; port: number; passwordCiphertext: string }): ObsEndpoint { return { host: '127.0.0.1', port: obs.port, password: unsealJson<{ password: string }>(obs.passwordCiphertext).password } }
/** Waits asynchronously while an OBS output reaches YouTube. */
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }
/** Acquires the Connection lock before its Channel lock, preserving the global lock order. */
function withChannelLock<T>(connectionId: string, channelId: string, operation: string, action: () => Promise<T>): Promise<T> {
  return withNamedOperationLock('connection-' + connectionId, operation, () => withNamedOperationLock('channel-' + channelId, operation, action))
}
/** Creates a safe default Broadcast independent of OBS scene or media configuration. */
function broadcastInput() { const now = new Date(); return { title: 'LivePilot OBS 测试直播 ' + now.toLocaleString('zh-CN'), description: '由 LivePilot Portable OBS 控制面创建。', scheduledStartTime: new Date(now.getTime() + 5 * 60_000).toISOString(), privacyStatus: 'unlisted' as const } }

/** Declares exactly the OBS calls that the run orchestration is allowed to make. */
export interface ObsControlPort {
  getStreamStatus(endpoint: ObsEndpoint): Promise<{ active: boolean }>
  startStream(endpoint: ObsEndpoint): Promise<void>
  stopStream(endpoint: ObsEndpoint): Promise<void>
}

/** Exposes deterministic seams for lifecycle tests without widening production behavior. */
export interface RunCoordinatorOptions {
  obsClient?: ObsControlPort
  apiFor?: (connectionId: string) => LiveServiceApi
  sleep?: (milliseconds: number) => Promise<void>
  pollAttempts?: number
}

/** Coordinates OBS and YouTube state for one local control plane. */
export class RunCoordinator {
  private readonly obsClient: ObsControlPort
  private readonly apiFor: (connectionId: string) => LiveServiceApi
  private readonly sleepFn: (milliseconds: number) => Promise<void>
  private readonly pollAttempts: number

  /** Creates the coordinator with production adapters or deterministic test replacements. */
  constructor(options: RunCoordinatorOptions = {}) {
    this.obsClient = options.obsClient ?? new ObsControlClient()
    this.apiFor = options.apiFor ?? createChannelYouTubeApi
    this.sleepFn = options.sleep ?? sleep
    this.pollAttempts = options.pollAttempts ?? POLL_ATTEMPTS
  }

  /** Creates a Channel-scoped lifecycle service with the outer Run lock already held. */
  private lifecycle(api: LiveServiceApi, channelId: string): LiveService {
    return new LiveService(api, {
      lock: async (_operation, action) => action(), safetyScope: channelId, sleep: this.sleepFn,
      confirmationPollMs: POLL_MS, confirmationMaxAttempts: this.pollAttempts,
      transitionRetryMs: POLL_MS, transitionMaxAttempts: this.pollAttempts,
    })
  }

  /** Registers/replaces the unique OBS instance for a Channel after server-side encryption. */
  async registerObs(channelId: string, label: string, port: number, password: string): Promise<void> {
    const { registerObsInstance } = await import('./controlPlaneStore')
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new LivePilotError('INVALID_STATE', 'OBS WebSocket 端口必须是 1024–65535 的整数。', { retryable: false })
    if (!label.trim() || label.trim().length > 120 || !password || password.length > 1024) throw new LivePilotError('INVALID_STATE', 'OBS 标签或 WebSocket 密码无效。', { retryable: false })
    await registerObsInstance({ channelId, label: label.trim(), port, passwordCiphertext: sealJson({ password }) })
  }
  /** Refreshes an OBS endpoint and unblocks recovery only after it is authoritatively inactive. */
  async refreshObs(channelId: string): Promise<void> {
    const obs = await requireObsForChannel(channelId); const client = this.obsClient
    try { const status = await client.getStreamStatus(endpoint(obs)); await observeObs(obs.id, status.active ? 'active' : 'inactive'); if (!status.active) { const pending = (await listRecords()).runs.filter((run) => run.obsInstanceId === obs.id && run.phase === 'recovery_required'); await Promise.all(pending.map((run) => updateRun(run.id, { phase: 'failed', obsState: 'inactive', obsLastSeenAt: new Date().toISOString() }))) } }
    catch (error) { await observeObs(obs.id, 'disconnected'); throw error }
  }
  /** Starts an independently configured Portable OBS and then safely transitions its Channel live. */
  async start(channelId: string): Promise<void> {
    const channel = await requireChannel(channelId)
    await withChannelLock(channel.connectionId, channel.id, 'start-run', async () => {
      const obs = await requireObsForChannel(channel.id); const client = this.obsClient
      let initial
      try { initial = await client.getStreamStatus(endpoint(obs)); await observeObs(obs.id, initial.active ? 'active' : 'inactive') }
      catch (error) { await observeObs(obs.id, 'disconnected'); throw error }
      if (initial.active) throw new LivePilotError('OBS_ALREADY_STREAMING', 'OBS 已处于推流状态，拒绝接管未知输出。', { retryable: false })
      const run = await createRun(channel.id, obs.id); const api = this.apiFor(channel.connectionId); let obsStarted = false
      try {
        const broadcast = await api.createBroadcast(broadcastInput()); await updateRun(run.id, { broadcastId: broadcast.id, youtubeLifecycle: broadcast.status.lifeCycleStatus })
        const stream = channel.reusableStreamId ? await api.getLiveStreamById(channel.reusableStreamId) : await api.getOrCreateLiveStream()
        if (!stream) throw new LivePilotError('NO_STREAM', 'Channel 的 reusable Stream 不存在。')
        if (!channel.reusableStreamId) await setReusableStream(channel.id, stream.streamId)
        await api.bindBroadcast(broadcast.id, stream.streamId); await updateRun(run.id, { streamId: stream.streamId })
        await client.startStream(endpoint(obs)); obsStarted = true; const activeAt = new Date().toISOString(); await observeObs(obs.id, 'active'); await updateRun(run.id, { phase: 'waiting_for_ingest', obsState: 'active', obsLastSeenAt: activeAt })
        let ingest = null
        for (let attempt = 0; attempt < this.pollAttempts; attempt += 1) { ingest = await api.getStreamStatus(stream.streamId); await updateRun(run.id, { ingestStatus: ingest.streamStatus }); if (ingest.streamStatus === 'active') break; if (attempt + 1 < this.pollAttempts) await this.sleepFn(POLL_MS) }
        if (ingest?.streamStatus !== 'active') throw new LivePilotError('INGEST_TIMEOUT', 'OBS 已启动，但 YouTube ingest 未在限定时间内 active。')
        await updateRun(run.id, { phase: 'transitioning_live' })
        await this.lifecycle(api, channel.id).startBroadcast(broadcast.id)
        await updateRun(run.id, { phase: 'live', youtubeLifecycle: 'live' })
      } catch (error) { await updateRun(run.id, { phase: obsStarted ? 'recovery_required' : 'failed', obsState: obsStarted ? 'recovery_required' : 'unknown', error: toPublicError(error) }); if (obsStarted) await observeObs(obs.id, 'recovery_required'); throw error }
    })
  }
  /** Stops in the mandated order: YouTube complete first, then OBS inactive, then Run complete. */
  async stop(runId: string): Promise<void> {
    const run = await requireRun(runId); const channel = await requireChannel(run.channelId)
    await withChannelLock(channel.connectionId, channel.id, 'stop-run', async () => {
      const latest = await requireRun(runId); if (!latest.broadcastId) throw new LivePilotError('INVALID_STATE', 'Run 尚无 Broadcast，不能安全结束。', { retryable: false })
      const api = this.apiFor(channel.connectionId)
      try { await this.lifecycle(api, channel.id).stopBroadcast(latest.broadcastId) } catch (error) { await updateRun(latest.id, { phase: 'stop_failed', error: toPublicError(error) }); throw error }
      const obs = await requireObsForChannel(channel.id); const client = this.obsClient
      try { await client.stopStream(endpoint(obs)); const seen = new Date().toISOString(); await observeObs(obs.id, 'inactive'); await updateRun(latest.id, { phase: 'completed', youtubeLifecycle: 'complete', obsState: 'inactive', obsLastSeenAt: seen, endedAt: seen }) }
      catch (error) { await observeObs(obs.id, 'recovery_required'); await updateRun(latest.id, { phase: 'recovery_required', youtubeLifecycle: 'complete', obsState: 'recovery_required', obsError: toPublicError(error), error: toPublicError(error) }); throw new LivePilotError('OBS_STOP_FAILED', 'YouTube 已 complete，但 OBS 未确认停止；需要恢复确认。', { cause: error, retryable: false }) }
    })
  }
}

const globalCoordinator = globalThis as typeof globalThis & { __livePilotRunCoordinator?: RunCoordinator }
/** Reuses the stateless coordinator between Next.js route invocations. */
export const runCoordinator = globalCoordinator.__livePilotRunCoordinator ??= new RunCoordinator()
