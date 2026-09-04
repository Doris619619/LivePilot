/** Validates FFmpeg structured progress parsing without spawning a real media process. */
import { describe, expect, it } from 'vitest'
import { parseFfmpegProgress } from '@/server/ffmpegWorker'

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
