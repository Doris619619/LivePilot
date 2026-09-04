/**
 * Runs one server-owned FFmpeg process for a Live Run. Commands use argument arrays,
 * structured -progress telemetry, bounded/redacted diagnostics, and Windows-safe stop
 * escalation; Stream Keys never leave this module's server-only boundary.
 */
import 'server-only'

import { spawn, type ChildProcess } from 'node:child_process'
import { access } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { createRequire } from 'node:module'
import { dataPath, deletePrivateFile, writePrivateFile } from './storage'
import { LivePilotError } from './errors'
import { FfmpegSocks5Bridge, resolveFfmpegSocks5Proxy } from './socks5Bridge'

export interface WorkerProgress {
  frame: number | null
  fps: number | null
  bitrate: string | null
  speed: string | null
  outTimeMs: number | null
  heartbeatAt: string
}

export interface WorkerExit {
  code: number | null
  signal: NodeJS.Signals | null
  stderrSummary: string | null
}

export interface WorkerEvents {
  onProgress: (progress: WorkerProgress) => void | Promise<void>
  onExit: (exit: WorkerExit) => void | Promise<void>
}

export interface StartWorkerInput {
  runId: string
  videoPath: string
  audioPaths: string[]
  ingestionAddress: string
  streamName: string
}

// Keep enough private context to distinguish a remote/proxy close from an encoder
// failure. This field never crosses the control-plane API boundary.
const STDERR_LIMIT = 16_384
const START_PROGRESS_TIMEOUT_MS = 20_000
const STOP_GRACE_MS = 10_000
const requireFromWorker = createRequire(process.cwd() + '/package.json')
const VIDEO_ENCODERS = new Set(['libx264', 'h264_qsv', 'h264_nvenc', 'h264_amf', 'h264_mf'])

/** Removes known server-only ingest material before diagnostics are retained in a Run. */
function redact(value: string, secrets: string[]): string {
  return secrets.reduce((current, secret) => secret ? current.replaceAll(secret, '[redacted]') : current, value)
}

/** Locates the bundled or explicitly configured FFmpeg executable without accepting browser input. */
export async function resolveFfmpegPath(): Promise<string> {
  const configured = process.env.LIVEPILOT_FFMPEG_PATH?.trim()
  if (configured) {
    if (!isAbsolute(configured)) throw new LivePilotError('FFMPEG_UNAVAILABLE', 'LIVEPILOT_FFMPEG_PATH 必须是绝对路径。', { retryable: false })
    await access(configured).catch((error) => { throw new LivePilotError('FFMPEG_UNAVAILABLE', '配置的 FFmpeg 文件不存在或不可访问。', { cause: error, retryable: false }) })
    return configured
  }
  const bundled = requireFromWorker('ffmpeg-static') as string | null
  if (!bundled) throw new LivePilotError('FFMPEG_UNAVAILABLE', 'ffmpeg-static 未提供当前 Windows 平台二进制。', { retryable: false })
  await access(bundled).catch((error) => { throw new LivePilotError('FFMPEG_UNAVAILABLE', '随应用提供的 FFmpeg 不可访问。', { cause: error, retryable: false }) })
  return bundled
}

/**
 * Accepts only a credential-free loopback HTTP CONNECT proxy for RTMPS egress.
 * A browser or remote caller can never choose this endpoint, and non-loopback
 * proxy targets are rejected to avoid silently exporting a Stream Key elsewhere.
 */
export function resolveFfmpegHttpProxy(): string | null {
  const configured = process.env.LIVEPILOT_FFMPEG_HTTP_PROXY?.trim()
  if (!configured) return null
  let url: URL
  try {
    url = new URL(configured)
  } catch (error) {
    throw new LivePilotError('FFMPEG_UNAVAILABLE', 'LIVEPILOT_FFMPEG_HTTP_PROXY 必须是本机 HTTP 代理地址。', { cause: error, retryable: false })
  }
  const isLoopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'http:' || !isLoopback || url.username || url.password
    || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || !url.port) {
    throw new LivePilotError('FFMPEG_UNAVAILABLE', 'LIVEPILOT_FFMPEG_HTTP_PROXY 仅允许无凭据的 loopback HTTP 代理。', { retryable: false })
  }
  return url.origin
}

