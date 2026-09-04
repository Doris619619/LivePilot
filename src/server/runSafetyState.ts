/**
 * Adapts the legacy lifecycle risk-marker contract to a specific Live Run. The Run is
 * the durable source of truth for uncertain Broadcast transitions, never a global file.
 */
import 'server-only'

import { listControlPlaneRecords, updateRun } from './controlPlaneStore'

const RISK_LIFECYCLES = new Set(['testing', 'testStarting', 'live', 'liveStarting'])
const RISK_PHASES = new Set(['transitioning_live', 'live', 'stopping', 'stop_failed'])

/** Creates the safety hooks consumed by LiveService while it operates one Channel Run. */
export function createRunSafetyState(channelId: string, youtubeChannelId: string, runId: string) {
  return {
    /** Reads only an unresolved active/uncertain Broadcast risk for this YouTube Channel. */
    async read() {
      const records = await listControlPlaneRecords()
      const run = records.runs.find((item) => item.channelId === channelId && item.broadcastId
        && (RISK_PHASES.has(item.phase) || RISK_LIFECYCLES.has(item.youtubeLifecycle ?? '')))
      return run?.broadcastId ? { riskBroadcastId: run.broadcastId, guardedChannelId: youtubeChannelId, markedAt: Date.parse(run.startedAt) } : null
    },
    /** Records that the current Run may have entered a remote transition which must be reconciled. */
    async mark(broadcastId: string) {
      await updateRun(runId, { broadcastId, phase: 'transitioning_live' })
    },
    /** Clears a resolved risk by recording only the authoritative lifecycle, not deleting Run history. */
    async clear(broadcastId?: string) {
      if (!broadcastId) return
      const records = await listControlPlaneRecords()
      const resolved = records.runs.find((item) => item.channelId === channelId && item.broadcastId === broadcastId)
      if (!resolved) return
      await updateRun(resolved.id, {
        youtubeLifecycle: 'complete',
        ...(resolved.phase === 'transitioning_live' ? { phase: 'failed', endedAt: new Date().toISOString() } : {}),
      })
    },
    /** Reconciles remote active Broadcast observation into the currently executing Run. */
    async reconcile(_youtubeChannelId: string, activeBroadcastIds: string[]) {
      if (activeBroadcastIds[0]) await updateRun(runId, { broadcastId: activeBroadcastIds[0] })
    },
  }
}
