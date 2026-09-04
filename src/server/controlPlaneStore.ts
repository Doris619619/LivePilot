/**
 * Persists the local control-plane catalog for OAuth connections, Channels, Jobs, and
 * Runs. Secrets stay in connection-scoped encrypted files; this catalog contains only
 * identifiers and browser-safe operational metadata.
 */
import 'server-only'

import type { LiveRunSummary } from '@/shared/types'
import { LivePilotError } from './errors'
import { withNamedOperationLock } from './operationLock'
import { dataPath, readPrivateFile, writePrivateFile } from './storage'
import { newOpaqueId } from './session'

export interface ConnectionRecord {
  id: string
  label: string
  createdAt: string
}

export interface ChannelRecord {
  id: string
  connectionId: string
  youtubeChannelId: string
  title: string
  reusableStreamId: string | null
  createdAt: string
}

export interface JobRecord {
  id: string
  channelId: string
  name: string
  videoAssetId: string
  audioAssetIds: string[]
  loopVideo: boolean
  loopAudio: boolean
  revision: number
  createdAt: string
  updatedAt: string
}

export interface RunRecord extends LiveRunSummary {
  jobSnapshot: Pick<JobRecord, 'name' | 'videoAssetId' | 'audioAssetIds' | 'loopVideo' | 'loopAudio' | 'revision'>
  stderrSummary: string | null
}

interface ControlPlaneRecord {
  version: 1
  connections: ConnectionRecord[]
  channels: ChannelRecord[]
  jobs: JobRecord[]
  runs: RunRecord[]
}

const STORE_SCOPE = 'control-plane'

/** Returns the single private catalog path; the catalog never contains OAuth or Stream secrets. */
function storePath(): string {
  return dataPath('control-plane.json')
}

/** Builds an empty, versioned control-plane record for a new local installation. */
function emptyStore(): ControlPlaneRecord {
  return { version: 1, connections: [], channels: [], jobs: [], runs: [] }
}

/** Reads and structurally validates the small local catalog, failing closed on corruption. */
async function loadStore(): Promise<ControlPlaneRecord> {
  const raw = await readPrivateFile(storePath())
  if (!raw) return emptyStore()
  try {
    const value = JSON.parse(raw) as ControlPlaneRecord
    if (value.version !== 1 || !Array.isArray(value.connections) || !Array.isArray(value.channels)
      || !Array.isArray(value.jobs) || !Array.isArray(value.runs)) throw new Error('invalid control plane')
    return value
  } catch (error) {
    throw new LivePilotError('INVALID_STATE', 'LivePilot 本地控制目录损坏，未执行操作。', { cause: error, retryable: false })
  }
}

/** Atomically applies one catalog mutation under its dedicated lock and returns its result. */
async function mutateStore<T>(action: (store: ControlPlaneRecord) => T | Promise<T>): Promise<T> {
  return withNamedOperationLock(STORE_SCOPE, 'control-plane-write', async () => {
    const store = await loadStore()
    const result = await action(store)
    await writePrivateFile(storePath(), JSON.stringify(store))
    return result
  })
}

/** Reads a snapshot of all control-plane records without exposing mutable storage references. */
export async function readControlPlane(): Promise<ControlPlaneRecord> {
  return structuredClone(await loadStore())
}

/** Creates or updates the local Connection/Channel mapping after a successful OAuth callback. */
export async function upsertAuthorizedChannel(
  channel: { id: string; title: string },
): Promise<{ connection: ConnectionRecord; channel: ChannelRecord; isNewConnection: boolean }> {
  return mutateStore((store) => {
    const existingChannel = store.channels.find((item) => item.youtubeChannelId === channel.id)
    if (existingChannel) {
      existingChannel.title = channel.title
      const connection = store.connections.find((item) => item.id === existingChannel.connectionId)
      if (!connection) throw new LivePilotError('INVALID_STATE', '频道缺少 OAuth connection。', { retryable: false })
      return { connection, channel: existingChannel, isNewConnection: false }
    }
    const now = new Date().toISOString()
    const connection: ConnectionRecord = { id: newOpaqueId(18), label: channel.title, createdAt: now }
    const createdChannel: ChannelRecord = {
      id: newOpaqueId(18), connectionId: connection.id, youtubeChannelId: channel.id,
      title: channel.title, reusableStreamId: null, createdAt: now,
    }
    store.connections.push(connection)
    store.channels.push(createdChannel)
    return { connection, channel: createdChannel, isNewConnection: true }
  })
}

/** Finds one local OAuth connection by its server-issued opaque ID. */
export async function requireConnection(connectionId: string): Promise<ConnectionRecord> {
  const connection = (await loadStore()).connections.find((item) => item.id === connectionId)
  if (!connection) throw new LivePilotError('NOT_CONNECTED', '指定 OAuth connection 不存在。', { retryable: false })
  return connection
}

