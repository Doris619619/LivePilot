/**
 * Implements the server-only YouTube Data API adapter, including normalized errors,
 * quota accounting, Broadcast/Stream CRUD, binding, and lifecycle transitions.
 * Adapted from pjmdesi/stream-manager at bf47f634e4348f98c19beaa28274d0473db51e7d
 * (MIT); OAuth tokens and Stream Keys remain behind this server boundary.
 */
import 'server-only'

import type { ChannelInfo, CreateBroadcastInput, LiveBroadcast } from '@/shared/types'
import { LivePilotError } from './errors'
import { getValidAccessToken } from './youtubeAuth'
import * as quotaState from './quotaState'

const API_BASE = 'https://www.googleapis.com/youtube/v3'
const LIVEPILOT_STREAM_TITLE = 'LivePilot reusable stream'

export interface LiveStreamSecret {
  streamId: string
  title: string
  streamName: string
  ingestionAddress: string
}

export interface StreamIngestStatus {
  streamId: string
  title: string
  streamStatus: string | null
  healthStatus: string | null
  configurationIssues: string[]
}

export interface BroadcastContentDetails {
  enableMonitorStream?: boolean
  enableAutoStart?: boolean
  enableAutoStop?: boolean
  boundStreamId?: string
}

interface ApiErrorBody {
  error?: {
    code?: number
    message?: string
    errors?: Array<{ reason?: string; message?: string }>
  }
}

interface LiveStreamResource {
  id?: string
  snippet?: { title?: string; isDefaultStream?: boolean }
  cdn?: {
    ingestionInfo?: {
      streamName?: string
      ingestionAddress?: string
      rtmpsIngestionAddress?: string
    }
  }
  status?: {
    streamStatus?: string
    healthStatus?: {
      status?: string
      configurationIssues?: Array<{ type?: string; reason?: string; description?: string }>
    }
  }
}

/**
 * Maps an unsuccessful YouTube response into LivePilot's actionable error contract.
 * `body` is untrusted remote JSON; only known reason codes and Google's API message
 * are retained, while quota state is updated entirely on the server.
 */
function apiError(status: number, body: ApiErrorBody, operation: string): LivePilotError {
  const reasons = body.error?.errors?.map(
    /* Extract only Google's structured reason code from each remote error entry. */
    (item) => item.reason ?? '',
  ).filter(Boolean) ?? []
  const apiMessage = body.error?.message || operation + ' 请求失败（HTTP ' + status + '）。'
  if (reasons.some(
    /* Treat either documented daily quota reason as the same local quota gate. */
    (reason) => ['quotaExceeded', 'dailyLimitExceeded'].includes(reason),
  )) {
    quotaState.markQuotaExceeded()
    return new LivePilotError('QUOTA_EXCEEDED', 'YouTube API 每日配额已耗尽。', { apiReasons: reasons })
  }
  if (reasons.includes('youtubeSignupRequired')) {
    return new LivePilotError('NO_CHANNEL', '当前 Google 账号尚未创建 YouTube Channel。', {
      apiReasons: reasons,
      retryable: false,
    })
  }
  if (reasons.includes('liveStreamingNotEnabled') || reasons.includes('insufficientLivePermissions')) {
    return new LivePilotError('LIVE_STREAMING_NOT_ENABLED', '当前 Channel 尚未启用或未获准使用直播功能。', {
      apiReasons: reasons,
      retryable: false,
    })
  }
  if (reasons.includes('livePermissionBlocked')) {
    return new LivePilotError('LIVE_PERMISSION_BLOCKED', 'YouTube 当前阻止此账号进行直播。', {
      apiReasons: reasons,
      retryable: false,
    })
  }
  if (status === 401 || reasons.some(
    /* Recognize credential failures even when Google returns a nonstandard status. */
    (reason) => ['authError', 'invalidCredentials'].includes(reason),
  )) {
    return new LivePilotError('TOKEN_INVALID', 'YouTube 授权已失效。', { apiReasons: reasons })
  }
  if (reasons.some(
    /* Collapse OAuth scope and API permission denials into the token remediation path. */
    (reason) => ['insufficientPermissions', 'forbidden'].includes(reason),
  )) {
    return new LivePilotError('TOKEN_INVALID', 'OAuth 授权缺少 YouTube 直播所需权限。', {
      apiReasons: reasons,
      retryable: false,
    })
  }
  if (reasons.includes('errorStreamInactive')) {
    return new LivePilotError('INGEST_NOT_ACTIVE', 'YouTube 尚未收到可用的 ingest。', { apiReasons: reasons })
  }
  return new LivePilotError('UNKNOWN', operation + '：' + apiMessage, { apiReasons: reasons })
}