/**
 * Chooses an allowlisted H.264 encoder from trusted server configuration only.
 * `libx264` remains portable by default; installations can opt into a verified
 * Windows hardware encoder without giving the browser control of process args.
 */
export function resolveFfmpegVideoEncoder(): string {
  const configured = process.env.LIVEPILOT_FFMPEG_VIDEO_ENCODER?.trim() || 'libx264'
  if (!VIDEO_ENCODERS.has(configured)) {
    throw new LivePilotError('FFMPEG_UNAVAILABLE', 'LIVEPILOT_FFMPEG_VIDEO_ENCODER 不是受支持的 H.264 编码器。', { retryable: false })
  }
  return configured
}

/** Builds a YouTube-compatible H.264 CBR profile with a keyframe interval no longer than two seconds at 24fps. */
export function buildYouTubeVideoArgs(encoder = resolveFfmpegVideoEncoder()): string[] {
  const isX264 = encoder === 'libx264'
  return [
    '-c:v', encoder,
    '-preset', 'veryfast',
    '-profile:v', 'high',
    '-pix_fmt', isX264 ? 'yuv420p' : 'nv12',
    '-b:v', '4000k', '-minrate', '4000k', '-maxrate', '4000k', '-bufsize', '8000k',
    '-g', '48', '-keyint_min', '48', '-force_key_frames', 'expr:gte(t,n_forced*2)',
    ...(isX264 ? ['-x264-params', 'nal-hrd=cbr:force-cfr=1'] : []),
  ]
}

/**
 * Builds the output-side options for a continuous YouTube RTMPS publish. FIFO
 * isolates encoding from a brief proxy-side disconnect and retries the exact
 * server-held target without asking the browser to re-submit any secret.
 */
export function buildYouTubeOutputArgs(target: string, httpProxy: string | null): string[] {
  return [
    '-rtmp_live', 'live', '-tcp_nodelay', '1',
    ...(httpProxy ? ['-http_proxy', httpProxy] : []),
    '-f', 'fifo', '-fifo_format', 'flv',
    '-attempt_recovery', '1', '-recover_any_error', '1',
    '-max_recovery_attempts', '12', '-recovery_wait_time', '2',
    '-restart_with_keyframe', '1', '-queue_size', '240',
    target,
  ]
}

/** Writes a quoted FFconcat list only for validated local MP3 paths, rejecting an ambiguous apostrophe edge case. */
async function writePlaylist(runId: string, audioPaths: string[]): Promise<string | null> {
  if (audioPaths.length <= 1) return null
  if (audioPaths.some((path) => path.includes("'"))) {
    throw new LivePilotError('MEDIA_INVALID', '第一阶段音乐文件路径不能包含单引号。', { retryable: false })
  }
  const path = dataPath('runs', runId, 'playlist.ffconcat')
  const content = 'ffconcat version 1.0\n' + audioPaths.map((item) => "file '" + item.replaceAll('\\', '/') + "'").join('\n') + '\n'
  await writePrivateFile(path, content)
  return path
}

/** Parses a single FFmpeg -progress record without accepting arbitrary object keys. */
export function parseFfmpegProgress(lines: string[]): Partial<WorkerProgress> | null {
  const values = new Map<string, string>()
  for (const line of lines) {
    const separator = line.indexOf('=')
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1))
  }
  if (values.get('progress') !== 'continue' && values.get('progress') !== 'end') return null
  const outTimeMicros = Number(values.get('out_time_us') ?? values.get('out_time_ms'))
  return {
    frame: numeric(values.get('frame')),
    fps: numeric(values.get('fps')),
    bitrate: values.get('bitrate') ?? null,
    speed: values.get('speed') ?? null,
    outTimeMs: Number.isFinite(outTimeMicros) && outTimeMicros >= 0 ? Math.floor(outTimeMicros / 1000) : null,
  }
}

/**
 * Decodes FFmpeg's newline-delimited progress protocol. A record ends at its
 * `progress=...` field; FFmpeg does not promise a blank line between records.
 */
export class FfmpegProgressDecoder {
  private incomplete = ''
  private record: string[] = []

  /** Accepts an arbitrary pipe chunk and returns each complete progress record. */
  push(chunk: string): Array<Partial<WorkerProgress>> {
    const lines = (this.incomplete + chunk).split(/\r?\n/)
    this.incomplete = lines.pop() ?? ''
    return this.consume(lines)
  }

