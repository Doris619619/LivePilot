/** Validates FFmpeg structured progress parsing without spawning a real media process. */
import { afterEach, describe, expect, it } from 'vitest'
import { parseFfmpegProgress, resolveFfmpegHttpProxy } from '@/server/ffmpegWorker'

/** Covers the worker heartbeat contract used to distinguish pushing from process liveness. */
describe('parseFfmpegProgress', () => {
  /** Parses a normal progress record and converts microseconds to milliseconds. */
  it('accepts continue progress with bounded operational fields', () => {
    expect(parseFfmpegProgress([
      'frame=42', 'fps=29.97', 'bitrate=1234.5kbits/s', 'speed=1.01x', 'out_time_us=2400000', 'progress=continue',
    ])).toEqual({ frame: 42, fps: 29.97, bitrate: '1234.5kbits/s', speed: '1.01x', outTimeMs: 2400 })
  })

  /** Rejects incomplete arbitrary key-value output so stderr cannot masquerade as pushing telemetry. */
  it('rejects records without the FFmpeg progress marker', () => {
    expect(parseFfmpegProgress(['frame=9', 'out_time_us=1000000'])).toBeNull()
  })
})

/** Validates that Stream Key egress can only use an explicitly configured local proxy. */
describe('resolveFfmpegHttpProxy', () => {
  const original = process.env.LIVEPILOT_FFMPEG_HTTP_PROXY

  /** Restores the inherited process environment after every proxy assertion. */
  afterEach(() => {
    if (original === undefined) delete process.env.LIVEPILOT_FFMPEG_HTTP_PROXY
    else process.env.LIVEPILOT_FFMPEG_HTTP_PROXY = original
  })

  /** Allows a no-credential local Clash-style HTTP CONNECT endpoint. */
  it('accepts a loopback HTTP proxy', () => {
    process.env.LIVEPILOT_FFMPEG_HTTP_PROXY = 'http://127.0.0.1:7890'
    expect(resolveFfmpegHttpProxy()).toBe('http://127.0.0.1:7890')
  })

  /** Rejects remote endpoints before FFmpeg receives a server-held Stream Key. */
  it('rejects non-local proxy endpoints', () => {
    process.env.LIVEPILOT_FFMPEG_HTTP_PROXY = 'http://proxy.example.test:7890'
    expect(() => resolveFfmpegHttpProxy()).toThrow(/loopback HTTP/)
  })
})
