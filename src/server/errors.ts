/**
 * 定义 LivePilot 服务端错误模型，并将内部异常收敛为可安全返回给 Web 前端的错误结构。
 */
import 'server-only'

import type { PublicError, PublicErrorCode } from '@/shared/types'

const DEFAULT_ACTIONS: Record<PublicErrorCode, string> = {
  CONFIG_MISSING: '配置 .env.local 中的 Google OAuth 与 LIVEPILOT_APP_SECRET 后重启服务。',
  UNAUTHORIZED: '重新连接 Google / YouTube，建立当前浏览器的控制会话。',
  CSRF_FAILED: '刷新 LivePilot 页面后重试；不要从其他站点发起控制请求。',
  NOT_CONNECTED: '先连接 Google / YouTube 账号。',
  TOKEN_INVALID: '授权已失效或被撤销，请重新连接同一个 YouTube Channel。',
  OAUTH_FAILED: '检查 Web OAuth Client、固定 callback URI 与浏览器授权结果后重试。',
  NO_CHANNEL: '确认授权账号已经创建 YouTube Channel。',
  LIVE_STREAMING_NOT_ENABLED: '在 YouTube Studio 启用直播功能；首次启用可能需要等待最多 24 小时。',
  LIVE_PERMISSION_BLOCKED: '打开 YouTube 频道功能页，处理当前账号的直播限制。',
  NO_BROADCAST: '选择已有 Broadcast，或创建一个不公开测试直播。',
  NO_STREAM: '让 LivePilot 创建可复用 Stream，或在 YouTube Studio 整理已有 Stream。',
  BIND_FAILED: '确认 Broadcast 与 Stream 状态有效后重新选择。',
  INGEST_NOT_ACTIVE: '先让 OBS 直接推送到该 YouTube Stream，等页面显示 ingest active 再开始。',
  TESTING_TRANSITION_FAILED: '检查 monitor stream 与 Broadcast 状态后重试。',
  LIVE_TRANSITION_FAILED: '确认 ingest 仍为 active，并检查 YouTube 对当前 Broadcast 的限制。',
  COMPLETE_TRANSITION_FAILED: '立即在 YouTube Studio 检查并手工结束直播，然后刷新状态。',
  QUOTA_EXCEEDED: '若正在直播，请立即在 YouTube Studio 手工结束；再等待太平洋时间午夜重置或申请配额。',
  NETWORK_ERROR: '检查服务端网络、代理和 Google API 可访问性后重试。',
  BUSY: '等待当前 YouTube 写操作结束后再试。',
  INVALID_STATE: '刷新远端状态，并按当前可用操作重试。',
  UNKNOWN: '刷新页面后重试；如持续失败，请记录错误代码与操作步骤。',
}

/**
 * 携带稳定公开错误码、用户操作建议和重试属性的服务端业务异常。
 * 原始 cause 与 YouTube API reasons 仅供服务端诊断，不会由公开转换函数直接返回。
 */
export class LivePilotError extends Error {
  readonly code: PublicErrorCode
  readonly action: string
  readonly retryable: boolean
  readonly apiReasons: string[]

  /**
   * 创建标准化业务异常，并用受控默认值补齐前端可见操作建议与重试语义。
   * 调用方应避免把 Token、Client Secret 或完整上游响应写入公开 message 字段。
   */
  constructor(
    code: PublicErrorCode,
    message: string,
    options?: { action?: string; retryable?: boolean; cause?: unknown; apiReasons?: string[] },
  ) {
    super(message, { cause: options?.cause })
    this.name = 'LivePilotError'
    this.code = code
    this.action = options?.action ?? DEFAULT_ACTIONS[code]
    this.retryable = options?.retryable ?? true
    this.apiReasons = options?.apiReasons ?? []
  }
}

/**
 * 将未知异常转换为前端约定的公开错误对象，并剔除 cause、堆栈及 API reason 等内部诊断字段。
 * 对非 LivePilotError 使用固定公开文案，避免文件路径、密文或上游响应从内部异常泄漏。
 */
export function toPublicError(error: unknown): PublicError {
  if (error instanceof LivePilotError) {
    return {
      code: error.code,
      message: error.message,
      action: error.action,
      retryable: error.retryable,
    }
  }
  return {
    code: 'UNKNOWN',
    message: '服务端发生未分类错误，未执行完成当前操作。',
    action: DEFAULT_ACTIONS.UNKNOWN,
    retryable: true,
  }
}
