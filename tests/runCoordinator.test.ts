/** Verifies the OBS/YouTube start-stop ordering and every conservative recovery gate. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { LiveServiceApi } from '@/server/liveService'
import { resetRuntimeConfigForTests } from '@/server/config'
import { LivePilotError } from '@/server/errors'
import { createRun, listRecords, registerObsInstance, requireRun, updateRun, upsertAuthorizedChannel } from '@/server/controlPlaneStore'
import { sealJson } from '@/server/cryptoBox'
import { RunCoordinator, type ObsControlPort } from '@/server/runCoordinator'

const environment = { YOUTUBE_CLIENT_ID: 'test-client', YOUTUBE_CLIENT_SECRET: 'test-secret', LIVEPILOT_BASE_URL: 'http://127.0.0.1:3000', YOUTUBE_REDIRECT_URI: 'http://127.0.0.1:3000/api/auth/callback', LIVEPILOT_APP_SECRET: 'test-secret-with-at-least-thirty-two-bytes' }
let directory = ''; let previous: Record<string, string | undefined> = {}
/** Restores a test-only environment variable after the isolated catalog is removed. */
function restore(name: string, value: string | undefined): void { if (value === undefined) delete process.env[name]; else process.env[name] = value }
/** Returns an API adapter that has no network and defaults to a confirmed live lifecycle. */
function api(overrides: Partial<LiveServiceApi> = {}): LiveServiceApi {
  return {
    getCurrentChannel: async () => ({ id: 'youtube-channel', title: 'Channel' }), listLiveBroadcasts: async () => [], getBroadcastById: async () => null,
    createBroadcast: async () => ({ id: 'broadcast-1', snippet: { title: 'Test', description: '' }, status: { lifeCycleStatus: 'ready', privacyStatus: 'unlisted' } }),
    getOrCreateLiveStream: async () => ({ streamId: 'stream-1', title: 'Stream', streamName: 'private', ingestionAddress: 'private' }), getLiveStreamById: async () => null,
    bindBroadcast: async () => undefined, getBroadcastContentDetails: async () => ({ enableMonitorStream: false, boundStreamId: 'stream-1' }), getBroadcastLifeCycleStatus: async () => 'live',
    getStreamStatus: async () => ({ streamId: 'stream-1', title: 'Stream', streamStatus: 'active', healthStatus: 'good', configurationIssues: [] }), transitionBroadcast: async () => undefined,
    ...overrides,
  }
}
/** Builds an in-memory OBS adapter and records only the allowed control calls. */
function obs(input: Partial<ObsControlPort> = {}): ObsControlPort & { calls: string[] } {
  const calls: string[] = []
  return { calls, getStreamStatus: async () => { calls.push('status'); return { active: false } }, startStream: async () => { calls.push('start') }, stopStream: async () => { calls.push('stop') }, ...input }
}
/** Creates one Channel and its encrypted loopback OBS registration for a coordinator test. */
async function channelWithObs() { const authorized = await upsertAuthorizedChannel({ id: 'youtube-channel', title: 'Channel' }); await registerObsInstance({ channelId: authorized.channel.id, label: 'OBS A', port: 4455, passwordCiphertext: sealJson({ password: 'secret' }) }); return authorized.channel }
/** Builds a coordinator whose polls do not consume test time. */
function coordinator(client: ObsControlPort, service: LiveServiceApi): RunCoordinator { return new RunCoordinator({ obsClient: client, apiFor: () => service, sleep: async () => undefined, pollAttempts: 2 }) }

