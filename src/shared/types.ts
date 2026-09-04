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
  | 'OBS_UNREACHABLE'
  | 'OBS_ALREADY_STREAMING'
  | 'OBS_START_FAILED'
  | 'OBS_STOP_FAILED'
  | 'OBS_RECOVERY_REQUIRED'
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

/** Browser-safe OAuth connection metadata; token material is never serialized. */
export interface ConnectionSummary { id: string; label: string; connected: boolean }

/** Browser-safe YouTube Channel and its server-owned reusable Stream reference. */
export interface ChannelSummary {
  id: string
  connectionId: string
  youtubeChannelId: string
  title: string
  reusableStreamId: string | null
}

/** A registered local Portable OBS endpoint. Its password is intentionally absent. */
export interface ObsInstanceSummary {
  id: string
  channelId: string
  label: string
  host: '127.0.0.1'
  port: number
  lastState: ObsState
  lastSeenAt: string | null
}

/** Observable OBS streaming state, deliberately separate from YouTube lifecycle. */
export type ObsState = 'unknown' | 'inactive' | 'active' | 'disconnected' | 'recovery_required'
export type RunPhase = 'preparing' | 'waiting_for_ingest' | 'transitioning_live' | 'live' | 'stopping' | 'completed' | 'failed' | 'stop_failed' | 'recovery_required'

/** A channel-scoped execution record without PID, process output, or media settings. */
export interface LiveRunSummary {
  id: string
  channelId: string
  obsInstanceId: string
  phase: RunPhase
  broadcastId: string | null
  streamId: string | null
  youtubeLifecycle: string | null
  ingestStatus: string | null
  obsState: ObsState
  obsLastSeenAt: string | null
  obsError: PublicError | null
  error: PublicError | null
  startedAt: string
  endedAt: string | null
}

/** The browser-safe multi-channel control surface. */
export interface ControlPlaneSnapshot {
  configured: boolean
  connections: ConnectionSummary[]
  channels: ChannelSummary[]
  obsInstances: ObsInstanceSummary[]
  runs: LiveRunSummary[]
  error: PublicError | null
}

/** Standard payload returned by the Channel-scoped console APIs. */
export interface ControlPlanePayload { snapshot: ControlPlaneSnapshot; csrfToken: string }
