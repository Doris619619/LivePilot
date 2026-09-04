/** Tests Channel isolation, OBS secret storage, unique ports, and the one-active-Run invariant. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resetRuntimeConfigForTests } from '@/server/config'
import { createRun, listRecords, registerObsInstance, upsertAuthorizedChannel } from '@/server/controlPlaneStore'
import { sealJson } from '@/server/cryptoBox'
import { controlPlaneSnapshot } from '@/server/controlPlaneService'

const environment = { YOUTUBE_CLIENT_ID: 'test-client', YOUTUBE_CLIENT_SECRET: 'test-secret', LIVEPILOT_BASE_URL: 'http://127.0.0.1:3000', YOUTUBE_REDIRECT_URI: 'http://127.0.0.1:3000/api/auth/callback', LIVEPILOT_APP_SECRET: 'test-secret-with-at-least-thirty-two-bytes' }
let directory = ''; let previous: Record<string, string | undefined> = {}
/** Restores one test environment key exactly. */
function restore(name: string, value: string | undefined): void { if (value === undefined) delete process.env[name]; else process.env[name] = value }

/** Exercises the durable, private catalog without a real Google or OBS endpoint. */
describe('controlPlaneStore', () => {
  /** Creates an isolated local private-data root. */
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'livepilot-obs-test-')); const values = { ...environment, LIVEPILOT_DATA_DIR: directory }; previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]])); Object.assign(process.env, values); resetRuntimeConfigForTests() })
  /** Removes only this test's private data and restores process configuration. */
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); for (const [key, value] of Object.entries(previous)) restore(key, value); resetRuntimeConfigForTests() })
  /** Keeps Connections and Channels distinct while preventing a second active Run on one Channel. */
  it('isolates channels and allows only one unconfirmed run per channel', async () => { const a = await upsertAuthorizedChannel({ id: 'youtube-a', title: 'A' }); const b = await upsertAuthorizedChannel({ id: 'youtube-b', title: 'B' }); await registerObsInstance({ channelId: a.channel.id, label: 'A OBS', port: 4455, passwordCiphertext: sealJson({ password: 'a-password' }) }); await registerObsInstance({ channelId: b.channel.id, label: 'B OBS', port: 4456, passwordCiphertext: sealJson({ password: 'b-password' }) }); const first = await createRun(a.channel.id, (await listRecords()).obsInstances[0].id); await expect(createRun(a.channel.id, first.obsInstanceId)).rejects.toMatchObject({ code: 'RUN_ALREADY_ACTIVE' }); await expect(createRun(b.channel.id, (await listRecords()).obsInstances[1].id)).resolves.toMatchObject({ channelId: b.channel.id }) })
  /** Rejects duplicate loopback ports and keeps the password outside public record projections. */
  it('enforces unique ports while retaining OBS password only in the private catalog', async () => { const a = await upsertAuthorizedChannel({ id: 'youtube-c', title: 'C' }); const b = await upsertAuthorizedChannel({ id: 'youtube-d', title: 'D' }); await registerObsInstance({ channelId: a.channel.id, label: 'C OBS', port: 4455, passwordCiphertext: sealJson({ password: 'secret-not-public' }) }); await expect(registerObsInstance({ channelId: b.channel.id, label: 'D OBS', port: 4455, passwordCiphertext: sealJson({ password: 'other-secret' }) })).rejects.toMatchObject({ code: 'INVALID_STATE' }); expect((await listRecords()).obsInstances[0].passwordCiphertext).not.toContain('secret-not-public') })
  /** Projects the private catalog through the HTTP-facing service without a password field or plaintext. */
  it('never exposes an OBS password through the public control-plane DTO', async () => { const authorized = await upsertAuthorizedChannel({ id: 'youtube-e', title: 'E' }); await registerObsInstance({ channelId: authorized.channel.id, label: 'E OBS', port: 4455, passwordCiphertext: sealJson({ password: 'never-return-this-password' }) }); const snapshot = await controlPlaneSnapshot(); expect(snapshot.obsInstances[0]).not.toHaveProperty('passwordCiphertext'); expect(JSON.stringify(snapshot)).not.toContain('never-return-this-password') })
})
