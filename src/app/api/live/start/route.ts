/**
 * Start Live API：在同源授权和 ingest active 安全门之后推进 YouTube 生命周期。
 */
import { NextRequest } from 'next/server'
import { liveService } from '@/server/liveService'
import { failure, ok, payload, readBroadcastId, readJsonObject, validateMutation } from '@/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** 对指定 Broadcast 执行必要的 testing 与 live transition，并确认真实状态。 */
export async function POST(request: NextRequest) {
  try {
    const security = await validateMutation(request, true)
    const body = await readJsonObject(request)
    const snapshot = await liveService.startBroadcast(readBroadcastId(body.broadcastId))
    return ok(payload(snapshot, security.csrfToken))
  } catch (error) {
    return failure(error)
  }
}
