/** Tests the one-way private catalog migration away from historical FFmpeg Run state. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resetRuntimeConfigForTests } from '@/server/config'
import { LivePilotError } from '@/server/errors'
import { migrateLegacyControlPlane } from '@/server/legacyMigration'
import { dataPath, readPrivateFile, writePrivateFile } from '@/server/storage'

const environment = { YOUTUBE_CLIENT_ID: 'test-client', YOUTUBE_CLIENT_SECRET: 'test-secret', LIVEPILOT_BASE_URL: 'http://127.0.0.1:3000', YOUTUBE_REDIRECT_URI: 'http://127.0.0.1:3000/api/auth/callback', LIVEPILOT_APP_SECRET: 'test-secret-with-at-least-thirty-two-bytes' }
let directory = ''; let previous: Record<string, string | undefined> = {}
/** Restores a test environment variable when the isolated private data directory is gone. */
function restore(name: string, value: string | undefined): void { if (value === undefined) delete process.env[name]; else process.env[name] = value }
/** Verifies that historic Worker state cannot silently be discarded while it might still output. */
describe('migrateLegacyControlPlane', () => {
  /** Creates a new private-data directory for every migration fixture. */
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'livepilot-migration-test-')); const values = { ...environment, LIVEPILOT_DATA_DIR: directory }; previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]])); Object.assign(process.env, values); resetRuntimeConfigForTests() })
  /** Deletes only temporary migration files and restores the outer environment. */
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); for (const [key, value] of Object.entries(previous)) restore(key, value); resetRuntimeConfigForTests() })
  /** Keeps Connection/Channel/reusable Stream and makes a suffixed private backup after terminal historical Runs. */
  it('backs up terminal v1 data and clears old jobs and runs', async () => { const old = { version: 1, connections: [{ id: 'connection-123456', label: 'Channel', createdAt: '2026-01-01' }], channels: [{ id: 'channel-123456', connectionId: 'connection-123456', youtubeChannelId: 'youtube', title: 'Channel', reusableStreamId: 'stream-1', createdAt: '2026-01-01' }], jobs: [{ id: 'job' }], runs: [{ phase: 'completed', workerPhase: 'stopped' }] }; await writePrivateFile(dataPath('control-plane.json'), JSON.stringify(old)); await migrateLegacyControlPlane(); expect(await readPrivateFile(dataPath('control-plane.ffmpeg-v1.json'))).toBe(JSON.stringify(old)); await expect(readPrivateFile(dataPath('control-plane.json'))).resolves.toBe(JSON.stringify({ version: 2, connections: old.connections, channels: old.channels, obsInstances: [], runs: [] })) })
  /** Rejects the migration before any backup/write when a historical Run could still output. */
  it('refuses a v1 migration while a historical run may still be active', async () => { await writePrivateFile(dataPath('control-plane.json'), JSON.stringify({ version: 1, connections: [], channels: [], jobs: [], runs: [{ phase: 'live', workerPhase: 'pushing' }] })); await expect(migrateLegacyControlPlane()).rejects.toBeInstanceOf(LivePilotError); await expect(readPrivateFile(dataPath('control-plane.ffmpeg-v1.json'))).resolves.toBeNull() })
})
