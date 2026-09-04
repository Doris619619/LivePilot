/**
 * Coordinates one Channel-scoped Live Run from immutable Job snapshot through FFmpeg,
 * YouTube ingest confirmation, lifecycle transitions, and ordered shutdown.
 */
import 'server-only'

import { LiveService } from './liveService'
import { createChannelYouTubeApi } from './channelYoutubeApi'
import { createRunSafetyState } from './runSafetyState'
import { withNamedOperationLock } from './operationLock'
import { LivePilotError, toPublicError } from './errors'
import { resolveRunMedia } from './mediaLibrary'
import { FfmpegWorker, workerRegistry, type WorkerExit, type WorkerProgress } from './ffmpegWorker'
import {
  createRun,
  makeProgress,
  requireChannel,
  requireJob,
  requireRun,
  setReusableStream,
  updateRun,
} from './controlPlaneStore'

const INGEST_POLL_MS = 2_000
const INGEST_MAX_ATTEMPTS = 15

/** Acquires connection then Channel locks in the only allowed cross-scope order. */
async function withChannelOperation<T>(
  connectionId: string,
  channelId: string,
  operation: string,
  action: () => Promise<T>,
): Promise<T> {
  return withNamedOperationLock('connection-' + connectionId, operation, () =>
    withNamedOperationLock('channel-' + channelId, operation, action),
  )
}

/** Sleeps without blocking concurrent workers while YouTube ingest transitions to active. */
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

/** Coordinates all state-changing Run operations while keeping the browser outside secret-bearing calls. */
export class RunCoordinator {
  /** Creates a Run, binds a reusable Stream, starts FFmpeg, and confirms YouTube live. */
  async start(jobId: string) {
    const job = await requireJob(jobId)
    const channel = await requireChannel(job.channelId)
    return withChannelOperation(channel.connectionId, channel.id, 'start-run', async () => {
      const latestJob = await requireJob(jobId)
      const run = await createRun(latestJob)
      const api = createChannelYouTubeApi(channel.connectionId)
      const service = new LiveService(api, {
        lock: async (_operation, action) => action(),
        safety: createRunSafetyState(channel.id, channel.youtubeChannelId, run.id),
        preferredStreamId: channel.reusableStreamId,
        onBroadcastCreated: async (broadcast) => {
          await updateRun(run.id, {
            broadcastId: broadcast.id,
            phase: 'preparing',
            youtubeLifecycle: broadcast.status.lifeCycleStatus,
          })
        },
      })
      try {
        const prepared = await service.createTestBroadcast()
        const broadcastId = prepared.selectedBroadcastId
        const streamId = prepared.stream?.id
        if (!broadcastId || !streamId) throw new LivePilotError('NO_STREAM', 'Broadcast 未返回已绑定的 YouTube Stream。')
        const stream = await api.getLiveStreamById(streamId)
        if (!stream) throw new LivePilotError('NO_STREAM', '绑定 Stream 缺少服务器 ingest 信息。')
        await setReusableStream(channel.id, stream.streamId)
        await updateRun(run.id, { broadcastId, streamId, phase: 'waiting_for_worker', youtubeLifecycle: prepared.selectedBroadcast?.status.lifeCycleStatus ?? null })

        const media = await resolveRunMedia(run.jobSnapshot.videoAssetId, run.jobSnapshot.audioAssetIds)
        const worker = await FfmpegWorker.start({
          runId: run.id, videoPath: media.videoPath, audioPaths: media.audioPaths,
          ingestionAddress: stream.ingestionAddress, streamName: stream.streamName,
        }, this.workerEvents(run.id))
        workerRegistry().set(run.id, worker)
        await updateRun(run.id, { workerPhase: 'starting', phase: 'waiting_for_worker' })
        await worker.waitForPushing()
        await updateRun(run.id, { workerPhase: 'pushing', phase: 'waiting_for_ingest' })

        await this.waitForIngest(run.id, api, streamId)
        await updateRun(run.id, { phase: 'transitioning_live', ingestStatus: 'active' })
        const snapshot = await service.startBroadcast(broadcastId)
        await updateRun(run.id, { phase: 'live', youtubeLifecycle: snapshot.selectedBroadcast?.status.lifeCycleStatus ?? 'live', ingestStatus: snapshot.stream?.streamStatus ?? 'active' })
        return requireRun(run.id)
      } catch (error) {
        const publicError = toPublicError(error)
        const current = await requireRun(run.id)
        // A transition error may be ambiguous; retain a pushing worker and the Run for explicit Stop/reconciliation.
        if (current.phase !== 'transitioning_live') {
          const worker = workerRegistry().get(run.id)
          if (worker && !worker.hasExited) await worker.stop().catch(() => undefined)
          workerRegistry().delete(run.id)
          await updateRun(run.id, { phase: 'failed', error: publicError, endedAt: new Date().toISOString() })
        } else {
          await updateRun(run.id, { phase: 'failed', error: publicError })
        }
        throw error
      }
    })
  }

