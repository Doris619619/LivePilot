/**
 * Provides browser-safe control-plane reads and validated Job creation above the
 * connection/channel/job/run repositories. It deliberately exposes no local paths or
 * YouTube ingest credentials.
 */
import 'server-only'

import type { ControlPlaneSnapshot } from '@/shared/types'
import { createJob, listControlPlaneRecords } from './controlPlaneStore'
import { isConfigured } from './config'
import { listMediaAssets, resolveRunMedia } from './mediaLibrary'
import { isTokenConnected } from './youtubeAuth'
import { LivePilotError } from './errors'
import { migrateLegacySingleAccount } from './legacyMigration'

/** Builds the complete public control-plane snapshot with only safe metadata. */
export async function controlPlaneSnapshot(): Promise<ControlPlaneSnapshot> {
  await migrateLegacySingleAccount()
  const [records, media] = await Promise.all([listControlPlaneRecords(), listMediaAssets()])
  const connections = await Promise.all(records.connections.map(async (connection) => ({
    id: connection.id, label: connection.label, connected: await isTokenConnected(connection.id).catch(() => false),
  })))
  return {
    configured: isConfigured(),
    connections,
    channels: records.channels.map((channel) => ({
      id: channel.id, connectionId: channel.connectionId, youtubeChannelId: channel.youtubeChannelId,
      title: channel.title, reusableStreamId: channel.reusableStreamId,
    })),
    jobs: records.jobs.map((job) => ({
      id: job.id, channelId: job.channelId, name: job.name, videoAssetId: job.videoAssetId,
      audioAssetIds: [...job.audioAssetIds], loopVideo: job.loopVideo, loopAudio: job.loopAudio, updatedAt: job.updatedAt,
    })),
    runs: records.runs.map((run) => ({
      id: run.id, jobId: run.jobId, channelId: run.channelId, phase: run.phase, workerPhase: run.workerPhase,
      broadcastId: run.broadcastId, streamId: run.streamId, youtubeLifecycle: run.youtubeLifecycle,
      ingestStatus: run.ingestStatus, progress: run.progress, exitCode: run.exitCode, error: run.error,
      startedAt: run.startedAt, endedAt: run.endedAt,
    })),
    media,
    error: null,
  }
}

/** Validates media IDs before persisting a long-lived Job; a Run will validate again before FFmpeg starts. */
export async function createLiveJob(input: {
  channelId: string
  name: string
  videoAssetId: string
  audioAssetIds: string[]
}): Promise<void> {
  const name = input.name.trim()
  if (!name || name.length > 120) throw new LivePilotError('MEDIA_INVALID', 'Live Job 名称长度无效。', { retryable: false })
  if (!Array.isArray(input.audioAssetIds) || input.audioAssetIds.length === 0 || input.audioAssetIds.length > 100) {
    throw new LivePilotError('MEDIA_INVALID', '第一阶段音乐列表必须包含 1–100 个 MP3。', { retryable: false })
  }
  await resolveRunMedia(input.videoAssetId, input.audioAssetIds)
  await createJob({
    channelId: input.channelId, name, videoAssetId: input.videoAssetId,
    audioAssetIds: [...new Set(input.audioAssetIds)], loopVideo: true, loopAudio: true,
  })
}
