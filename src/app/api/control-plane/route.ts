/** Returns the browser-safe multi-channel control plane for the local owner session. */
import { NextRequest } from 'next/server'
import { isConfigured } from '@/server/config'
import { controlPlaneSnapshot } from '@/server/controlPlaneService'
import { assertAllowedHost, browserCookieOptions, failure, ok } from '@/server/http'
import { csrfToken, FLOW_COOKIE, OWNER_COOKIE, verifyOwnerSession } from '@/server/session'

export const runtime = 'nodejs'; export const dynamic = 'force-dynamic'

/** Issues a flow cookie when needed and returns no control records without an owner session. */
export async function GET(request: NextRequest) {
  const flow = request.cookies.get(FLOW_COOKIE)?.value
  const flowId = flow ?? crypto.randomUUID().replaceAll('-', '')
  try {
    assertAllowedHost(request); const ownerId = request.cookies.get(OWNER_COOKIE)?.value; const owner = await verifyOwnerSession(ownerId)
    const snapshot = owner ? await controlPlaneSnapshot() : { configured: isConfigured(), connections: [], channels: [], obsInstances: [], runs: [], error: null }
    const response = ok({ snapshot, csrfToken: isConfigured() ? csrfToken(owner ? ownerId as string : flowId) : '' })
    if (!flow) response.cookies.set(FLOW_COOKIE, flowId, browserCookieOptions(24 * 60 * 60, true)); return response
  } catch (error) { return failure(error) }
}
