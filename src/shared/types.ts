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
