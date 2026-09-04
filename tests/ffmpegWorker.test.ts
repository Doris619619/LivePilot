/** Validates FFmpeg structured progress parsing without spawning a real media process. */
import { afterEach, describe, expect, it } from 'vitest'
import { buildYouTubeVideoArgs, FfmpegProgressDecoder, parseFfmpegProgress, resolveFfmpegHttpProxy, resolveFfmpegVideoEncoder } from '@/server/ffmpegWorker'

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

  /** FFmpeg separates records with a progress line, not necessarily an empty line. */
  it('decodes adjacent and chunk-split progress records', () => {
    const decoder = new FfmpegProgressDecoder()
    expect(decoder.push('frame=42\nfps=29.97\nout_time_us=2400000\npro')).toEqual([])
    expect(decoder.push('gress=continue\nframe=84\nfps=30\nout_time_us=4800000\nprogress=continue\n')).toEqual([
      { frame: 42, fps: 29.97, bitrate: null, speed: null, outTimeMs: 2400 },
      { frame: 84, fps: 30, bitrate: null, speed: null, outTimeMs: 4800 },
    ])
  })

  /** A final progress=end marker may arrive without a trailing line ending. */
  it('flushes an unterminated final record on close', () => {
    const decoder = new FfmpegProgressDecoder()
    expect(decoder.push('frame=9\nout_time_us=1000000\nprogress=end')).toEqual([])
    expect(decoder.finish()).toEqual([
      { frame: 9, fps: null, bitrate: null, speed: null, outTimeMs: 1000 },
    ])
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

/** Keeps video encoding deterministic and safe across portable and hardware-backed Windows installs. */
describe('YouTube video encoding', () => {
  const original = process.env.LIVEPILOT_FFMPEG_VIDEO_ENCODER

  /** Restores the inherited encoder selection after every assertion. */
  afterEach(() => {
    if (original === undefined) delete process.env.LIVEPILOT_FFMPEG_VIDEO_ENCODER
    else process.env.LIVEPILOT_FFMPEG_VIDEO_ENCODER = original
  })

  /** Uses the portable encoder by default but retains CBR and forced two-second keyframes. */
  it('builds the portable YouTube CBR profile by default', () => {
    delete process.env.LIVEPILOT_FFMPEG_VIDEO_ENCODER
    expect(resolveFfmpegVideoEncoder()).toBe('libx264')
    expect(buildYouTubeVideoArgs()).toEqual(expect.arrayContaining([
      '-b:v', '4000k', '-minrate', '4000k', '-maxrate', '4000k',
      '-g', '48', '-force_key_frames', 'expr:gte(t,n_forced*2)',
      '-x264-params', 'nal-hrd=cbr:force-cfr=1',
    ]))
  })

  /** Allows a named server-side QSV encoder while rejecting arbitrary spawned encoder values. */
  it('allows QSV and rejects unallowlisted encoder values', () => {
    process.env.LIVEPILOT_FFMPEG_VIDEO_ENCODER = 'h264_qsv'
    expect(resolveFfmpegVideoEncoder()).toBe('h264_qsv')
    expect(buildYouTubeVideoArgs()).toEqual(expect.arrayContaining(['-c:v', 'h264_qsv', '-pix_fmt', 'nv12']))
    process.env.LIVEPILOT_FFMPEG_VIDEO_ENCODER = 'anything-from-a-browser'
    expect(() => resolveFfmpegVideoEncoder()).toThrow(/受支持/)
  })
})
