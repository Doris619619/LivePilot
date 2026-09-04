/**
 * Resolves browser-selected media IDs against administrator-configured Windows media
 * roots. It never accepts a client path and validates MP3 playlist compatibility before
 * FFmpeg receives any filename.
 */
import 'server-only'

import { createHash } from 'node:crypto'
import { access, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import type { MediaAsset } from '@/shared/types'
import { LivePilotError } from './errors'
import { resolveFfmpegPath } from './ffmpegWorker'

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm'])
const AUDIO_EXTENSION = '.mp3'
const MAX_MEDIA_FILES = 10_000

interface ResolvedAsset extends MediaAsset {
  path: string
}

interface AudioFormat {
  sampleRate: number
  channels: number
}

/**
 * Parses FFmpeg's input-stream description while accepting codec detail in
 * parentheses (for example, FFmpeg 8 reports `mp3 (mp3float)`).
 */
export function parseMp3Format(ffmpegOutput: string): AudioFormat | null {
  const match = /Audio:\s*mp3(?:\s*\([^)]*\))?\s*,\s*(\d+)\s*Hz,\s*(mono|stereo|\d+\s+channels)/i.exec(ffmpegOutput)
  const sampleRate = Number(match?.[1])
  const channelLabel = match?.[2]?.toLowerCase()
  const channels = channelLabel === 'mono' ? 1 : channelLabel === 'stereo' ? 2 : Number(channelLabel?.match(/\d+/)?.[0])
  return Number.isInteger(sampleRate) && Number.isInteger(channels) && channels > 0
    ? { sampleRate, channels }
    : null
}

/** Returns configured root directories, using semicolon because Windows paths contain colons. */
function configuredRoots(): string[] {
  return (process.env.LIVEPILOT_MEDIA_ROOTS ?? '')
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => resolve(value))
}

/** Classifies a filename conservatively; unsupported files are never exposed as selectable media. */
function assetKind(path: string): MediaAsset['kind'] | null {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  if (extension === AUDIO_EXTENSION) return 'audio'
  return null
}

/** Derives a stable opaque asset ID without exposing its absolute path to the renderer. */
function assetId(rootIndex: number, relativePath: string): string {
  return createHash('sha256').update(rootIndex + ':' + relativePath.replaceAll('\\', '/')).digest('base64url')
}

/** Recursively scans one root with a hard file bound, preventing an accidental whole-disk crawl. */
async function scanRoot(root: string, rootIndex: number): Promise<ResolvedAsset[]> {
  const realRoot = await realpath(root).catch(() => null)
  if (!realRoot) return []
  const rootPath: string = realRoot
  const assets: ResolvedAsset[] = []
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (assets.length >= MAX_MEDIA_FILES) throw new LivePilotError('MEDIA_INVALID', '媒体目录文件过多，请拆分 LIVEPILOT_MEDIA_ROOTS。', { retryable: false })
      const candidate = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(candidate)
        continue
      }
      if (!entry.isFile()) continue
      const kind = assetKind(candidate)
      if (!kind) continue
      const realCandidate = await realpath(candidate).catch(() => null)
      if (!realCandidate) continue
      const assetPath = realCandidate
      if (!isInside(rootPath, assetPath)) continue
      const relativePath = relative(rootPath, assetPath)
      assets.push({ id: assetId(rootIndex, relativePath), name: relativePath, kind, path: assetPath })
    }
  }
  await visit(rootPath)
  return assets
}

/** Determines whether a resolved candidate remains inside its configured root after symlink resolution. */
function isInside(root: string, candidate: string): boolean {
  const result = relative(root, candidate)
  return result === '' || (!result.startsWith('..' + sep) && result !== '..' && !isAbsolute(result))
}

/** Lists all allowed assets as browser-safe IDs and relative display names. */
export async function listMediaAssets(): Promise<MediaAsset[]> {
  const groups = await Promise.all(configuredRoots().map(scanRoot))
  return groups.flat().map(({ id, name, kind }) => ({ id, name, kind })).sort((left, right) => left.name.localeCompare(right.name))
}

/** Re-scans configured roots and retrieves one path only by a previously issued opaque ID. */
async function requireAsset(id: string, kind: MediaAsset['kind']): Promise<ResolvedAsset> {
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(id)) throw new LivePilotError('MEDIA_NOT_FOUND', '媒体资源 ID 无效。', { retryable: false })
  const groups = await Promise.all(configuredRoots().map(scanRoot))
  const asset = groups.flat().find((item) => item.id === id && item.kind === kind)
  if (!asset) throw new LivePilotError('MEDIA_NOT_FOUND', '所选媒体不存在、类型不匹配或已移出允许目录。', { retryable: false })
  await access(asset.path)
  return asset
}

/** Reads MP3 format metadata with the same server-only FFmpeg binary used for the Run. */
async function probeMp3(path: string): Promise<AudioFormat> {
  const binary = await resolveFfmpegPath()
  const output = await new Promise<string>((resolveOutput, reject) => {
    const child = spawn(binary, ['-hide_banner', '-i', path, '-map', '0:a:0', '-f', 'null', '-'], { shell: false, windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolveOutput(stderr) : reject(new Error('ffmpeg media probe failed')))
  }).catch((error) => {
    throw new LivePilotError('MEDIA_INVALID', '音乐文件无法通过 MP3 预检。', { cause: error, retryable: false })
  })
  try {
    const format = parseMp3Format(output)
    if (!format) throw new Error('invalid mp3')
    return format
  } catch (error) {
    throw new LivePilotError('MEDIA_INVALID', '音乐文件不是受支持的 MP3 音频。', { cause: error, retryable: false })
  }
}

/** Resolves and validates a Job snapshot immediately before it becomes an FFmpeg Run. */
export async function resolveRunMedia(videoAssetId: string, audioAssetIds: string[]): Promise<{ videoPath: string; audioPaths: string[] }> {
  if (audioAssetIds.length === 0) throw new LivePilotError('MEDIA_INVALID', '第一阶段 Live Job 至少需要一首 MP3 音乐。', { retryable: false })
  const video = await requireAsset(videoAssetId, 'video')
  const audio = await Promise.all(audioAssetIds.map((id) => requireAsset(id, 'audio')))
  const formats = await Promise.all(audio.map((item) => probeMp3(item.path)))
  const first = formats[0]
  if (!formats.every((item) => item.sampleRate === first.sampleRate && item.channels === first.channels)) {
    throw new LivePilotError('MEDIA_INVALID', '同一音乐列表的 MP3 必须使用相同采样率和声道数。', { retryable: false })
  }
  return { videoPath: video.path, audioPaths: audio.map((item) => item.path) }
}
