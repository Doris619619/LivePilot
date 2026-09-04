/**
 * Provides a short-lived loopback HTTP CONNECT to SOCKS5 bridge for one FFmpeg
 * worker. It keeps the Stream Key inside the local process while allowing the
 * worker to use a Clash SOCKS5 port that has already been verified on Windows.
 */
import 'server-only'

import { createServer, createConnection, type Server, type Socket } from 'node:net'
import { LivePilotError } from './errors'

const HANDSHAKE_TIMEOUT_MS = 10_000
const MAX_CONNECT_HEADER_BYTES = 16 * 1024

export interface LoopbackSocks5Proxy {
  host: string
  port: number
}

/** Validates a credential-free loopback SOCKS5 endpoint from trusted server configuration. */
export function resolveFfmpegSocks5Proxy(): LoopbackSocks5Proxy | null {
  const configured = process.env.LIVEPILOT_FFMPEG_SOCKS5_PROXY?.trim()
  if (!configured) return null
  let url: URL
  try {
    url = new URL(configured)
  } catch (error) {
    throw new LivePilotError('FFMPEG_UNAVAILABLE', 'LIVEPILOT_FFMPEG_SOCKS5_PROXY 必须是本机 SOCKS5 地址。', { cause: error, retryable: false })
  }
  const isLoopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'socks5:' || !isLoopback || url.username || url.password
    || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || !url.port) {
    throw new LivePilotError('FFMPEG_UNAVAILABLE', 'LIVEPILOT_FFMPEG_SOCKS5_PROXY 仅允许无凭据的 loopback SOCKS5 代理。', { retryable: false })
  }
  const port = Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new LivePilotError('FFMPEG_UNAVAILABLE', 'LIVEPILOT_FFMPEG_SOCKS5_PROXY 端口无效。', { retryable: false })
  }
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port }
}

/** Owns one ephemeral loopback listener and the sockets it opened on behalf of a worker. */
export class FfmpegSocks5Bridge {
  readonly httpProxyUrl: string
  private readonly server: Server
  private readonly clients = new Set<Socket>()
  private readonly upstreams = new Set<Socket>()
  private closed = false

  private constructor(server: Server, port: number) {
    this.server = server
    this.httpProxyUrl = 'http://127.0.0.1:' + port
  }

  /** Starts a loopback-only bridge and returns the HTTP proxy URL FFmpeg can safely consume. */
  static async start(proxy: LoopbackSocks5Proxy): Promise<FfmpegSocks5Bridge> {
    let bridge: FfmpegSocks5Bridge | null = null
    const server = createServer((client) => {
      if (!bridge) {
        client.destroy()
        return
      }
      bridge.handleClient(client, proxy)
    })
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', rejectListen)
        resolveListen()
      })
    }).catch((error) => {
      server.close()
      throw new LivePilotError('FFMPEG_UNAVAILABLE', '无法建立 FFmpeg 本机 SOCKS5 bridge。', { cause: error })
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new LivePilotError('FFMPEG_UNAVAILABLE', 'FFmpeg 本机 SOCKS5 bridge 未返回安全端口。')
    }
    bridge = new FfmpegSocks5Bridge(server, address.port)
    return bridge
  }

  /** Closes the exact local listener and every accepted worker socket; no stale bridge survives a Run. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const client of this.clients) client.destroy()
    for (const upstream of this.upstreams) upstream.destroy()
    this.clients.clear()
    this.upstreams.clear()
    await new Promise<void>((resolveClose) => this.server.close(() => resolveClose()))
  }

  /** Parses one HTTP CONNECT request, opens the matching SOCKS5 tunnel, then relays raw TLS/RTMP bytes. */
  private handleClient(client: Socket, proxy: LoopbackSocks5Proxy): void {
    this.clients.add(client)
    client.on('close', () => this.clients.delete(client))
    client.on('error', () => undefined)
    void this.connectClient(client, proxy).catch(() => {
      if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
    })
  }

  /** Establishes SOCKS5 no-auth CONNECT before acknowledging the local HTTP proxy request. */
  private async connectClient(client: Socket, proxy: LoopbackSocks5Proxy): Promise<void> {
    const clientReader = new SocketReader(client)
    const request = await clientReader.readUntil('\r\n\r\n', MAX_CONNECT_HEADER_BYTES)
    const destination = parseHttpConnect(request.toString('latin1'))
    const upstream = await connectSocks5(proxy, destination)
    this.upstreams.add(upstream)
    upstream.on('close', () => this.upstreams.delete(upstream))
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
    client.on('close', () => upstream.destroy())
    client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: LivePilot\r\n\r\n')
    const bufferedClientBytes = clientReader.detach()
    if (bufferedClientBytes.length > 0) upstream.write(bufferedClientBytes)
    client.pipe(upstream)
    upstream.pipe(client)
  }
}

/** Restricts bridge requests to a syntactically valid HTTP CONNECT authority. */
function parseHttpConnect(request: string): { host: string; port: number } {
  const [line] = request.split('\r\n')
  const match = /^CONNECT\s+([^\s:]+):(\d{1,5})\s+HTTP\/1\.[01]$/i.exec(line ?? '')
  if (!match) throw new Error('unsupported proxy request')
  const port = Number(match[2])
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('invalid proxy port')
  return { host: match[1], port }
}

