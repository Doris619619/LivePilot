/**
 * 解析并校验 LivePilot 的服务端运行配置，集中守住 OAuth 密钥、应用密钥与私有数据目录边界。
 */
import 'server-only'

import { resolve, sep } from 'node:path'
import { LivePilotError } from './errors'

export interface RuntimeConfig {
  appBaseUrl: string
  youtubeClientId: string
  youtubeClientSecret: string
  youtubeRedirectUri: string
  appSecret: string
  dataDir: string
}

let cached: RuntimeConfig | null = null

/**
 * 将外部配置的基础地址规范化为安全 origin，仅允许 HTTPS 或本机 loopback HTTP。
 * 用户名、密码、路径、查询和片段会被拒绝，避免 OAuth 回调被导向非预期地址。
 */
function normalizedBaseUrl(raw: string | undefined): string {
  const url = new URL(raw?.trim() || 'http://127.0.0.1:3000')
  const isLoopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new LivePilotError(
      'CONFIG_MISSING',
      'LIVEPILOT_BASE_URL 必须使用 HTTPS；仅 loopback 本地地址允许 HTTP。',
      { retryable: false },
    )
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new LivePilotError('CONFIG_MISSING', 'LIVEPILOT_BASE_URL 必须是没有路径、查询或凭据的 origin。', { retryable: false })
  }
  return url.origin
}

/**
 * 构建并缓存仅供服务端使用的运行配置，同时校验回调地址和私有数据目录不会落入 public。
 * 此返回值包含 Client Secret 与应用密钥，不得序列化到浏览器响应或客户端组件。
 */
export function getRuntimeConfig(): RuntimeConfig {
  if (cached) return cached
  const appBaseUrl = normalizedBaseUrl(process.env.LIVEPILOT_BASE_URL)
  const expectedRedirect = appBaseUrl + '/api/auth/callback'
  const redirect = process.env.YOUTUBE_REDIRECT_URI?.trim() || expectedRedirect
  if (redirect !== expectedRedirect) {
    throw new LivePilotError(
      'CONFIG_MISSING',
      'YOUTUBE_REDIRECT_URI 必须精确等于 ' + expectedRedirect,
      { retryable: false },
    )
  }
  // 运行时私有目录不是构建输入，禁止 Turbopack 为动态路径追踪并打包整个仓库。
  const dataDir = resolve(/* turbopackIgnore: true */ process.env.LIVEPILOT_DATA_DIR?.trim() || '.data')
  const publicDir = resolve('public')
  if (dataDir === publicDir || dataDir.startsWith(publicDir + sep)) {
    throw new LivePilotError('CONFIG_MISSING', 'LIVEPILOT_DATA_DIR 不能位于 public 目录。', { retryable: false })
  }
  cached = {
    appBaseUrl,
    youtubeClientId: process.env.YOUTUBE_CLIENT_ID?.trim() ?? '',
    youtubeClientSecret: process.env.YOUTUBE_CLIENT_SECRET?.trim() ?? '',
    youtubeRedirectUri: redirect,
    appSecret: process.env.LIVEPILOT_APP_SECRET?.trim() ?? '',
    dataDir,
  }
  return cached
}

/**
 * 检查 Google OAuth 凭据和应用加密密钥是否达到服务端启动要求，不返回任何密钥内容。
 */
export function isConfigured(): boolean {
  const config = getRuntimeConfig()
  return Boolean(
    config.youtubeClientId
    && config.youtubeClientSecret
    && Buffer.byteLength(config.appSecret, 'utf8') >= 32,
  )
}

/**
 * 获取已通过完整性检查的服务端配置；配置不完整时以可操作错误阻止认证流程继续。
 * 调用方必须继续把返回的敏感字段限制在服务端执行环境内。
 */
export function requireConfigured(): RuntimeConfig {
  const config = getRuntimeConfig()
  if (!isConfigured()) {
    throw new LivePilotError(
      'CONFIG_MISSING',
      '缺少 Google OAuth Client ID / Client Secret，或 LIVEPILOT_APP_SECRET 少于 32 字节。',
      { retryable: false },
    )
  }
  return config
}

/**
 * 清除进程内配置缓存，供隔离测试在修改环境变量后重新解析配置；生产请求不应调用。
 */
export function resetRuntimeConfigForTests(): void {
  cached = null
}
