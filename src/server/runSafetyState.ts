/**
 * Adapts the legacy lifecycle risk-marker contract to a specific Live Run. The Run is
 * the durable source of truth for uncertain Broadcast transitions, never a global file.
 */
import 'server-only'

import { listControlPlaneRecords, updateRun } from './controlPlaneStore'

/** Creates the safety hooks consumed by LiveService while it operates one Channel Run. */
export function createRunSafetyState(channelId: string, runId: string) {
  return {
    /** Reads any unresolved Broadcast risk for this Channel, including a previous run after restart. */
    async read() {
      const records = await listControlPlaneRecords()
      const run = records.runs.find((item) => item.channelId === channelId && item.broadcastId && item.phase !== 'completed')
      return run?.broadcastId ? { riskBroadcastId: run.broadcastId, guardedChannelId: channelId, markedAt: Date.parse(run.startedAt) } : null
    },
    /** Records that the current Run may have entered a remote transition which must be reconciled. */
    async mark(broadcastId: string) {
      await updateRun(runId, { broadcastId, phase: 'transitioning_live' })
    },
    /** Clears a resolved risk by recording only the authoritative lifecycle, not deleting Run history. */
    async clear() {
      await updateRun(runId, { youtubeLifecycle: 'complete' })
    },
    /** Reconciles remote active Broadcast observation into the currently executing Run. */
    async reconcile(_youtubeChannelId: string, activeBroadcastIds: string[]) {
      if (activeBroadcastIds[0]) await updateRun(runId, { broadcastId: activeBroadcastIds[0] })
    },
  }
}
