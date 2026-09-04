/**
 * Provides a server-only filesystem lease that serializes YouTube write operations
 * across concurrent web requests and recovers abandoned leases after a bounded age.
 */
import 'server-only'

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import { dataPath } from './storage'
import { LivePilotError } from './errors'

const LOCK_STALE_MS = 5 * 60_000
const LOCK_WAIT_MS = 5_000

/**
 * Pauses lock acquisition retries without blocking the Node.js event loop.
 * The caller supplies the delay in milliseconds; this helper performs no I/O.
 */
function sleep(milliseconds: number): Promise<void> {
  return new Promise(
    /* Resolve the delay only after the requested timer expires. */
    (resolve) => setTimeout(resolve, milliseconds),
  )
}

/**
 * Runs one state-changing YouTube operation while holding the process-shared lease.
 * `operation` is diagnostic metadata and `action` must contain the complete critical
 * section; ownership is verified before cleanup so one request cannot release another.
 */
export async function withNamedOperationLock<T>(scope: string, operation: string, action: () => Promise<T>): Promise<T> {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(scope)) throw new LivePilotError('INVALID_STATE', '操作锁范围无效。', { retryable: false })
  const lockPath = dataPath('locks', scope + '.lock')
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
  const startedAt = Date.now()
  const owner = randomBytes(16).toString('hex')

  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 })
      await writeFile(
        lockPath + '/owner.json',
        JSON.stringify({ owner, operation, createdAt: Date.now() }),
        { encoding: 'utf8', mode: 0o600 },
      )
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const info = await stat(lockPath)
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(lockPath, { recursive: true, force: true })
          continue
        }
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') throw readError
        continue
      }
      if (Date.now() - startedAt >= LOCK_WAIT_MS) {
        throw new LivePilotError('BUSY', '另一个 YouTube 写操作仍在执行。')
      }
      await sleep(200)
    }
  }

  try {
    return await action()
  } finally {
    try {
      const metadata = JSON.parse(await readFile(lockPath + '/owner.json', 'utf8')) as { owner?: string }
      if (metadata.owner === owner) await rm(lockPath, { recursive: true, force: true })
    } catch {
      // A stale-lock recovery may already have removed the lease.
    }
  }
}

/** Keeps the historic single-account lock for compatibility with the lifecycle service. */
export async function withOperationLock<T>(operation: string, action: () => Promise<T>): Promise<T> {
  return withNamedOperationLock('legacy-operation', operation, action)
}
