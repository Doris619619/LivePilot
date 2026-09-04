/** Validates the private loopback HTTP CONNECT to SOCKS5 bridge without a real proxy or remote destination. */
import { afterEach, describe, expect, it } from 'vitest'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { FfmpegSocks5Bridge, resolveFfmpegSocks5Proxy } from '@/server/socks5Bridge'

let socksServer: Server | null = null
let bridge: FfmpegSocks5Bridge | null = null

/** Stops only the fake test listener and temporary bridge created by an individual assertion. */
afterEach(async () => {
  await bridge?.close()
  bridge = null
  await closeServer(socksServer)
  socksServer = null
  delete process.env.LIVEPILOT_FFMPEG_SOCKS5_PROXY
})

/** Covers the single-worker bridge that translates FFmpeg's HTTP proxy use into Clash-compatible SOCKS5. */
describe('FfmpegSocks5Bridge', () => {
  /** Relays one HTTP CONNECT request through SOCKS5 without exposing a listener outside loopback. */
  it('converts HTTP CONNECT into a SOCKS5 domain tunnel and relays bytes', async () => {
    let requestedHost = ''
    let requestedPort = 0
    socksServer = createServer((socket) => acceptFakeSocks(socket, (host, port) => {
      requestedHost = host
      requestedPort = port
    }))
    const socksPort = await listen(socksServer)
    bridge = await FfmpegSocks5Bridge.start({ host: '127.0.0.1', port: socksPort })
    const bridgePort = Number(new URL(bridge.httpProxyUrl).port)

    await requestAndEcho(bridgePort)

    expect(requestedHost).toBe('a.rtmps.youtube.com')
    expect(requestedPort).toBe(443)
  })

  /** Rejects proxy endpoints that could send a server-held Stream Key away from the local machine. */
  it('allows only a credential-free loopback SOCKS5 endpoint', () => {
    process.env.LIVEPILOT_FFMPEG_SOCKS5_PROXY = 'socks5://127.0.0.1:7890'
    expect(resolveFfmpegSocks5Proxy()).toEqual({ host: '127.0.0.1', port: 7890 })
    process.env.LIVEPILOT_FFMPEG_SOCKS5_PROXY = 'socks5://remote.example.test:7890'
    expect(() => resolveFfmpegSocks5Proxy()).toThrow(/loopback SOCKS5/)
  })
})

/** Starts a loopback test listener and returns its assigned ephemeral port. */
function listen(server: Server): Promise<number> {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', rejectListen)
      const address = server.address()
      if (!address || typeof address === 'string') rejectListen(new Error('missing test listener port'))
      else resolveListen(address.port)
    })
  })
}

/** Completes a minimal no-auth SOCKS5 handshake, records the requested authority, then echoes tunnel bytes. */
function acceptFakeSocks(socket: Socket, record: (host: string, port: number) => void): void {
  let buffer = Buffer.alloc(0)
  let phase: 'greeting' | 'request' | 'relay' = 'greeting'
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    if (phase === 'greeting' && buffer.length >= 3) {
      expect([...buffer.subarray(0, 3)]).toEqual([0x05, 0x01, 0x00])
      buffer = buffer.subarray(3)
      phase = 'request'
      socket.write(Buffer.from([0x05, 0x00]))
    }
    if (phase === 'request' && buffer.length >= 5) {
      const length = buffer[4]
      if (buffer.length < 5 + length + 2) return
      const host = buffer.subarray(5, 5 + length).toString('ascii')
      const port = buffer.readUInt16BE(5 + length)
      buffer = buffer.subarray(7 + length)
      record(host, port)
      phase = 'relay'
      socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]))
    }
    if (phase === 'relay' && buffer.length > 0) {
      socket.write(buffer)
      buffer = Buffer.alloc(0)
    }
  })
}

/** Establishes an HTTP CONNECT tunnel through the bridge and proves the raw byte relay works in both directions. */
function requestAndEcho(port: number): Promise<void> {
  return new Promise((resolveTunnel, rejectTunnel) => {
    const client = createConnection({ host: '127.0.0.1', port })
    let buffer = Buffer.alloc(0)
    let connected = false
    const timer = setTimeout(() => fail(new Error('bridge test timeout')), 5_000)
    const cleanup = () => { clearTimeout(timer); client.destroy() }
    const fail = (error: Error) => { cleanup(); rejectTunnel(error) }
    client.once('error', fail)
    client.once('connect', () => client.write('CONNECT a.rtmps.youtube.com:443 HTTP/1.1\r\nHost: a.rtmps.youtube.com:443\r\n\r\n'))
    client.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (!connected) {
        const marker = buffer.indexOf('\r\n\r\n')
        if (marker < 0) return
        expect(buffer.subarray(0, marker).toString('latin1')).toContain('200 Connection Established')
        buffer = buffer.subarray(marker + 4)
        connected = true
        client.write('ping')
      }
      if (connected && buffer.toString('ascii').includes('ping')) {
        cleanup()
        resolveTunnel()
      }
    })
  })
}

/** Closes a fake test server without failing when setup did not reach its listen phase. */
function closeServer(server: Server | null): Promise<void> {
  if (!server) return Promise.resolve()
  return new Promise((resolveClose) => server.close(() => resolveClose()))
}