  /** Flushes the final unterminated line when the child closes its progress pipe. */
  finish(): Array<Partial<WorkerProgress>> {
    const tail = this.incomplete ? [this.incomplete] : []
    this.incomplete = ''
    return this.consume(tail)
  }

  /** Builds records only at the protocol's explicit progress marker. */
  private consume(lines: string[]): Array<Partial<WorkerProgress>> {
    const completed: Array<Partial<WorkerProgress>> = []
    for (const line of lines) {
      if (!line) continue
      this.record.push(line)
      if (!line.startsWith('progress=')) continue
      const parsed = parseFfmpegProgress(this.record)
      this.record = []
      if (parsed) completed.push(parsed)
    }
    return completed
  }
}

/** Converts a finite non-negative progress value to a number and otherwise reports null. */
function numeric(value: string | undefined): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/** Owns one child process and exposes its live progress without returning its command or secret target. */
export class FfmpegWorker {
  private readonly child: ChildProcess
  private readonly playlistPath: string | null
  private readonly socksBridge: FfmpegSocks5Bridge | null
  private readonly events: WorkerEvents
  private readonly secrets: string[]
  private stderr = ''
  private progress: WorkerProgress = { frame: null, fps: null, bitrate: null, speed: null, outTimeMs: null, heartbeatAt: new Date(0).toISOString() }
  private pushingResolve: (() => void) | null = null
  private pushingReject: ((error: Error) => void) | null = null
  private exited = false
  private expectedStop = false

  private constructor(child: ChildProcess, playlistPath: string | null, socksBridge: FfmpegSocks5Bridge | null, events: WorkerEvents, secrets: string[]) {
    this.child = child
    this.playlistPath = playlistPath
    this.socksBridge = socksBridge
    this.events = events
    this.secrets = secrets
    this.observe()
  }

  /** Starts a real-time looping FFmpeg process and returns an opaque worker controller. */
  static async start(input: StartWorkerInput, events: WorkerEvents): Promise<FfmpegWorker> {
    const binary = await resolveFfmpegPath()
    const videoEncoder = resolveFfmpegVideoEncoder()
    const playlist = await writePlaylist(input.runId, input.audioPaths)
    let socksBridge: FfmpegSocks5Bridge | null = null
    const audioInput = playlist ? ['-stream_loop', '-1', '-re', '-f', 'concat', '-safe', '0', '-i', playlist] : ['-stream_loop', '-1', '-re', '-i', input.audioPaths[0]]
    const target = input.ingestionAddress.replace(/\/$/, '') + '/' + input.streamName
    try {
      const socks5 = resolveFfmpegSocks5Proxy()
      socksBridge = socks5 ? await FfmpegSocks5Bridge.start(socks5) : null
      const httpProxy = socksBridge?.httpProxyUrl ?? resolveFfmpegHttpProxy()
      const args = [
        '-hide_banner', '-nostats', '-loglevel', 'info', '-progress', 'pipe:3',
        '-stream_loop', '-1', '-re', '-i', input.videoPath,
        ...audioInput,
        '-map', '0:v:0', '-map', '1:a:0', '-map_metadata', '-1',
        ...buildYouTubeVideoArgs(videoEncoder),
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000',
        ...buildYouTubeOutputArgs(target, httpProxy),
      ]
      const child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe', 'pipe'] })
      return new FfmpegWorker(child, playlist, socksBridge, events, [input.streamName, input.ingestionAddress, target])
    } catch (error) {
      if (playlist) await deletePrivateFile(playlist)
      await socksBridge?.close().catch(() => undefined)
      throw new LivePilotError('WORKER_START_FAILED', 'FFmpeg 无法启动。', { cause: error })
    }
  }

  /** Waits until monotonic output time proves media is being pushed, not merely that a process exists. */
  async waitForPushing(timeoutMs = START_PROGRESS_TIMEOUT_MS): Promise<void> {
    if ((this.progress.outTimeMs ?? 0) > 0) return
    return new Promise<void>((resolveProgress, rejectProgress) => {
      const timer = setTimeout(() => {
        this.pushingResolve = null
        this.pushingReject = null
        rejectProgress(new LivePilotError('WORKER_UNRESPONSIVE', 'FFmpeg 未在限定时间内报告有效推流进度。'))
      }, timeoutMs)
      this.pushingResolve = () => { clearTimeout(timer); resolveProgress() }
      this.pushingReject = (error) => { clearTimeout(timer); rejectProgress(error) }
    })
  }

