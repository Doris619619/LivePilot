/**
 * Provides the server-only OBS WebSocket 5.x boundary. It connects only to the fixed
 * loopback host, authenticates with the encrypted password supplied by the catalog,
 * and deliberately exposes no scene, media, process, or Stream Key operations.
 */
import 'server-only'

import OBSWebSocket from 'obs-websocket-js'
import { LivePilotError } from './errors'

export interface ObsStreamStatus { active: boolean }
export interface ObsEndpoint { host: '127.0.0.1'; port: number; password: string }

/** Controls one short-lived authenticated OBS WebSocket session. */
export class ObsControlClient {
  /** Reads stream activity without changing OBS configuration. */
  async getStreamStatus(endpoint: ObsEndpoint): Promise<ObsStreamStatus> { return this.withClient(endpoint, async (client) => { const reply = await client.call('GetStreamStatus') as { outputActive?: boolean }; return { active: reply.outputActive === true } }) }
  /** Requests OBS to start its preconfigured output and verifies the postcondition. */
  async startStream(endpoint: ObsEndpoint): Promise<void> { await this.withClient(endpoint, async (client) => { await client.call('StartStream'); const reply = await client.call('GetStreamStatus') as { outputActive?: boolean }; if (reply.outputActive !== true) throw new LivePilotError('OBS_START_FAILED', 'OBS 未确认输出已 active。') }) }
  /** Requests OBS to stop its preconfigured output and verifies the postcondition. */
  async stopStream(endpoint: ObsEndpoint): Promise<void> { await this.withClient(endpoint, async (client) => { await client.call('StopStream'); const reply = await client.call('GetStreamStatus') as { outputActive?: boolean }; if (reply.outputActive === true) throw new LivePilotError('OBS_STOP_FAILED', 'OBS 未确认输出已 inactive。') }) }
  /** Opens and always closes one OBS session; raw transport details never leave this module. */
  private async withClient<T>(endpoint: ObsEndpoint, action: (client: OBSWebSocket) => Promise<T>): Promise<T> {
    const client = new OBSWebSocket()
    try { await client.connect('ws://127.0.0.1:' + endpoint.port, endpoint.password, { rpcVersion: 1 }); return await action(client) }
    catch (cause) { if (cause instanceof LivePilotError) throw cause; throw new LivePilotError('OBS_UNREACHABLE', '无法连接或认证对应的 OBS WebSocket。', { cause }) }
    finally { try { client.disconnect() } catch { /* Socket may never have connected. */ } }
  }
}
