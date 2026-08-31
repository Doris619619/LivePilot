/**
 * Broadcast 创建 API：创建默认不公开的测试直播，并准备其 YouTube Stream 绑定。
 */
import { NextRequest } from 'next/server'
import { liveService } from '@/server/liveService'
import { failure, ok, payload, validateMutation } from '@/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** 创建服务端定义的安全测试 Broadcast，并返回已准备好的仪表盘快照。 */
export async function POST(request: NextRequest) {
  try {
    const security = await validateMutation(request, true)
    const snapshot = await liveService.createTestBroadcast()
    return ok(payload(snapshot, security.csrfToken))
  } catch (error) {
    return failure(error)
  }
}
