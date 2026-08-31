/**
 * 跟踪单进程 YouTube Data API 配额估算与超限窗口，供服务端状态机阻止无效重试。
 */
import 'server-only'

import type { QuotaState } from '@/shared/types'

export const YOUTUBE_DAILY_QUOTA = 10_000

const globalQuota = globalThis as typeof globalThis & {
  __livePilotQuota?: { used: number; exceededUntil: Date | null }
}
const quota = globalQuota.__livePilotQuota ??= { used: 0, exceededUntil: null }

/**
 * 从 Intl 分段结果读取指定日期字段，避免匿名数组回调掩盖太平洋时区计算语义。
 * parts 只来自服务端 Intl API，不处理浏览器提供的任意结构。
 */
function readDatePart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  for (const part of parts) {
    if (part.type === type) return Number(part.value)
  }
  return Number(undefined)
}

/**
 * 找出候选 UTC 时刻中在 America/Los_Angeles 显示为午夜的值，以兼容夏令时偏移。
 */
function findPacificMidnight(
  candidates: Date[],
  formatter: Intl.DateTimeFormat,
): Date | undefined {
  for (const candidate of candidates) {
    if (['24', '00'].includes(formatter.format(candidate))) return candidate
  }
  return undefined
}

/**
 * 计算给定时刻之后的下一个太平洋时间午夜，作为 YouTube 日配额重置边界。
 * 计算完全由服务端可信时钟与固定 IANA 时区完成，不接受客户端提供的时区规则。
 */
export function nextMidnightPacific(from: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(from)
  const candidates = [
    new Date(Date.UTC(
      readDatePart(parts, 'year'),
      readDatePart(parts, 'month') - 1,
      readDatePart(parts, 'day') + 1,
      7,
    )),
    new Date(Date.UTC(
      readDatePart(parts, 'year'),
      readDatePart(parts, 'month') - 1,
      readDatePart(parts, 'day') + 1,
      8,
    )),
  ]
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    hour12: false,
  })
  return findPacificMidnight(candidates, formatter) ?? candidates[1]
}

/**
 * 累加有效的正数 API 配额成本；忽略非有限值和非正数，避免状态被异常输入污染。
 * cost 应来自服务端固定的 YouTube API 成本表，而不是浏览器声明值。
 */
export function addQuotaUsage(cost: number): void {
  if (Number.isFinite(cost) && cost > 0) quota.used += cost
}

/**
 * 将当前进程标记为配额超限直到下一个太平洋午夜，抑制服务端继续消耗写请求。
 */
export function markQuotaExceeded(now: Date = new Date()): void {
  quota.exceededUntil = nextMidnightPacific(now)
}

/**
 * 返回可公开展示的配额摘要，并在可信服务端时间跨过重置点后清空进程内计数。
 */
export function getQuotaState(now: Date = new Date()): QuotaState {
  if (quota.exceededUntil && now >= quota.exceededUntil) {
    quota.exceededUntil = null
    quota.used = 0
  }
  return {
    exceeded: Boolean(quota.exceededUntil),
    resetsAt: quota.exceededUntil?.toISOString() ?? null,
    used: quota.used,
    limit: YOUTUBE_DAILY_QUOTA,
  }
}

/**
 * 清空进程内配额状态，供确定性测试隔离使用；生产请求不应调用。
 */
export function resetQuotaStateForTests(): void {
  quota.used = 0
  quota.exceededUntil = null
}
