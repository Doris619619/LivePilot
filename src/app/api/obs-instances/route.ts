/** Registers a Channel's unique local Portable OBS endpoint without returning its password. */
import { NextRequest } from 'next/server'
import { controlPlaneSnapshot } from '@/server/controlPlaneService'
import { failure, ok, readJsonObject, readOpaqueId, validateMutation } from '@/server/http'
import { runCoordinator } from '@/server/runCoordinator'

export const runtime = 'nodejs'; export const dynamic = 'force-dynamic'
/** Encrypts the one-time OBS password server-side and returns only the safe control-plane DTO. */
export async function POST(request: NextRequest) { try { const security = await validateMutation(request, true); const body = await readJsonObject(request); if (typeof body.label !== 'string' || typeof body.password !== 'string' || typeof body.port !== 'number') throw new Error('invalid OBS input'); await runCoordinator.registerObs(readOpaqueId(body.channelId, 'Channel'), body.label, body.port, body.password); return ok({ snapshot: await controlPlaneSnapshot(), csrfToken: security.csrfToken }) } catch (error) { return failure(error) } }
