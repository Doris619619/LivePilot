/**
 * Returns the authenticated browser-safe multi-account control-plane snapshot and a
 * session-bound CSRF token. OAuth tokens, media paths, and Stream Keys never cross it.
 */
import { NextRequest } from 'next/server'
import { isConfigured } from '@/server/config'
import { controlPlaneSnapshot } from '@/server/controlPlaneService'
import { assertAllowedHost, browserCookieOptions, ensureFlowId, failure, ok } from '@/server/http'
import { csrfToken, FLOW_COOKIE, OWNER_COOKIE, verifyOwnerSession } from '@/server/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Returns an empty unauthenticated view or the complete local control plane for the owner session. */
export async function GET(request: NextRequest) {
  const flow = ensureFlowId(request)
  try {
    assertAllowedHost(request)
    const ownerId = request.cookies.get(OWNER_COOKIE)?.value ?? null
    const ownerValid = await verifyOwnerSession(ownerId)
    const snapshot = ownerValid ? await controlPlaneSnapshot() : {
      configured: isConfigured(), connections: [], channels: [], jobs: [], runs: [], media: [], error: null,
    }
    const response = ok({ snapshot, csrfToken: isConfigured() ? csrfToken(ownerValid ? ownerId as string : flow.flowId) : '' })
    if (flow.isNew) response.cookies.set(FLOW_COOKIE, flow.flowId, browserCookieOptions(24 * 60 * 60, true))
    return response
  } catch (error) {
    return failure(error)
  }
}
