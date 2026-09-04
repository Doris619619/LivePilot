/** Reads an OBS endpoint's real output state to support explicit recovery confirmation. */
import { NextRequest } from 'next/server'
import { controlPlaneSnapshot } from '@/server/controlPlaneService'
import { failure, ok, readJsonObject, readOpaqueId, validateMutation } from '@/server/http'
import { runCoordinator } from '@/server/runCoordinator'

export const runtime = 'nodejs'; export const dynamic = 'force-dynamic'
/** Refreshes one Channel's registered OBS state without starting or stopping output. */
export async function POST(request: NextRequest) { try { const security = await validateMutation(request, true); const body = await readJsonObject(request); await runCoordinator.refreshObs(readOpaqueId(body.channelId, 'Channel')); return ok({ snapshot: await controlPlaneSnapshot(), csrfToken: security.csrfToken }) } catch (error) { return failure(error) } }
