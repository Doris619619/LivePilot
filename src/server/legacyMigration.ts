/**
 * Performs the deliberately small one-time bridge from the historic global token file
 * to a Connection/Channel record. It leaves the legacy ciphertext untouched for manual
 * recovery and never introduces a general migration framework.
 */
import 'server-only'

import { listControlPlaneRecords, upsertAuthorizedChannel } from './controlPlaneStore'
import { withNamedOperationLock } from './operationLock'
import { getTokens, saveTokens } from './youtubeAuth'
import { getCurrentChannel } from './youtubeApi'

/** Migrates only when no new Connection exists and a usable legacy token remains. */
export async function migrateLegacySingleAccount(): Promise<boolean> {
  return withNamedOperationLock('legacy-migration', 'migrate-legacy-token', async () => {
    if ((await listControlPlaneRecords()).connections.length > 0) return false
    const legacy = await getTokens()
    if (!legacy) return false
    try {
      const channel = await getCurrentChannel()
      const refreshed = await getTokens()
      if (!refreshed) return false
      const authorized = await upsertAuthorizedChannel(channel)
      await saveTokens(refreshed, authorized.connection.id)
      return true
    } catch {
      // Keep legacy ciphertext in place; the operator can explicitly reauthorize without losing recovery data.
      return false
    }
  })
}
