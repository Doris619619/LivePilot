/** Tests the durable Connection/Channel/Job/Run separation and Channel active-run invariant. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resetRuntimeConfigForTests } from '@/server/config'
import { createJob, createRun, requireJob, upsertAuthorizedChannel } from '@/server/controlPlaneStore'

const ENVIRONMENT = {
  YOUTUBE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  YOUTUBE_CLIENT_SECRET: 'test-client-secret',
  LIVEPILOT_BASE_URL: 'http://127.0.0.1:3000',
  YOUTUBE_REDIRECT_URI: 'http://127.0.0.1:3000/api/auth/callback',
  LIVEPILOT_APP_SECRET: 'unit-test-application-secret-with-more-than-32-bytes',
}

let directory = ''
let previous: Record<string, string | undefined> = {}

/** Restores one process environment key without leaking temporary test configuration. */
function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

/** Covers the local single-host catalog behavior without a YouTube account or media process. */
describe('controlPlaneStore', () => {
  /** Gives each catalog test an isolated private data root. */
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'livepilot-control-plane-test-'))
    const values = { ...ENVIRONMENT, LIVEPILOT_DATA_DIR: directory }
    previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
    Object.assign(process.env, values)
    resetRuntimeConfigForTests()
  })

  /** Deletes only the test-owned data directory and restores global configuration parsing. */
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
    for (const [name, value] of Object.entries(previous)) restore(name, value)
    resetRuntimeConfigForTests()
  })

  /** Ensures durable Job config excludes Run-only IDs and each Run freezes its own media snapshot. */
  it('separates Channel Job configuration from a frozen Live Run', async () => {
    const authorized = await upsertAuthorizedChannel({ id: 'youtube-channel-a', title: 'Channel A' })
    const job = await createJob({
      channelId: authorized.channel.id, name: 'Tokyo Lo-fi', videoAssetId: 'video-asset-1234567890',
      audioAssetIds: ['audio-asset-1234567890'], loopVideo: true, loopAudio: true,
    })
    const run = await createRun(job)

    expect(run.jobSnapshot).toMatchObject({ name: 'Tokyo Lo-fi', videoAssetId: job.videoAssetId })
    expect(run.broadcastId).toBeNull()
    expect(run.streamId).toBeNull()
    expect(run.workerPhase).toBe('stopped')
    await expect(requireJob(job.id)).resolves.not.toHaveProperty('broadcastId')
  })

  /** Enforces the single active Run rule on the YouTube Channel, not on OAuth connection identity. */
  it('rejects a second active run for the same Channel', async () => {
    const authorized = await upsertAuthorizedChannel({ id: 'youtube-channel-b', title: 'Channel B' })
    const first = await createJob({ channelId: authorized.channel.id, name: 'First', videoAssetId: 'video-one-1234567890', audioAssetIds: ['audio-one-1234567890'], loopVideo: true, loopAudio: true })
    const second = await createJob({ channelId: authorized.channel.id, name: 'Second', videoAssetId: 'video-two-1234567890', audioAssetIds: ['audio-two-1234567890'], loopVideo: true, loopAudio: true })
    await createRun(first)

    await expect(createRun(second)).rejects.toMatchObject({ code: 'RUN_ALREADY_ACTIVE' })
  })
})
