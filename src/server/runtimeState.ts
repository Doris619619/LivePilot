/**
 * Persists the server-only safety marker used to remember an unconfirmed active
 * YouTube Broadcast across requests and process restarts.
 */
import 'server-only'

import { dataPath, deletePrivateFile, readPrivateFile, writePrivateFile } from './storage'

export interface RuntimeSafetyState {
  riskBroadcastId: string
  guardedChannelId: string
  markedAt: number
}

/** Resolves the private runtime-state file path; no browser-provided path is accepted. */
const statePath = (scope?: string): string => {
  if (!scope) return dataPath('runtime-safety.json')
  if (!/^[A-Za-z0-9_-]{12,128}$/.test(scope)) throw new Error('invalid safety scope')
  return dataPath('runtime-safety', scope + '.json')
}

/**
 * Reads and validates the persisted Broadcast risk marker.
 * Missing, malformed, or incomplete private state is treated as absent state.
 */
export async function readSafetyState(scope?: string): Promise<RuntimeSafetyState | null> {
  const raw = await readPrivateFile(statePath(scope))
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as RuntimeSafetyState
    return value.riskBroadcastId && value.guardedChannelId ? value : null
  } catch {
    return null
  }
}

/**
 * Records the Broadcast and Channel that may still require a safe terminal transition.
 * Both identifiers come from server-side YouTube state and the marker stays private.
 */
export async function markBroadcastRisk(broadcastId: string, channelId: string, scope?: string): Promise<void> {
  await writePrivateFile(statePath(scope), JSON.stringify({
    riskBroadcastId: broadcastId,
    guardedChannelId: channelId,
    markedAt: Date.now(),
  } satisfies RuntimeSafetyState))
}

/**
 * Removes the persisted risk marker, optionally only when it belongs to `broadcastId`.
 * The identifier guard prevents a stale request from clearing another Broadcast's risk.
 */
export async function clearBroadcastRisk(broadcastId?: string, scope?: string): Promise<void> {
  if (broadcastId) {
    const current = await readSafetyState(scope)
    if (current && current.riskBroadcastId !== broadcastId) return
  }
  await deletePrivateFile(statePath(scope))
}

/**
 * Reconciles remotely observed active Broadcast IDs into the local safety marker.
 * An empty remote list does not clear state here because exact lifecycle confirmation
 * is required by the caller before a potentially unsafe marker can be removed.
 */
export async function reconcileBroadcastRisk(
  channelId: string,
  activeBroadcastIds: string[],
  scope?: string,
): Promise<void> {
  if (activeBroadcastIds.length > 0) {
    await markBroadcastRisk(activeBroadcastIds[0], channelId, scope)
  }
}
