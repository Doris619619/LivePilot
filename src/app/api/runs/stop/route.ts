/** Stops one Run in the safe order: confirm YouTube complete, then terminate FFmpeg. */
import { NextRequest } from 'next/server'
import { controlPlaneSnapshot } from '@/server/controlPlaneService'
import { failure, ok, readJsonObject, readOpaqueId, validateMutation } from '@/server/http'
import { runCoordinator } from '@/server/runCoordinator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Rejects arbitrary Channel/PID inputs and stops only the server-owned Run record. */
export async function POST(request: NextRequest) {
  try {
    const security = await validateMutation(request, true)
    const body = await readJsonObject(request)
    await runCoordinator.stop(readOpaqueId(body.runId, 'Live Run'))
    return ok({ snapshot: await controlPlaneSnapshot(), csrfToken: security.csrfToken })
  } catch (error) {
    return failure(error)
  }
}