/** Finds one Channel and verifies its associated OAuth connection remains available. */
export async function requireChannel(channelId: string): Promise<ChannelRecord> {
  const store = await loadStore()
  const channel = store.channels.find((item) => item.id === channelId)
  if (!channel || !store.connections.some((item) => item.id === channel.connectionId)) {
    throw new LivePilotError('NO_CHANNEL', '指定 YouTube Channel 不存在。', { retryable: false })
  }
  return channel
}

/** Creates a durable media preset after its channel and media resources have been validated. */
export async function createJob(input: Omit<JobRecord, 'id' | 'revision' | 'createdAt' | 'updatedAt'>): Promise<JobRecord> {
  return mutateStore((store) => {
    if (!store.channels.some((item) => item.id === input.channelId)) {
      throw new LivePilotError('NO_CHANNEL', 'Live Job 的 Channel 不存在。', { retryable: false })
    }
    const now = new Date().toISOString()
    const job: JobRecord = { ...input, id: newOpaqueId(18), revision: 1, createdAt: now, updatedAt: now }
    store.jobs.push(job)
    return job
  })
}

/** Returns a Job only when its opaque ID exists in the local private catalog. */
export async function requireJob(jobId: string): Promise<JobRecord> {
  const job = (await loadStore()).jobs.find((item) => item.id === jobId)
  if (!job) throw new LivePilotError('INVALID_STATE', '指定 Live Job 不存在。', { retryable: false })
  return job
}

/** Returns one durable Run record by opaque ID so Stop never trusts a browser-supplied Channel target. */
export async function requireRun(runId: string): Promise<RunRecord> {
  const run = (await loadStore()).runs.find((item) => item.id === runId)
  if (!run) throw new LivePilotError('INVALID_STATE', '指定 Live Run 不存在。', { retryable: false })
  return run
}

/** Persists the Channel-owned reusable Stream reference without ever storing its Stream Key. */
export async function setReusableStream(channelId: string, streamId: string): Promise<void> {
  await mutateStore((store) => {
    const channel = store.channels.find((item) => item.id === channelId)
    if (!channel) throw new LivePilotError('NO_CHANNEL', '指定 YouTube Channel 不存在。', { retryable: false })
    channel.reusableStreamId = streamId
  })
}

/** Creates a Run by snapshotting its Job; Broadcast, Stream, and runtime state begin empty. */
export async function createRun(job: JobRecord): Promise<RunRecord> {
  return mutateStore((store) => {
    const active = store.runs.find((item) => item.channelId === job.channelId && isRunActive(item))
    if (active) throw new LivePilotError('RUN_ALREADY_ACTIVE', '此 Channel 已有未结束的 Live Run。', { retryable: false })
    const now = new Date().toISOString()
    const run: RunRecord = {
      id: newOpaqueId(18), jobId: job.id, channelId: job.channelId,
      phase: 'preparing', workerPhase: 'stopped', broadcastId: null, streamId: null,
      youtubeLifecycle: null, ingestStatus: null,
      progress: { frame: null, fps: null, bitrate: null, speed: null, outTimeMs: null, heartbeatAt: null },
      exitCode: null, error: null, startedAt: now, endedAt: null, stderrSummary: null,
      jobSnapshot: {
        name: job.name, videoAssetId: job.videoAssetId, audioAssetIds: [...job.audioAssetIds],
        loopVideo: job.loopVideo, loopAudio: job.loopAudio, revision: job.revision,
      },
    }
    store.runs.push(run)
    return run
  })
}

/** Treats every non-terminal and recovery-required Run as Channel occupancy. */
export function isRunActive(run: RunRecord): boolean {
  return !['completed', 'failed'].includes(run.phase)
    || ['starting', 'pushing', 'stopping', 'unresponsive', 'recovery_required'].includes(run.workerPhase)
}

/** Updates a Run with server-derived state only; callers never pass browser-owned arbitrary objects. */
export async function updateRun(
  runId: string,
  patch: Partial<Pick<RunRecord, 'phase' | 'workerPhase' | 'broadcastId' | 'streamId' | 'youtubeLifecycle' | 'ingestStatus' | 'progress' | 'exitCode' | 'error' | 'endedAt' | 'stderrSummary'>>,
): Promise<RunRecord> {
  return mutateStore((store) => {
    const run = store.runs.find((item) => item.id === runId)
    if (!run) throw new LivePilotError('INVALID_STATE', 'Live Run 不存在。', { retryable: false })
    Object.assign(run, patch)
    return run
  })
}

/** Reads all records used by the dashboard while retaining the internal Job/Run snapshots server-side. */
export async function listControlPlaneRecords(): Promise<{
  connections: ConnectionRecord[]
  channels: ChannelRecord[]
  jobs: JobRecord[]
  runs: RunRecord[]
}> {
  const store = await loadStore()
  return structuredClone(store)
}

/** Converts a worker parser update into the compact persistent Run telemetry shape. */
export function makeProgress(
  current: RunRecord['progress'],
  update: Partial<RunRecord['progress']>,
): RunRecord['progress'] {
  return { ...current, ...update, heartbeatAt: new Date().toISOString() }
}
