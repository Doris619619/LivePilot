/**
 * Stop Live API：仅对活动 Broadcast 执行 complete transition 并确认真实状态。
 */
import { NextRequest } from 'next/server'
import { liveService } from '@/server/liveService'
import { failure, ok, payload, readBroadcastId, readJsonObject, validateMutation } from '@/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** 将指定活动 Broadcast 推进到 complete，并返回确认后的仪表盘快照。 */
export async function POST(request: NextRequest) {
  try {
    const security = await validateMutation(request, true)
    const body = await readJsonObject(request)
    const snapshot = await liveService.stopBroadcast(readBroadcastId(body.broadcastId))
    return ok(payload(snapshot, security.csrfToken))
  } catch (error) {
    return failure(error)
  }
}
