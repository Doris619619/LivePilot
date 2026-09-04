/** Starts one Channel-scoped Live Run from a durable Job ID. */
import { NextRequest } from 'next/server'
import { controlPlaneSnapshot } from '@/server/controlPlaneService'
import { failure, ok, readJsonObject, readOpaqueId, validateMutation } from '@/server/http'
import { runCoordinator } from '@/server/runCoordinator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Performs the full server-only prepare, worker, ingest, and YouTube live sequence. */
export async function POST(request: NextRequest) {
  try {
    const security = await validateMutation(request, true)
    const body = await readJsonObject(request)
    await runCoordinator.start(readOpaqueId(body.jobId, 'Live Job'))
    return ok({ snapshot: await controlPlaneSnapshot(), csrfToken: security.csrfToken })
  } catch (error) {
    return failure(error)
  }
}
