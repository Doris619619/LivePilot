/** Creates a durable Live Job after server-side Channel and media validation. */
import { NextRequest } from 'next/server'
import { createLiveJob, controlPlaneSnapshot } from '@/server/controlPlaneService'
import { failure, ok, readJsonObject, readOpaqueId, validateMutation } from '@/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Accepts only opaque resource IDs and returns a freshly rebuilt safe snapshot. */
export async function POST(request: NextRequest) {
  try {
    const security = await validateMutation(request, true)
    const body = await readJsonObject(request)
    await createLiveJob({
      channelId: readOpaqueId(body.channelId, 'Channel'),
      name: typeof body.name === 'string' ? body.name : '',
      videoAssetId: readOpaqueId(body.videoAssetId, '视频媒体'),
      audioAssetIds: Array.isArray(body.audioAssetIds) ? body.audioAssetIds.map((value) => readOpaqueId(value, '音乐媒体')) : [],
    })
    return ok({ snapshot: await controlPlaneSnapshot(), csrfToken: security.csrfToken })
  } catch (error) {
    return failure(error)
  }
}
