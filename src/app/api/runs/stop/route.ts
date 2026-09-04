/** Stops a server-owned Run; callers cannot provide a Channel, OBS endpoint, or process target. */
import { NextRequest } from 'next/server'
import { controlPlaneSnapshot } from '@/server/controlPlaneService'
import { failure, ok, readJsonObject, readOpaqueId, validateMutation } from '@/server/http'
import { runCoordinator } from '@/server/runCoordinator'

export const runtime = 'nodejs'; export const dynamic = 'force-dynamic'
/** Executes YouTube complete confirmation before OBS StopStream. */
export async function POST(request: NextRequest) { try { const security = await validateMutation(request, true); const body = await readJsonObject(request); await runCoordinator.stop(readOpaqueId(body.runId, 'Live Run')); return ok({ snapshot: await controlPlaneSnapshot(), csrfToken: security.csrfToken }) } catch (error) { return failure(error) } }
