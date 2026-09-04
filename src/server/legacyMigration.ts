/** Migrates an older local FFmpeg control catalog only after proving no old Run may still output. */
import 'server-only'

import { dataPath, readPrivateFile, writePrivateFile } from './storage'
import { LivePilotError } from './errors'

/** Performs the one-way catalog conversion while retaining Connections, Channels and reusable Streams. */
export async function migrateLegacyControlPlane(): Promise<void> {
  const currentPath = dataPath('control-plane.json'); const raw = await readPrivateFile(currentPath)
  if (!raw) return
  let old: { version?: number; connections?: unknown[]; channels?: unknown[]; runs?: Array<{ phase?: string; workerPhase?: string }> }
  try { old = JSON.parse(raw) } catch { return }
  if (old.version !== 1) return
  const active = old.runs?.some((run) => !['completed', 'failed'].includes(run.phase ?? '') || !['stopped', 'crashed'].includes(run.workerPhase ?? ''))
  if (active) throw new LivePilotError('OBS_RECOVERY_REQUIRED', '检测到旧 Run 可能仍在活动；先确认本机没有遗留 FFmpeg 输出，再执行迁移。', { retryable: false })
  await writePrivateFile(dataPath('control-plane.ffmpeg-v1.json'), raw)
  await writePrivateFile(currentPath, JSON.stringify({ version: 2, connections: old.connections ?? [], channels: old.channels ?? [], obsInstances: [], runs: [] }))
}
