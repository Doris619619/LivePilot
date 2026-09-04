/** Starts a Channel-scoped Run by resolving its unique registered OBS instance server-side. */
import { NextRequest } from 'next/server'
import { controlPlaneSnapshot } from '@/server/controlPlaneService'
import { failure, ok, readJsonObject, readOpaqueId, validateMutation } from '@/server/http'
import { runCoordinator } from '@/server/runCoordinator'

export const runtime = 'nodejs'; export const dynamic = 'force-dynamic'
/** Executes the locked OBS → ingest → YouTube live start sequence for a Channel. */
export async function POST(request: NextRequest) { try { const security = await validateMutation(request, true); const body = await readJsonObject(request); await runCoordinator.start(readOpaqueId(body.channelId, 'Channel')); return ok({ snapshot: await controlPlaneSnapshot(), csrfToken: security.csrfToken }) } catch (error) { return failure(error) } }