/**
 * Executes one authenticated YouTube Data API request from the server.
 * The access token is loaded/refreshed internally unless a server-side OAuth probe
 * supplies one; callers provide only API path, request options, and quota metadata.
 */
async function youtubeRequest<T>(
  path: string,
  init: RequestInit,
  operation: string,
  options?: { quotaCost?: number; accessToken?: string; connectionId?: string },
): Promise<T> {
  if (quotaState.getQuotaState().exceeded) {
    throw new LivePilotError('QUOTA_EXCEEDED', 'YouTube API 每日配额已耗尽。')
  }
  const token = options?.accessToken ?? await getValidAccessToken(options?.connectionId)
  let response: Response
  try {
    response = await fetch(API_BASE + path, {
      ...init,
      cache: 'no-store',
      signal: init.signal ?? AbortSignal.timeout(30_000),
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    })
  } catch (error) {
    throw new LivePilotError('NETWORK_ERROR', operation + ' 时服务端无法连接 YouTube API。', { cause: error })
  }
  if (!response.ok) {
    const body = await response.json().catch(
      /* Fall back to an empty error envelope when Google returns a non-JSON failure. */
      () => ({}),
    ) as ApiErrorBody
    throw apiError(response.status, body, operation)
  }
  quotaState.addQuotaUsage(options?.quotaCost ?? ((init.method ?? 'GET').toUpperCase() === 'GET' ? 1 : 50))
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

/**
 * Resolves the authorized Channel using a freshly exchanged server-side access token.
 * This OAuth callback helper returns only public Channel identity to its caller.
 */
export async function getCurrentChannelWithAccessToken(accessToken: string): Promise<ChannelInfo> {
  return getCurrentChannel(accessToken)
}

/**
 * Reads the single YouTube Channel owned by the current authorization.
 * An optional token is accepted only from server-side OAuth code; no credential is
 * included in the returned Channel DTO.
 */
export async function getCurrentChannel(accessToken?: string, connectionId?: string): Promise<ChannelInfo> {
  const data = await youtubeRequest<{
    items?: Array<{ id?: string; snippet?: { title?: string } }>
  }>(
    '/channels?' + new URLSearchParams({ part: 'id,snippet', mine: 'true', maxResults: '1' }),
    { method: 'GET' },
    '读取当前 YouTube Channel',
    { accessToken, connectionId },
  )
  const channel = data.items?.[0]
  if (!channel?.id) {
    throw new LivePilotError('NO_CHANNEL', '当前 Google 账号下没有 YouTube Channel。', { retryable: false })
  }
  return { id: channel.id, title: channel.snippet?.title?.trim() || '未命名频道' }
}

/**
 * Retrieves every page for one YouTube Broadcast lifecycle group.
 * The status is restricted by the type to `active` or `upcoming` and pagination is
 * completed server-side before any result reaches the dashboard.
 */
async function listBroadcastStatus(status: 'active' | 'upcoming', connectionId?: string): Promise<LiveBroadcast[]> {
  const items: LiveBroadcast[] = []
  let pageToken: string | undefined
  do {
    const params = new URLSearchParams({
      part: 'id,snippet,status',
      broadcastStatus: status,
      broadcastType: 'all',
      maxResults: '50',
    })
    if (pageToken) params.set('pageToken', pageToken)
    const page = await youtubeRequest<{ items?: LiveBroadcast[]; nextPageToken?: string }>(
      '/liveBroadcasts?' + params,
      { method: 'GET' },
      '读取 ' + status + ' Broadcast',
      { connectionId },
    )
    items.push(...(page.items ?? []))
    pageToken = page.nextPageToken
  } while (pageToken)
  return items
}

/**
 * Lists controllable active and upcoming Broadcasts, de-duplicated and ordered by
 * scheduled start time for deterministic browser presentation.
 */
export async function listLiveBroadcasts(connectionId?: string): Promise<LiveBroadcast[]> {
  const groups = await Promise.all([listBroadcastStatus('active', connectionId), listBroadcastStatus('upcoming', connectionId)])
  const unique = new Map<string, LiveBroadcast>()
  for (const item of groups.flat()) unique.set(item.id, item)
  return [...unique.values()].sort(
    /* Put the earliest valid schedule first and unscheduled entries at the end. */
    (left, right) => {
      const a = Date.parse(left.snippet?.scheduledStartTime ?? '') || Number.MAX_SAFE_INTEGER
      const b = Date.parse(right.snippet?.scheduledStartTime ?? '') || Number.MAX_SAFE_INTEGER
      return a - b
    },
  )
}

/**
 * Reads one Broadcast by its server-validated YouTube ID.
 * A missing remote resource is represented as `null` rather than guessed local state.
 */
export async function getBroadcastById(broadcastId: string, connectionId?: string): Promise<LiveBroadcast | null> {
  const data = await youtubeRequest<{ items?: LiveBroadcast[] }>(
    '/liveBroadcasts?' + new URLSearchParams({ part: 'id,snippet,status', id: broadcastId }),
    { method: 'GET' },
    '读取 Broadcast 状态',
    { connectionId },
  )
  return data.items?.[0] ?? null
}

/**
 * Creates a manually controlled Broadcast from validated server input.
 * Auto Start is disabled so OBS ingest cannot bypass the explicit Web start action;
 * only the resulting public Broadcast resource is returned.
 */
export async function createBroadcast(input: CreateBroadcastInput, connectionId?: string): Promise<LiveBroadcast> {
  return youtubeRequest<LiveBroadcast>(
    '/liveBroadcasts?part=id,snippet,status,contentDetails',
    {
      method: 'POST',
      body: JSON.stringify({
        snippet: {
          title: input.title.trim() || 'LivePilot 测试直播',
          description: input.description,
          scheduledStartTime: input.scheduledStartTime,
        },
        status: { privacyStatus: input.privacyStatus, selfDeclaredMadeForKids: false },
        contentDetails: {
          enableAutoStart: false,
          enableAutoStop: true,
          monitorStream: { enableMonitorStream: false },
        },
      }),
    },
    '创建 Live Broadcast',
    { connectionId },
  )
}

/**
 * Retrieves all Live Streams owned by the authorized Channel, following pagination.
 * Raw resources remain server-only because their ingestion data can contain Stream Keys.
 */
async function listLiveStreams(connectionId?: string): Promise<LiveStreamResource[]> {
  const items: LiveStreamResource[] = []
  let pageToken: string | undefined
  do {
    const params = new URLSearchParams({ part: 'id,snippet,cdn,status', mine: 'true', maxResults: '50' })
    if (pageToken) params.set('pageToken', pageToken)
    const page = await youtubeRequest<{ items?: LiveStreamResource[]; nextPageToken?: string }>(
      '/liveStreams?' + params,
      { method: 'GET' },
      '读取 YouTube Live Stream',
      { connectionId },
    )
    items.push(...(page.items ?? []))
    pageToken = page.nextPageToken
  } while (pageToken)
  return items
}

/**
 * Converts a raw YouTube Live Stream into the server-only ingest secret contract.
 * Incomplete resources return `null`; the Stream Key is never converted to a browser DTO.
 */
function toSecret(stream: LiveStreamResource | undefined): LiveStreamSecret | null {
  const streamName = stream?.cdn?.ingestionInfo?.streamName
  if (!stream?.id || !streamName) return null
  return {
    streamId: stream.id,
    title: stream.snippet?.title?.trim() || '未命名 Stream',
    streamName,
    ingestionAddress: stream.cdn?.ingestionInfo?.rtmpsIngestionAddress
      || stream.cdn?.ingestionInfo?.ingestionAddress
      || 'rtmps://a.rtmps.youtube.com/live2',
  }
}

/**
 * Creates a reusable RTMP Live Stream for the authorized Channel.
 * The returned ingest address and Stream Key are secrets intended only for server-side
 * orchestration and must never be serialized into browser responses.
 */
export async function createLiveStream(connectionId?: string): Promise<LiveStreamSecret> {
  const stream = await youtubeRequest<LiveStreamResource>(
    '/liveStreams?part=id,snippet,cdn,status,contentDetails',
    {
      method: 'POST',
      body: JSON.stringify({
        snippet: {
          title: LIVEPILOT_STREAM_TITLE,
          description: 'Reusable RTMP stream created by LivePilot.',
        },
        cdn: { ingestionType: 'rtmp', resolution: 'variable', frameRate: 'variable' },
        contentDetails: { isReusable: true },
      }),
    },
    '创建 YouTube Live Stream',
    { connectionId },
  )
  const secret = toSecret(stream)
  if (!secret) throw new LivePilotError('NO_STREAM', 'YouTube 创建了 Stream，但没有返回 ingest 配置。')
  return secret
}

/**
 * Selects an explicit dedicated/default/sole Stream. When an existing inventory is
 * ambiguous, creates a new LivePilot-owned reusable Stream instead of guessing a key.
 */
export async function getOrCreateLiveStream(connectionId?: string): Promise<LiveStreamSecret> {
  const items = await listLiveStreams(connectionId)
  const selected = items.find(
    /* Prefer only the Stream explicitly owned by LivePilot. */
    (item) => item.snippet?.title === LIVEPILOT_STREAM_TITLE,
  )
    ?? items.find(
      /* Fall back to YouTube's explicit default marker, never title heuristics. */
      (item) => item.snippet?.isDefaultStream === true,
    )
    ?? (items.length === 1 ? items[0] : undefined)
  if (!selected) return createLiveStream(connectionId)
  const secret = toSecret(selected)
  if (!secret) throw new LivePilotError('NO_STREAM', '目标 Stream 缺少 ingest 配置。')
  return secret
}

/**
 * Reads the server-only ingest secret for an explicitly bound Stream ID.
 * Missing or incomplete YouTube resources return `null` and no secret is logged or exposed.
 */
export async function getLiveStreamById(streamId: string, connectionId?: string): Promise<LiveStreamSecret | null> {
  const data = await youtubeRequest<{ items?: LiveStreamResource[] }>(
    '/liveStreams?' + new URLSearchParams({ part: 'id,snippet,cdn', id: streamId }),
    { method: 'GET' },
    '读取已绑定的 Live Stream',
    { connectionId },
  )
  return toSecret(data.items?.[0])
}

/**
 * Binds one Broadcast to one server-selected Live Stream and verifies the returned binding.
 * IDs must originate from validated YouTube state; expected operational failures are
 * normalized without leaking the underlying Stream Key.
 */
export async function bindBroadcast(broadcastId: string, streamId: string, connectionId?: string): Promise<void> {
  try {
    const bound = await youtubeRequest<{ contentDetails?: { boundStreamId?: string } }>(
      '/liveBroadcasts/bind?' + new URLSearchParams({
        id: broadcastId,
        part: 'id,contentDetails,status',
        streamId,
      }),
      { method: 'POST' },
      '绑定 Broadcast 与 Live Stream',
      { connectionId },
    )
    if (bound.contentDetails?.boundStreamId !== streamId) {
      throw new LivePilotError('BIND_FAILED', 'YouTube 未确认 Broadcast 绑定到目标 Stream。')
    }
  } catch (error) {
    if (error instanceof LivePilotError && [
      'QUOTA_EXCEEDED',
      'TOKEN_INVALID',
      'NETWORK_ERROR',
      'LIVE_STREAMING_NOT_ENABLED',
      'LIVE_PERMISSION_BLOCKED',
    ].includes(error.code)) throw error
    throw new LivePilotError('BIND_FAILED', error instanceof Error ? error.message : 'Broadcast bind 失败。', { cause: error })
  }
}

/**
 * Reads the Broadcast controls that determine binding and transition safety.
 * The result contains configuration flags and a Stream ID only, never ingest credentials.
 */
export async function getBroadcastContentDetails(broadcastId: string, connectionId?: string): Promise<BroadcastContentDetails | null> {
  const data = await youtubeRequest<{
    items?: Array<{
      contentDetails?: {
        monitorStream?: { enableMonitorStream?: boolean }
        enableAutoStart?: boolean
        enableAutoStop?: boolean
        boundStreamId?: string
      }
    }>
  }>(
    '/liveBroadcasts?' + new URLSearchParams({ part: 'contentDetails', id: broadcastId }),
    { method: 'GET' },
    '读取 Broadcast contentDetails',
    { connectionId },
  )
  const details = data.items?.[0]?.contentDetails
  return details ? {
    enableMonitorStream: details.monitorStream?.enableMonitorStream,
    enableAutoStart: details.enableAutoStart,
    enableAutoStop: details.enableAutoStop,
    boundStreamId: details.boundStreamId,
  } : null
}

/**
 * Re-reads the authoritative YouTube lifecycle for a Broadcast.
 * Callers use this instead of trusting stale browser or previously cached state.
 */
export async function getBroadcastLifeCycleStatus(broadcastId: string, connectionId?: string): Promise<string | null> {
  return (await getBroadcastById(broadcastId, connectionId))?.status.lifeCycleStatus ?? null
}

/**
 * Reads authoritative ingest and health state for the bound Stream.
 * The returned summary intentionally excludes ingestion addresses and Stream Keys.
 */
export async function getStreamStatus(streamId: string, connectionId?: string): Promise<StreamIngestStatus> {
  const data = await youtubeRequest<{ items?: LiveStreamResource[] }>(
    '/liveStreams?' + new URLSearchParams({ part: 'id,snippet,status', id: streamId }),
    { method: 'GET' },
    '读取 Stream ingest 状态',
    { connectionId },
  )
  const stream = data.items?.[0]
  if (!stream?.id) throw new LivePilotError('NO_STREAM', '已绑定的 YouTube Stream 不存在。')
  const issues = stream.status?.healthStatus?.configurationIssues ?? []
  return {
    streamId: stream.id,
    title: stream.snippet?.title?.trim() || '未命名 Stream',
    streamStatus: stream.status?.streamStatus ?? null,
    healthStatus: stream.status?.healthStatus?.status ?? null,
    configurationIssues: issues.map(
      /* Prefer YouTube's human-readable issue detail, then stable diagnostic codes. */
      (issue) => issue.description || issue.reason || issue.type || '未知 ingest 问题',
    ),
  }
}

/**
 * Requests one explicit YouTube Broadcast lifecycle transition.
 * The target is compile-time restricted to testing, live, or complete; higher-level
 * orchestration must re-read and confirm the resulting remote state.
 */
export async function transitionBroadcast(
  broadcastId: string,
  target: 'testing' | 'live' | 'complete',
  connectionId?: string,
): Promise<void> {
  await youtubeRequest(
    '/liveBroadcasts/transition?' + new URLSearchParams({
      id: broadcastId,
      part: 'id,status',
      broadcastStatus: target,
    }),
    { method: 'POST' },
    'Broadcast transition(' + target + ')',
    { connectionId },
  )
}
