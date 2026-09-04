/**
 * Stores the local Connection, Channel, OBS instance and Run catalog. OAuth and OBS
 * passwords remain in separately encrypted files; this catalog never contains secrets.
 */
import 'server-only'

import type { LiveRunSummary, ObsState } from '@/shared/types'
import { LivePilotError } from './errors'
import { withNamedOperationLock } from './operationLock'
import { dataPath, readPrivateFile, writePrivateFile } from './storage'
import { newOpaqueId } from './session'

export interface ConnectionRecord { id: string; label: string; createdAt: string }
export interface ChannelRecord { id: string; connectionId: string; youtubeChannelId: string; title: string; reusableStreamId: string | null; createdAt: string }
export interface ObsInstanceRecord { id: string; channelId: string; label: string; host: '127.0.0.1'; port: number; passwordCiphertext: string; lastState: ObsState; lastSeenAt: string | null }
export type RunRecord = LiveRunSummary
interface Store { version: 2; connections: ConnectionRecord[]; channels: ChannelRecord[]; obsInstances: ObsInstanceRecord[]; runs: RunRecord[] }

/** Returns the private catalog path. */
function path(): string { return dataPath('control-plane.json') }
/** Creates an empty versioned catalog. */
function empty(): Store { return { version: 2, connections: [], channels: [], obsInstances: [], runs: [] } }
/** Loads and validates only the fields needed to prevent a corrupted catalog from being used. */
async function load(): Promise<Store> {
  const raw = await readPrivateFile(path())
  if (!raw) return empty()
  try {
    const value = JSON.parse(raw) as Store
    if (value.version !== 2 || !Array.isArray(value.connections) || !Array.isArray(value.channels) || !Array.isArray(value.obsInstances) || !Array.isArray(value.runs)) throw new Error('schema')
    return value
  } catch (cause) { throw new LivePilotError('INVALID_STATE', '本机控制目录格式无效，未执行操作。', { cause, retryable: false }) }
}
/** Applies a private catalog mutation while holding its dedicated cross-request lock. */
async function mutate<T>(action: (store: Store) => T | Promise<T>): Promise<T> {
  return withNamedOperationLock('control-plane', 'write', async () => { const store = await load(); const result = await action(store); await writePrivateFile(path(), JSON.stringify(store)); return result })
}
/** Returns detached records for browser DTO conversion or server-side lookup. */
export async function listRecords(): Promise<Store> { return structuredClone(await load()) }
/** Creates or updates the one Channel discovered during a Connection's OAuth callback. */
export async function upsertAuthorizedChannel(value: { id: string; title: string }): Promise<{ connection: ConnectionRecord; channel: ChannelRecord }> {
  return mutate((store) => {
    const existing = store.channels.find((item) => item.youtubeChannelId === value.id)
    if (existing) { const connection = store.connections.find((item) => item.id === existing.connectionId); if (!connection) throw new LivePilotError('INVALID_STATE', 'Channel 缺少 Connection。', { retryable: false }); existing.title = value.title; return { connection, channel: existing } }
    const now = new Date().toISOString(); const connection = { id: newOpaqueId(18), label: value.title, createdAt: now }; const channel = { id: newOpaqueId(18), connectionId: connection.id, youtubeChannelId: value.id, title: value.title, reusableStreamId: null, createdAt: now }
    store.connections.push(connection); store.channels.push(channel); return { connection, channel }
  })
}
/** Requires an existing Channel and its parent Connection. */
export async function requireChannel(channelId: string): Promise<ChannelRecord> { const store = await load(); const item = store.channels.find((channel) => channel.id === channelId); if (!item || !store.connections.some((connection) => connection.id === item.connectionId)) throw new LivePilotError('NO_CHANNEL', '指定 Channel 不存在。', { retryable: false }); return item }
/** Persists a reusable Stream ID that never includes its secret Stream Key. */
export async function setReusableStream(channelId: string, streamId: string): Promise<void> { await mutate((store) => { const channel = store.channels.find((item) => item.id === channelId); if (!channel) throw new LivePilotError('NO_CHANNEL', '指定 Channel 不存在。', { retryable: false }); channel.reusableStreamId = streamId }) }
/** Registers the single Portable OBS endpoint owned by one Channel; duplicate ports are rejected globally. */
export async function registerObsInstance(input: { channelId: string; label: string; port: number; passwordCiphertext: string }): Promise<ObsInstanceRecord> {
  return mutate((store) => {
    if (!store.channels.some((item) => item.id === input.channelId)) throw new LivePilotError('NO_CHANNEL', '指定 Channel 不存在。', { retryable: false })
    if (store.obsInstances.some((item) => item.port === input.port && item.channelId !== input.channelId)) throw new LivePilotError('INVALID_STATE', 'OBS WebSocket 端口已被其他 Channel 使用。', { retryable: false })
    const prior = store.obsInstances.find((item) => item.channelId === input.channelId)
    if (prior) { prior.label = input.label; prior.port = input.port; prior.passwordCiphertext = input.passwordCiphertext; prior.lastState = 'unknown'; prior.lastSeenAt = null; return prior }
    const created: ObsInstanceRecord = { id: newOpaqueId(18), channelId: input.channelId, label: input.label, host: '127.0.0.1', port: input.port, passwordCiphertext: input.passwordCiphertext, lastState: 'unknown', lastSeenAt: null }; store.obsInstances.push(created); return created
  })
}
/** Requires the unique OBS endpoint assigned to a Channel. */
export async function requireObsForChannel(channelId: string): Promise<ObsInstanceRecord> { const item = (await load()).obsInstances.find((obs) => obs.channelId === channelId); if (!item) throw new LivePilotError('INVALID_STATE', '此 Channel 尚未注册 Portable OBS 实例。', { retryable: false }); return item }
/** Requires an OBS instance by its opaque server-issued ID. */
export async function requireObsInstance(id: string): Promise<ObsInstanceRecord> { const item = (await load()).obsInstances.find((obs) => obs.id === id); if (!item) throw new LivePilotError('INVALID_STATE', 'OBS 实例不存在。', { retryable: false }); return item }
/** Updates only server-observed OBS connectivity state. */
export async function observeObs(id: string, state: ObsState): Promise<void> { await mutate((store) => { const item = store.obsInstances.find((obs) => obs.id === id); if (!item) throw new LivePilotError('INVALID_STATE', 'OBS 实例不存在。', { retryable: false }); item.lastState = state; item.lastSeenAt = new Date().toISOString() }) }
/** Creates one Run and rejects every still-unconfirmed predecessor on the same Channel. */
export async function createRun(channelId: string, obsInstanceId: string): Promise<RunRecord> { return mutate((store) => { if (store.runs.some((run) => run.channelId === channelId && !['completed', 'failed'].includes(run.phase))) throw new LivePilotError('RUN_ALREADY_ACTIVE', '此 Channel 已有未确认结束的 Live Run。', { retryable: false }); const now = new Date().toISOString(); const run: RunRecord = { id: newOpaqueId(18), channelId, obsInstanceId, phase: 'preparing', broadcastId: null, streamId: null, youtubeLifecycle: null, ingestStatus: null, obsState: 'unknown', obsLastSeenAt: null, obsError: null, error: null, startedAt: now, endedAt: null }; store.runs.push(run); return run }) }
/** Returns a Run by opaque ID, keeping stop targets server-owned. */
export async function requireRun(id: string): Promise<RunRecord> { const run = (await load()).runs.find((item) => item.id === id); if (!run) throw new LivePilotError('INVALID_STATE', 'Live Run 不存在。', { retryable: false }); return run }
/** Persists server-derived lifecycle/OBS observations only. */
export async function updateRun(id: string, patch: Partial<Pick<RunRecord, 'phase' | 'broadcastId' | 'streamId' | 'youtubeLifecycle' | 'ingestStatus' | 'obsState' | 'obsLastSeenAt' | 'obsError' | 'error' | 'endedAt'>>): Promise<RunRecord> { return mutate((store) => { const run = store.runs.find((item) => item.id === id); if (!run) throw new LivePilotError('INVALID_STATE', 'Live Run 不存在。', { retryable: false }); Object.assign(run, patch); return run }) }