  /** Requests graceful FFmpeg shutdown, then uses taskkill only for this live in-memory child PID. */
  async stop(): Promise<void> {
    if (this.exited) return
    this.expectedStop = true
    this.child.stdin?.write('q\n')
    const stopped = await waitForExit(this.child, STOP_GRACE_MS)
    if (stopped) return
    const pid = this.child.pid
    if (!pid || !Number.isInteger(pid) || pid <= 0) throw new LivePilotError('WORKER_CRASHED', 'FFmpeg PID 无法安全终止。')
    await new Promise<void>((resolveStop, rejectStop) => {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
      killer.once('error', rejectStop)
      killer.once('close', (code) => code === 0 ? resolveStop() : rejectStop(new Error('taskkill failed')))
    }).catch((error) => { throw new LivePilotError('WORKER_CRASHED', 'FFmpeg 未能停止。', { cause: error }) })
  }

  /** Reports whether the worker has stopped without leaking the underlying ChildProcess to callers. */
  get hasExited(): boolean {
    return this.exited
  }

  /** Binds progress, stderr, spawn errors, and exit handling to the Run's event callbacks. */
  private observe(): void {
    const progressDecoder = new FfmpegProgressDecoder()
    const progressFd = this.child.stdio[3]
    if (progressFd && 'on' in progressFd) {
      progressFd.on('data', (chunk: Buffer) => {
        for (const progress of progressDecoder.push(chunk.toString('utf8'))) this.acceptProgress(progress)
      })
    }
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = redact((this.stderr + chunk.toString('utf8')).slice(-STDERR_LIMIT), this.secrets)
    })
    this.child.once('error', (error) => {
      this.pushingReject?.(new LivePilotError('WORKER_START_FAILED', 'FFmpeg 进程启动失败。', { cause: error }))
    })
    this.child.once('close', (code, signal) => {
      this.exited = true
      for (const progress of progressDecoder.finish()) this.acceptProgress(progress)
      void deletePlaylist(this.playlistPath)
      void this.socksBridge?.close()
      if (!this.expectedStop && (this.progress.outTimeMs ?? 0) === 0) {
        this.pushingReject?.(new LivePilotError('WORKER_CRASHED', 'FFmpeg 在开始推流前退出。'))
      }
      void this.events.onExit({ code, signal, stderrSummary: this.stderr || null })
    })
  }

  /** Accepts only records that advance output time, making pushing a real-media signal. */
  private acceptProgress(parsed: Partial<WorkerProgress>): void {
    const nextOutTime = parsed.outTimeMs ?? this.progress.outTimeMs
    const advanced = nextOutTime !== null && nextOutTime > (this.progress.outTimeMs ?? -1)
    this.progress = { ...this.progress, ...parsed, outTimeMs: nextOutTime, heartbeatAt: new Date().toISOString() }
    void this.events.onProgress(this.progress)
    if (advanced) this.pushingResolve?.()
  }
}

/** Waits briefly for the exact child instance to close; stale PIDs are never used after restart. */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true)
  return new Promise((resolveStop) => {
    const timer = setTimeout(() => { cleanup(); resolveStop(false) }, timeoutMs)
    const onClose = () => { cleanup(); resolveStop(true) }
    const cleanup = () => { clearTimeout(timer); child.removeListener('close', onClose) }
    child.once('close', onClose)
  })
}

/** Deletes only the exact run-private concat manifest after FFmpeg no longer needs it. */
async function deletePlaylist(path: string | null): Promise<void> {
  if (path) await deletePrivateFile(path).catch(() => undefined)
}

const globalWorkers = globalThis as typeof globalThis & { __livePilotWorkers?: Map<string, FfmpegWorker> }
globalWorkers.__livePilotWorkers ??= new Map()

/** Stores only live in-memory child handles; persisted Runs retain no killable process object after restart. */
export function workerRegistry(): Map<string, FfmpegWorker> {
  return globalWorkers.__livePilotWorkers as Map<string, FfmpegWorker>
}