  /** Completes YouTube first, then stops only the exact in-memory worker associated with this Run. */
  async stop(runId: string) {
    const run = await requireRun(runId)
    const channel = await requireChannel(run.channelId)
    return withChannelOperation(channel.connectionId, channel.id, 'stop-run', async () => {
      const current = await requireRun(runId)
      if (!current.broadcastId) throw new LivePilotError('NO_BROADCAST', 'Live Run 尚未准备 Broadcast。', { retryable: false })
      await updateRun(runId, { phase: 'stopping', youtubeLifecycle: current.youtubeLifecycle })
      const api = createChannelYouTubeApi(channel.connectionId)
      const service = new LiveService(api, {
        lock: async (_operation, action) => action(),
        safety: createRunSafetyState(channel.id, channel.youtubeChannelId, runId),
      })
      try {
        const snapshot = await service.stopBroadcast(current.broadcastId)
        await updateRun(runId, { youtubeLifecycle: snapshot.selectedBroadcast?.status.lifeCycleStatus ?? 'complete' })
      } catch (error) {
        await updateRun(runId, { phase: 'stop_failed', error: toPublicError(error) })
        throw error
      }
      const worker = workerRegistry().get(runId)
      if (!worker) {
        await updateRun(runId, {
          phase: 'stop_failed', workerPhase: 'recovery_required',
          error: { code: 'WORKER_CRASHED', message: '服务重启后无法安全接管旧 FFmpeg PID。', action: '确认本机 FFmpeg 已停止后刷新状态。', retryable: false },
        })
        return requireRun(runId)
      }
      try {
        await worker.stop()
        workerRegistry().delete(runId)
        await updateRun(runId, { phase: 'completed', workerPhase: 'stopped', endedAt: new Date().toISOString() })
      } catch (error) {
        await updateRun(runId, { phase: 'stop_failed', error: toPublicError(error) })
        throw error
      }
      return requireRun(runId)
    })
  }

  /** Waits for YouTube's authoritative Stream state, retaining worker telemetry between polls. */
  private async waitForIngest(runId: string, api: ReturnType<typeof createChannelYouTubeApi>, streamId: string): Promise<void> {
    let lastStatus: string | null = null
    for (let attempt = 0; attempt < INGEST_MAX_ATTEMPTS; attempt += 1) {
      const status = await api.getStreamStatus(streamId)
      lastStatus = status.streamStatus
      await updateRun(runId, { ingestStatus: lastStatus })
      if (status.streamStatus === 'active') return
      if (attempt + 1 < INGEST_MAX_ATTEMPTS) await sleep(INGEST_POLL_MS)
    }
    const worker = workerRegistry().get(runId)
    if (worker) await worker.stop().catch(() => undefined)
    await updateRun(runId, { workerPhase: 'stopped', phase: 'failed', ingestStatus: lastStatus, error: { code: 'INGEST_TIMEOUT', message: 'YouTube 未在限定时间内确认 ingest active。', action: '检查网络、频道权限和 FFmpeg 本机状态后重试。', retryable: true }, endedAt: new Date().toISOString() })
    throw new LivePilotError('INGEST_TIMEOUT', 'YouTube ingest 未在限定时间内进入 active。')
  }

  /** Persists worker callbacks without exposing the process handle or unredacted stderr to routes. */
  private workerEvents(runId: string) {
    return {
      onProgress: async (progress: WorkerProgress) => {
        const run = await requireRun(runId)
        await updateRun(runId, {
          workerPhase: 'pushing',
          progress: makeProgress(run.progress, progress),
        })
      },
      onExit: async (exit: WorkerExit) => {
        workerRegistry().delete(runId)
        const run = await requireRun(runId)
        if (run.phase === 'stopping' || run.phase === 'completed') {
          await updateRun(runId, { workerPhase: 'stopped', exitCode: exit.code, stderrSummary: exit.stderrSummary })
          return
        }
        await updateRun(runId, {
          workerPhase: 'crashed', phase: 'failed', exitCode: exit.code, stderrSummary: exit.stderrSummary,
          error: { code: 'WORKER_CRASHED', message: 'FFmpeg 已异常退出。', action: '确认 YouTube 状态后结束或重新启动此 Live Job。', retryable: true },
          endedAt: new Date().toISOString(),
        })
      },
    }
  }
}

export const runCoordinator = new RunCoordinator()
