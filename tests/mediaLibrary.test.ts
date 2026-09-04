/** Validates FFmpeg MP3 metadata parsing without touching configured media roots. */
import { describe, expect, it } from 'vitest'
import { parseMp3Format } from '@/server/mediaLibrary'

/** Covers the FFmpeg 8 codec-detail spelling used by the Windows package. */
describe('parseMp3Format', () => {
  /** Accepts both the historical codec label and FFmpeg 8's parenthesized decoder detail. */
  it('accepts parenthesized MP3 codec details', () => {
    expect(parseMp3Format('Stream #0:0: Audio: mp3 (mp3float), 48000 Hz, stereo, fltp, 192 kb/s'))
      .toEqual({ sampleRate: 48000, channels: 2 })
    expect(parseMp3Format('Stream #0:0: Audio: mp3, 44100 Hz, mono, fltp, 128 kb/s'))
      .toEqual({ sampleRate: 44100, channels: 1 })
  })

  /** Keeps non-MP3 input ineligible for the phase-one playlist pipeline. */
  it('rejects other codecs', () => {
    expect(parseMp3Format('Stream #0:0: Audio: aac, 48000 Hz, stereo, fltp')).toBeNull()
  })
})
