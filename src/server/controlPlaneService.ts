/** Converts the private multi-channel catalog into the browser-safe control-plane DTO. */
import 'server-only'

import type { ControlPlaneSnapshot } from '@/shared/types'
import { isConfigured } from './config'
import { listRecords } from './controlPlaneStore'
import { isTokenConnected } from './youtubeAuth'
import { migrateLegacyControlPlane } from './legacyMigration'

/** Reads all non-secret control-plane state for the locally authenticated owner session. */
export async function controlPlaneSnapshot(): Promise<ControlPlaneSnapshot> {
  await migrateLegacyControlPlane()
  const records = await listRecords()
  return {
    configured: isConfigured(),
    connections: await Promise.all(records.connections.map(async (connection) => ({ id: connection.id, label: connection.label, connected: await isTokenConnected(connection.id).catch(() => false) }))),
    channels: records.channels.map((channel) => ({ id: channel.id, connectionId: channel.connectionId, youtubeChannelId: channel.youtubeChannelId, title: channel.title, reusableStreamId: channel.reusableStreamId })),
    obsInstances: records.obsInstances.map((instance) => ({ id: instance.id, channelId: instance.channelId, label: instance.label, host: instance.host, port: instance.port, lastState: instance.lastState, lastSeenAt: instance.lastSeenAt })),
    runs: records.runs,
    error: null,
  }
}
