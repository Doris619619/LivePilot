/**
 * Broadcast 选择 API：验证同源控制权限后准备 Stream、bind 并返回最新快照。
 */
import { NextRequest } from 'next/server'
import { liveService } from '@/server/liveService'
import { failure, ok, payload, readBroadcastId, readJsonObject, validateMutation } from '@/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** 读取并校验 Broadcast ID，然后执行幂等的 prepare/bind 流程。 */
export async function POST(request: NextRequest) {
  try {
    const security = await validateMutation(request, true)
    const body = await readJsonObject(request)
    const snapshot = await liveService.prepareBroadcast(readBroadcastId(body.broadcastId))
    return ok(payload(snapshot, security.csrfToken))
  } catch (error) {
    return failure(error)
  }
}