/** Covers the executable sequencing and failure behavior without a real OBS or YouTube Channel. */
describe('RunCoordinator', () => {
  /** Configures an empty private store for each isolated test. */
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'livepilot-run-test-')); const values = { ...environment, LIVEPILOT_DATA_DIR: directory }; previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]])); Object.assign(process.env, values); resetRuntimeConfigForTests() })
  /** Deletes only test-owned state and restores runtime configuration. */
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); for (const [key, value] of Object.entries(previous)) restore(key, value); resetRuntimeConfigForTests() })
  /** Refuses an unavailable OBS before a Run or YouTube resource is created. */
  it('rejects an unreachable OBS before creating a run', async () => { const channel = await channelWithObs(); const client = obs({ getStreamStatus: async () => { throw new LivePilotError('OBS_UNREACHABLE', 'offline') } }); await expect(coordinator(client, api()).start(channel.id)).rejects.toMatchObject({ code: 'OBS_UNREACHABLE' }); expect((await listRecords()).runs).toHaveLength(0) })
  /** Refuses to take over an OBS output whose stream was not started by this Run. */
  it('rejects an already streaming OBS before creating a run', async () => { const channel = await channelWithObs(); const client = obs({ getStreamStatus: async () => ({ active: true }) }); await expect(coordinator(client, api()).start(channel.id)).rejects.toMatchObject({ code: 'OBS_ALREADY_STREAMING' }); expect((await listRecords()).runs).toHaveLength(0) })
  /** Persists a failed Run when OBS StartStream itself does not confirm output. */
  it('records an OBS start failure without reporting a live run', async () => { const channel = await channelWithObs(); const client = obs({ startStream: async () => { throw new LivePilotError('OBS_START_FAILED', 'start rejected') } }); await expect(coordinator(client, api()).start(channel.id)).rejects.toMatchObject({ code: 'OBS_START_FAILED' }); expect((await listRecords()).runs[0]).toMatchObject({ phase: 'failed' }) })
  /** Holds the Channel in recovery when OBS started but YouTube ingest never becomes active. */
  it('marks ingest timeout as recovery required after OBS has started', async () => { const channel = await channelWithObs(); const client = obs(); const service = api({ getStreamStatus: async () => ({ streamId: 'stream-1', title: 'Stream', streamStatus: 'inactive', healthStatus: 'good', configurationIssues: [] }) }); await expect(coordinator(client, service).start(channel.id)).rejects.toMatchObject({ code: 'INGEST_TIMEOUT' }); expect((await listRecords()).runs[0]).toMatchObject({ phase: 'recovery_required', obsState: 'recovery_required' }); expect(client.calls).toEqual(['status', 'start']) })
  /** Holds the Channel in recovery when YouTube never confirms the live transition. */
  it('marks uncertain live transition as recovery required', async () => { const channel = await channelWithObs(); const client = obs(); const service = api({ getBroadcastLifeCycleStatus: async () => 'testing' }); await expect(coordinator(client, service).start(channel.id)).rejects.toMatchObject({ code: 'LIVE_TRANSITION_FAILED' }); expect((await listRecords()).runs[0]).toMatchObject({ phase: 'recovery_required' }) })
  /** Proves that a failed YouTube complete transition never reaches OBS StopStream. */
  it('does not stop OBS when complete fails', async () => { const channel = await channelWithObs(); const instance = (await listRecords()).obsInstances[0]; const run = await createRun(channel.id, instance.id); await updateRun(run.id, { broadcastId: 'broadcast-1', phase: 'live' }); const client = obs(); const service = api({ transitionBroadcast: async (_id, target) => { if (target === 'complete') throw new LivePilotError('COMPLETE_TRANSITION_FAILED', 'not complete') } }); await expect(coordinator(client, service).stop(run.id)).rejects.toMatchObject({ code: 'COMPLETE_TRANSITION_FAILED' }); expect(client.calls).not.toContain('stop'); await expect(requireRun(run.id)).resolves.toMatchObject({ phase: 'stop_failed' }) })
  /** Requires an explicit inactive refresh after OBS stop fails before releasing Channel occupancy. */
  it('records stop recovery and releases only after inactive refresh', async () => { const channel = await channelWithObs(); const instance = (await listRecords()).obsInstances[0]; const run = await createRun(channel.id, instance.id); await updateRun(run.id, { broadcastId: 'broadcast-1', phase: 'live' }); const client = obs({ stopStream: async () => { throw new LivePilotError('OBS_STOP_FAILED', 'still active') } }); const service = api({ getBroadcastLifeCycleStatus: async () => 'complete' }); const subject = coordinator(client, service); await expect(subject.stop(run.id)).rejects.toMatchObject({ code: 'OBS_STOP_FAILED' }); await expect(requireRun(run.id)).resolves.toMatchObject({ phase: 'recovery_required' }); await subject.refreshObs(channel.id); await expect(requireRun(run.id)).resolves.toMatchObject({ phase: 'failed', obsState: 'inactive' }) })
})
