/**
 * 浏览器与服务端共享的公开 DTO；此文件只描述可安全跨 HTTP 边界传递的数据。
 */
export type PublicErrorCode =
  | 'CONFIG_MISSING'
  | 'UNAUTHORIZED'
  | 'CSRF_FAILED'
  | 'NOT_CONNECTED'
  | 'TOKEN_INVALID'
  | 'OAUTH_FAILED'
  | 'NO_CHANNEL'
  | 'LIVE_STREAMING_NOT_ENABLED'
  | 'LIVE_PERMISSION_BLOCKED'
  | 'NO_BROADCAST'
  | 'NO_STREAM'
  | 'BIND_FAILED'
  | 'INGEST_NOT_ACTIVE'
  | 'TESTING_TRANSITION_FAILED'
  | 'LIVE_TRANSITION_FAILED'
  | 'COMPLETE_TRANSITION_FAILED'
  | 'QUOTA_EXCEEDED'
  | 'NETWORK_ERROR'
  | 'BUSY'
  | 'RUN_ALREADY_ACTIVE'
  | 'MEDIA_NOT_FOUND'
  | 'MEDIA_INVALID'
  | 'FFMPEG_UNAVAILABLE'
  | 'WORKER_START_FAILED'
  | 'WORKER_CRASHED'
  | 'WORKER_UNRESPONSIVE'
  | 'INGEST_TIMEOUT'
  | 'INVALID_STATE'
  | 'UNKNOWN'

export interface PublicError {
  code: PublicErrorCode
  message: string
  action: string
  retryable: boolean
}

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: PublicError }

export interface ChannelInfo {
  id: string
  title: string
}

export interface LiveBroadcast {
  id: string
  snippet: {
    title: string
    description: string
    scheduledStartTime?: string
    actualStartTime?: string
  }
  status: {
    lifeCycleStatus: string
    privacyStatus: string
  }
}

export interface CreateBroadcastInput {
  title: string
  description: string
  scheduledStartTime: string
  privacyStatus: 'public' | 'unlisted' | 'private'
}

export type BroadcastStage = 'offline' | 'waiting' | 'ready' | 'testing' | 'live' | 'complete' | 'error'

export interface QuotaState {
  exceeded: boolean
  resetsAt: string | null
  used: number
  limit: number
}

export interface StreamSummary {
  id: string
  title: string
  streamStatus: string | null
  healthStatus: string | null
  configurationIssues: string[]
}

export interface AppSnapshot {
  configured: boolean
  connected: boolean
  channel: ChannelInfo | null
  broadcasts: LiveBroadcast[]
  selectedBroadcastId: string | null
  selectedBroadcast: LiveBroadcast | null
  stream: StreamSummary | null
  stage: BroadcastStage
  quota: QuotaState
  error: PublicError | null
}

export interface DashboardPayload {
  snapshot: AppSnapshot
  csrfToken: string
}

/** Browser-safe summary of one OAuth connection; token material is never included. */
export interface ConnectionSummary {
  id: string
  label: string
  connected: boolean
}

/** Browser-safe YouTube channel owned by a server-side OAuth connection. */
export interface ChannelSummary {
  id: string
  connectionId: string
  youtubeChannelId: string
  title: string
  reusableStreamId: string | null
}

/** A media file selected from a server-configured root, never an arbitrary path. */
export interface MediaAsset {
  id: string
  name: string
  kind: 'video' | 'audio'
}

/** Long-lived media preset. Runtime IDs and status deliberately do not belong here. */
export interface LiveJobSummary {
  id: string
  channelId: string
  name: string
  videoAssetId: string
  audioAssetIds: string[]
  loopVideo: boolean
  loopAudio: boolean
  updatedAt: string
}

export type WorkerPhase = 'starting' | 'pushing' | 'stopping' | 'stopped' | 'crashed' | 'unresponsive' | 'recovery_required'
export type RunPhase = 'preparing' | 'waiting_for_worker' | 'waiting_for_ingest' | 'transitioning_live' | 'live' | 'stopping' | 'completed' | 'failed' | 'stop_failed'

/** The non-secret operational state of an individual execution of a Live Job. */
export interface LiveRunSummary {
  id: string
  jobId: string
  channelId: string
  phase: RunPhase
  workerPhase: WorkerPhase
  broadcastId: string | null
  streamId: string | null
  youtubeLifecycle: string | null
  ingestStatus: string | null
  progress: { frame: number | null; fps: number | null; bitrate: string | null; speed: string | null; outTimeMs: number | null; heartbeatAt: string | null }
  exitCode: number | null
  error: PublicError | null
  startedAt: string
  endedAt: string | null
}

/** Browser dashboard for the first multi-account, job/run-based console. */
export interface ControlPlaneSnapshot {
  configured: boolean
  connections: ConnectionSummary[]
  channels: ChannelSummary[]
  jobs: LiveJobSummary[]
  runs: LiveRunSummary[]
  media: MediaAsset[]
  error: PublicError | null
}

export interface ControlPlanePayload {
  snapshot: ControlPlaneSnapshot
  csrfToken: string
}