/** Connects to the configured local SOCKS5 server and completes its domain-name CONNECT handshake. */
async function connectSocks5(proxy: LoopbackSocks5Proxy, destination: { host: string; port: number }): Promise<Socket> {
  const upstream = createConnection({ host: proxy.host, port: proxy.port })
  upstream.on('error', () => undefined)
  const reader = new SocketReader(upstream)
  try {
    await onceConnected(upstream)
    upstream.write(Buffer.from([0x05, 0x01, 0x00]))
    const greeting = await reader.read(2)
    if (greeting[0] !== 0x05 || greeting[1] !== 0x00) throw new Error('SOCKS5 no-auth method rejected')
    const hostBytes = Buffer.from(destination.host, 'ascii')
    if (hostBytes.length === 0 || hostBytes.length > 255 || hostBytes.toString('ascii') !== destination.host) throw new Error('invalid SOCKS5 destination')
    upstream.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostBytes.length]), hostBytes, Buffer.from([destination.port >> 8, destination.port & 0xff])]))
    const reply = await reader.read(4)
    if (reply[0] !== 0x05 || reply[1] !== 0x00) throw new Error('SOCKS5 CONNECT rejected')
    const addressLength = reply[3] === 0x01 ? 4 : reply[3] === 0x04 ? 16 : reply[3] === 0x03 ? (await reader.read(1))[0] : 0
    if (addressLength === 0) throw new Error('unsupported SOCKS5 reply')
    await reader.read(addressLength + 2)
    const bufferedBytes = reader.detach()
    if (bufferedBytes.length > 0) upstream.unshift(bufferedBytes)
    upstream.setTimeout(0)
    return upstream
  } catch (error) {
    upstream.destroy()
    throw error
  }
}

/** Waits for one socket connection while enforcing a bounded handshake window. */
function onceConnected(socket: Socket): Promise<void> {
  if (!socket.connecting) return Promise.resolve()
  return new Promise((resolveConnect, rejectConnect) => {
    const timer = setTimeout(() => fail(new Error('SOCKS5 connection timeout')), HANDSHAKE_TIMEOUT_MS)
    const cleanup = () => { clearTimeout(timer); socket.removeListener('connect', connected); socket.removeListener('error', failed) }
    const connected = () => { cleanup(); resolveConnect() }
    const failed = (error: Error) => { cleanup(); rejectConnect(error) }
    const fail = (error: Error) => { cleanup(); rejectConnect(error) }
    socket.once('connect', connected)
    socket.once('error', failed)
  })
}

/** Buffers socket data during protocol handshakes and hands any unread bytes back to the relay. */
class SocketReader {
  private chunks: Buffer[] = []
  private bytes = 0
  private pending: (() => void) | null = null
  private failure: Error | null = null

  constructor(private readonly socket: Socket) {
    socket.on('data', this.receive)
    socket.once('error', this.fail)
    socket.once('close', this.closed)
  }

  /** Reads exactly one bounded byte sequence, waiting for more socket data when needed. */
  async read(length: number): Promise<Buffer> {
    while (this.bytes < length) await this.waitForData()
    return this.take(length)
  }

  /** Reads through one protocol delimiter while rejecting an oversized request header. */
  async readUntil(delimiter: string, maximum: number): Promise<Buffer> {
    const marker = Buffer.from(delimiter, 'latin1')
    while (true) {
      const joined = Buffer.concat(this.chunks, this.bytes)
      const end = joined.indexOf(marker)
      if (end >= 0) return this.take(end + marker.length)
      if (this.bytes >= maximum) throw new Error('proxy request header too large')
      await this.waitForData()
    }
  }

  /** Stops handshake buffering and returns every unread byte for raw tunnel forwarding. */
  detach(): Buffer {
    this.socket.removeListener('data', this.receive)
    this.socket.removeListener('error', this.fail)
    this.socket.removeListener('close', this.closed)
    const bytes = this.take(this.bytes)
    this.pending?.()
    this.pending = null
    return bytes
  }

  /** Accepts socket chunks and resumes a single blocked reader. */
  private receive = (chunk: Buffer): void => {
    this.chunks.push(chunk)
    this.bytes += chunk.length
    this.pending?.()
    this.pending = null
  }

  /** Stores the first socket failure so waiting reads fail deterministically. */
  private fail = (error: Error): void => {
    this.failure = error
    this.pending?.()
    this.pending = null
  }

  /** Treats a closed handshake socket without sufficient bytes as a deterministic read failure. */
  private closed = (): void => this.fail(new Error('socket closed during handshake'))

  /** Awaits one new chunk or throws the first socket error captured by the reader. */
  private waitForData(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolveData) => { this.pending = resolveData })
  }

  /** Removes exactly the requested prefix from buffered chunks. */
  private take(length: number): Buffer {
    const result = Buffer.allocUnsafe(length)
    let offset = 0
    while (offset < length) {
      const chunk = this.chunks[0]
      if (!chunk) throw new Error('socket buffer underflow')
      const count = Math.min(chunk.length, length - offset)
      chunk.copy(result, offset, 0, count)
      offset += count
      this.bytes -= count
      if (count === chunk.length) this.chunks.shift()
      else this.chunks[0] = chunk.subarray(count)
    }
    return result
  }
}
