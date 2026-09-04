/**
 * Centralizes server-side HTTP response shaping and request security checks for
 * LivePilot API routes; credentials and YouTube secrets never cross this boundary.
 */
import 'server-only'

import { NextRequest, NextResponse } from 'next/server'
import type { AppSnapshot, DashboardPayload, Result } from '@/shared/types'
import { getRuntimeConfig, isConfigured } from './config'
import { LivePilotError, toPublicError } from './errors'
import { getQuotaState } from './quotaState'
import {
  FLOW_COOKIE,
  OWNER_COOKIE,
  csrfToken,
  newOpaqueId,
  verifyCsrf,
  verifyOwnerSession,
} from './session'

export const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
}

export interface RequestSecurityContext {
  flowId: string
  ownerId: string | null
  csrfToken: string
}

/**
 * Rejects requests whose Host header differs from the configured LivePilot origin.
 * The comparison uses only trusted server configuration and prevents host-header abuse.
 */
export function assertAllowedHost(request: NextRequest): void {
  const expected = new URL(getRuntimeConfig().appBaseUrl)
  const actualHost = request.headers.get('host')
  if (!actualHost || actualHost.toLowerCase() !== expected.host.toLowerCase()) {
    throw new LivePilotError('UNAUTHORIZED', '请求 Host 不属于 LivePilot。', { retryable: false })
  }
}

/**
 * Validates a state-changing JSON request before any YouTube operation executes.
 * It enforces Host, Origin, Fetch Metadata, owner-session, and CSRF boundaries and
 * returns only opaque server-issued session identifiers.
 */
export async function validateMutation(
  request: NextRequest,
  requireOwner: boolean,
): Promise<RequestSecurityContext> {
  assertAllowedHost(request)
  const expectedOrigin = new URL(getRuntimeConfig().appBaseUrl).origin
  if (request.headers.get('origin') !== expectedOrigin) {
    throw new LivePilotError('CSRF_FAILED', '请求 Origin 与 LivePilot 不一致。', { retryable: false })
  }
  const fetchSite = request.headers.get('sec-fetch-site')
  if (fetchSite && fetchSite !== 'same-origin') {
    throw new LivePilotError('CSRF_FAILED', '拒绝跨站控制请求。', { retryable: false })
  }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new LivePilotError('CSRF_FAILED', '写操作必须使用 application/json。', { retryable: false })
  }
  const flowId = request.cookies.get(FLOW_COOKIE)?.value
  if (!flowId) throw new LivePilotError('CSRF_FAILED', '缺少浏览器控制会话，请刷新页面。')
  const ownerId = request.cookies.get(OWNER_COOKIE)?.value ?? null
  if (requireOwner && !await verifyOwnerSession(ownerId)) {
    throw new LivePilotError('UNAUTHORIZED', '当前浏览器没有 YouTube 控制会话。')
  }
  const sessionId = requireOwner ? ownerId as string : flowId
  const received = request.headers.get('x-livepilot-csrf')
  if (!verifyCsrf(sessionId, received)) {
    throw new LivePilotError('CSRF_FAILED', 'CSRF token 无效，请刷新页面。', { retryable: false })
  }
  return { flowId, ownerId, csrfToken: csrfToken(sessionId) }
}

/** Builds the public dashboard state returned when no owner session is connected. */
export function disconnectedSnapshot(): AppSnapshot {
  return {
    configured: isConfigured(),
    connected: false,
    channel: null,
    broadcasts: [],
    selectedBroadcastId: null,
    selectedBroadcast: null,
    stream: null,
    stage: 'offline',
    quota: getQuotaState(),
    error: null,
  }
}

/**
 * Serializes a successful API result with private, no-store response headers.
 * `data` must already be a browser-safe DTO and must not contain tokens or stream keys.
 */
export function ok<T>(data: T, init?: ResponseInit): NextResponse<Result<T>> {
  return NextResponse.json({ ok: true, data }, { ...init, headers: { ...NO_STORE_HEADERS, ...init?.headers } })
}

/**
 * Converts an internal failure into the allowlisted public error contract.
 * Authentication and CSRF failures receive explicit HTTP status codes while causes,
 * credentials, and other server-only details remain hidden.
 */
export function failure(error: unknown, status = 400): NextResponse<Result<never>> {
  const publicError = toPublicError(error)
  const responseStatus = publicError.code === 'UNAUTHORIZED' ? 401
    : publicError.code === 'CSRF_FAILED' ? 403
      : status
  return NextResponse.json(
    { ok: false, error: publicError },
    { status: responseStatus, headers: NO_STORE_HEADERS },
  )
}

/** Packages a browser-safe snapshot together with its session-bound CSRF token. */
export function payload(snapshot: AppSnapshot, csrf: string): DashboardPayload {
  return { snapshot, csrfToken: csrf }
}

/**
 * Validates an untrusted request value as a syntactically safe YouTube Broadcast ID.
 * This is format validation only; server-side API reads still establish ownership.
 */
export function readBroadcastId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{3,128}$/.test(value)) {
    throw new LivePilotError('NO_BROADCAST', 'Broadcast ID 格式无效。')
  }
  return value
}

/** Validates a server-issued opaque ID before repository lookup; ownership is verified server-side. */
export function readOpaqueId(value: unknown, label = '资源'): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{12,128}$/.test(value)) {
    throw new LivePilotError('INVALID_STATE', label + ' ID 格式无效。', { retryable: false })
  }
  return value
}

/**
 * Parses an untrusted request body and requires a non-array JSON object.
 * Parse details are wrapped so malformed input cannot leak internal exceptions.
 */
export async function readJsonObject(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const value = await request.json() as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required')
    return value as Record<string, unknown>
  } catch (error) {
    throw new LivePilotError('INVALID_STATE', '请求 JSON 格式无效。', { cause: error, retryable: false })
  }
}

/**
 * Reuses the server-issued OAuth flow cookie or creates a fresh opaque flow ID.
 * Browser input is used only as an opaque session key and never as a credential.
 */
export function ensureFlowId(request: NextRequest): { flowId: string; isNew: boolean } {
  const current = request.cookies.get(FLOW_COOKIE)?.value
  return current ? { flowId: current, isNew: false } : { flowId: newOpaqueId(), isNew: true }
}

/**
 * Returns consistent browser-cookie protections for the configured HTTP/HTTPS origin.
 * Callers choose lifetime and JavaScript visibility; SameSite and path remain fixed.
 */
export function browserCookieOptions(maxAge: number, httpOnly: boolean): {
  httpOnly: boolean
  sameSite: 'lax'
  secure: boolean
  path: '/'
  maxAge: number
} {
  return {
    httpOnly,
    sameSite: 'lax',
    secure: new URL(getRuntimeConfig().appBaseUrl).protocol === 'https:',
    path: '/',
    maxAge,
  }
}
