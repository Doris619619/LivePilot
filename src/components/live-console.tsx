/**
 * LivePilot 浏览器控制台：展示公开直播状态，并把用户操作提交给同源服务端 API。
 */
'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type {
  AppSnapshot,
  DashboardPayload,
  LiveBroadcast,
  PublicError,
  Result,
} from '@/shared/types'

/** YouTube 尚未结束的生命周期，用于阻止同时操作多个 Broadcast。 */
const ACTIVE_LIFE_CYCLES = new Set(['testing', 'testStarting', 'live', 'liveStarting'])

/** 将服务端阶段映射为界面上的短标签和操作提示。 */
const STAGE_LABELS: Record<AppSnapshot['stage'], { label: string; detail: string }> = {
  offline: { label: 'offline', detail: '选择 Broadcast，等待 OBS 直接推流到 YouTube' },
  waiting: { label: 'waiting', detail: 'YouTube 尚未确认 ingest active' },
  ready: { label: 'ready', detail: 'YouTube 已收到流，可以开始直播' },
  testing: { label: 'testing', detail: 'YouTube 正在测试 monitor stream' },
  live: { label: 'live', detail: 'YouTube API 已确认正在直播' },
  complete: { label: 'complete', detail: 'YouTube API 已确认直播结束' },
  error: { label: 'error', detail: '操作未完成，请查看错误和处理建议' },
}

/** 读取服务端统一 Result JSON，并保留调用方需要的泛型类型。 */
async function readResult<T>(response: Response): Promise<Result<T>> {
  return response.json() as Promise<Result<T>>
}

/** 判断 Broadcast 是否正处于测试、启动或直播中的活跃状态。 */
function isActiveBroadcast(broadcast: LiveBroadcast): boolean {
  return ACTIVE_LIFE_CYCLES.has(broadcast.status.lifeCycleStatus)
}

/** 从 Google OAuth 回跳参数中构造可展示的公开错误。 */
function readOAuthCallbackError(parameters: URLSearchParams): PublicError | null {
  if (parameters.get('auth') !== 'error') return null
  return {
    code: (parameters.get('code') as PublicError['code']) || 'OAUTH_FAILED',
    message: 'Google OAuth 未完成。',
    action: '检查 Web OAuth Client 与 callback URI 后重新连接。',
    retryable: true,
  }
}

/** 渲染单条 YouTube ingest 配置问题。 */
function renderConfigurationIssue(issue: string) {
  return <p className="ingest-issue" key={issue}>{issue}</p>
}

/** 提供浏览器端的单账号 YouTube Live 控制界面。 */
export function LiveConsole() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [csrfToken, setCsrfToken] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<PublicError | null>(null)
  const selectedIdRef = useRef<string | null>(null)

  const applyPayload = useCallback(
    /** 用最新 Dashboard DTO 同步组件状态，并清除上一条瞬时错误。 */
    function applyDashboardPayload(data: DashboardPayload) {
      selectedIdRef.current = data.snapshot.selectedBroadcastId
      setSnapshot(data.snapshot)
      setCsrfToken(data.csrfToken)
      setError(data.snapshot.error)
    },
    [],
  )

  const loadState = useCallback(
    /** 从服务端读取当前频道、Broadcast、ingest 与配额状态。 */
    async function loadDashboardState(selectedId = selectedIdRef.current) {
      const query = selectedId ? '?broadcastId=' + encodeURIComponent(selectedId) : ''
      const result = await readResult<DashboardPayload>(await fetch('/api/dashboard' + query, {
        cache: 'no-store',
        credentials: 'same-origin',
      }))
      if (result.ok) applyPayload(result.data)
      else setError(result.error)
    },
    [applyPayload],
  )

  useEffect(
    /** 首次读取服务端状态后再显示 OAuth 回跳错误，避免错误被 Payload 清除。 */
    function initializeConsoleFromCallback() {
      const parameters = new URLSearchParams(window.location.search)
      const callbackError = readOAuthCallbackError(parameters)
      const shouldCleanCallbackUrl = parameters.has('auth')

      /** 顺序完成首次加载、OAuth 错误展示与回跳参数清理。 */
      async function finishInitialLoad() {
        try {
          await loadState()
        } catch {
          setError({
            code: 'NETWORK_ERROR',
            message: '浏览器无法连接 LivePilot 服务端。',
            action: '确认 npm run dev/start 仍在运行后刷新页面。',
            retryable: true,
          })
        }
        if (callbackError) setError(callbackError)
        if (shouldCleanCallbackUrl) window.history.replaceState({}, '', '/')
      }

      void finishInitialLoad()
    },
    [loadState],
  )

  useEffect(
    /** 账号连接后每两秒轮询一次公开状态，并在操作执行期间暂停轮询。 */
    function scheduleDashboardPolling() {
      if (!snapshot?.connected) return

      /** 在没有写操作占用界面时刷新 Dashboard。 */
      function pollDashboard() {
        if (!busy) void loadState()
      }

      /** 组件卸载或依赖变化时停止旧的轮询定时器。 */
      function stopDashboardPolling() {
        window.clearInterval(timer)
      }

      const timer = window.setInterval(pollDashboard, 2_000)
      return stopDashboardPolling
    },
    [busy, loadState, snapshot?.connected],
  )

  const mutate = useCallback(
    /** 携带同源凭据与 CSRF Token 提交控制台写操作，并应用返回快照。 */
    async function mutateDashboard(
      label: string,
      url: string,
      body: Record<string, unknown> = {},
    ) {
      setBusy(label)
      setError(null)
      try {
        const result = await readResult<DashboardPayload>(await fetch(url, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: {
            'Content-Type': 'application/json',
            'X-LivePilot-CSRF': csrfToken,
          },
          body: JSON.stringify(body),
        }))
        if (result.ok) applyPayload(result.data)
        else setError(result.error)
      } catch {
        setError({
          code: 'NETWORK_ERROR',
          message: '浏览器无法连接 LivePilot 服务端。',
          action: '确认 npm run dev/start 仍在运行后刷新页面。',
          retryable: true,
        })
      } finally {
        setBusy(null)
      }
    },
    [applyPayload, csrfToken],
  )

  const connect = useCallback(
    /** 请求服务端创建 OAuth 事务，并把浏览器导航到 Google 授权页。 */
    async function connectYouTube() {
      setBusy('connect')
      setError(null)
      try {
        const result = await readResult<{ authorizationUrl: string }>(await fetch('/api/auth/connect', {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: {
            'Content-Type': 'application/json',
            'X-LivePilot-CSRF': csrfToken,
          },
          body: '{}',
        }))
        if (result.ok) window.location.assign(result.data.authorizationUrl)
        else setError(result.error)
      } catch {
        setError({
          code: 'NETWORK_ERROR',
          message: '无法开始 Google OAuth。',
          action: '确认 LivePilot 服务端可访问后重试。',
          retryable: true,
        })
      } finally {
        setBusy(null)
      }
    },
    [csrfToken],
  )

  const selected = snapshot?.selectedBroadcast ?? null
  const lifecycle = selected?.status.lifeCycleStatus ?? '—'
  const activeBroadcast = useMemo(
    /** 找出当前账号唯一允许继续操作的活跃 Broadcast。 */
    function findActiveBroadcast() {
      return snapshot?.broadcasts.find(isActiveBroadcast)
        ?? (selected && ACTIVE_LIFE_CYCLES.has(lifecycle) ? selected : null)
    },
    [lifecycle, selected, snapshot?.broadcasts],
  )
  const selectedIsActive = Boolean(selected && ACTIVE_LIFE_CYCLES.has(lifecycle))
  const anotherIsActive = Boolean(activeBroadcast && activeBroadcast.id !== selected?.id)
  const ingestActive = snapshot?.stream?.streamStatus === 'active'
  const canEnd = Boolean(selected && selectedIsActive && !busy)

  /** 响应连接或重新授权按钮，并显式忽略导航前的 Promise 返回值。 */
  function handleConnectClick() {
    void connect()
  }

  /** 手动请求一次最新 Dashboard 状态。 */
  function handleRefreshClick() {
    void loadState()
  }

  /** 请求服务端在安全检查通过后断开当前账号。 */
  function handleDisconnectClick() {
    void mutate('disconnect', '/api/auth/disconnect')
  }

  /** 选择一个已有 Broadcast，并触发服务端确定性绑定流程。 */
  function handleBroadcastChange(event: ChangeEvent<HTMLSelectElement>) {
    const id = event.target.value
    if (id) void mutate('select', '/api/broadcasts/select', { broadcastId: id })
  }

  /** 渲染 Broadcast 下拉选项，并禁用与当前活跃直播冲突的项。 */
  function renderBroadcastOption(broadcast: LiveBroadcast) {
    return (
      <option
        key={broadcast.id}
        value={broadcast.id}
        disabled={Boolean(activeBroadcast && activeBroadcast.id !== broadcast.id)}
      >
        {broadcast.snippet.title} · {broadcast.status.lifeCycleStatus}
      </option>
    )
  }

  /** 创建服务端默认的测试 Broadcast 并完成 Stream 绑定。 */
  function handleCreateBroadcastClick() {
    void mutate('create', '/api/broadcasts/create')
  }

  /** 请求服务端确认 ingest 后把所选 Broadcast 转入 live。 */
  function handleStartLiveClick() {
    void mutate('start', '/api/live/start', { broadcastId: selected?.id })
  }

  /** 请求服务端把所选活跃 Broadcast 转入 complete。 */
  function handleStopLiveClick() {
    void mutate('stop', '/api/live/stop', { broadcastId: selected?.id })
  }

  if (!snapshot) {
    return (
      <main className="app-shell loading-shell" aria-live="polite">
        <div className="brand-mark" aria-hidden="true"><span /></div>
        {error ? (
          <section className="notice error-notice" role="alert">
            <div className="error-code">{error.code}</div>
            <div><strong>{error.message}</strong><p>{error.action}</p></div>
          </section>
        ) : (
          <p>正在连接 LivePilot Web 服务…</p>
        )}
      </main>
    )
  }

  const stage = STAGE_LABELS[error ? 'error' : snapshot.stage]

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><span /></div>
          <div>
            <h1>LivePilot</h1>
            <p>YouTube Live control room · Web</p>
          </div>
        </div>
        <div className={'connection-badge ' + (snapshot.connected ? 'connected' : '')}>
          <span className="status-dot" aria-hidden="true" />
          YouTube · {snapshot.connected ? '已连接' : '未连接'}
        </div>
      </header>

      {!snapshot.configured && (
        <section className="notice warning" role="alert">
          <div>
            <strong>需要服务端 Google OAuth 配置</strong>
            <p>复制 <code>.env.example</code> 为 <code>.env.local</code>，填写 server-only secrets 后重启。</p>
          </div>
        </section>
      )}

      {!snapshot.connected ? (
        <section className="connect-panel">
          <div className="youtube-symbol" aria-hidden="true"><span /></div>
          <p className="eyebrow">YOUTUBE LIVE</p>
          <h2>连接你的直播频道</h2>
          <p className="connect-copy">
            OAuth 在 Google 页面完成。Client Secret、Access Token、Refresh Token 与 Stream Key 都只留在服务端。
          </p>
          <button className="button primary large" disabled={!snapshot.configured || Boolean(busy)} onClick={handleConnectClick}>
            {busy === 'connect' ? '正在前往 Google…' : '连接 Google / YouTube'}
          </button>
        </section>
      ) : (
        <>
          <section className="channel-strip">
            <div>
              <p className="eyebrow">CURRENT CHANNEL</p>
              <h2>{snapshot.channel?.title ?? '正在读取频道…'}</h2>
              <code>{snapshot.channel?.id ?? '—'}</code>
            </div>
            <div className="channel-actions">
              <button className="button ghost" disabled={Boolean(busy)} onClick={handleRefreshClick}>
                刷新状态
              </button>
              <button
                className="button ghost danger-text"
                disabled={Boolean(busy || activeBroadcast)}
                onClick={handleDisconnectClick}
              >
                断开账号
              </button>
            </div>
          </section>

          <div className="workspace-grid">
            <section className="panel">
              <div className="panel-heading">
                <div><p className="eyebrow">BROADCAST</p><h3>选择本次直播</h3></div>
                <span className="count">{snapshot.broadcasts.length} 个可用</span>
              </div>
              <label className="field-label" htmlFor="broadcast-select">已有 Broadcast</label>
              <select
                id="broadcast-select"
                value={snapshot.selectedBroadcastId ?? ''}
                disabled={Boolean(busy || selectedIsActive)}
                onChange={handleBroadcastChange}
              >
                <option value="">请选择一个直播…</option>
                {snapshot.broadcasts.map(renderBroadcastOption)}
              </select>
              <button
                className="button secondary full"
                disabled={Boolean(busy || activeBroadcast)}
                onClick={handleCreateBroadcastClick}
              >
                {busy === 'create' ? '正在创建并绑定…' : '创建测试直播'}
              </button>
              <p className="field-help">测试直播默认不公开。选择后，服务端会确定性选择/创建可复用 Stream 并确认 bind。</p>

              {selected && (
                <div className="selected-details">
                  <span>SELECTED</span>
                  <strong>{selected.snippet.title}</strong>
                  <dl>
                    <div><dt>Lifecycle</dt><dd>{lifecycle}</dd></div>
                    <div><dt>Privacy</dt><dd>{selected.status.privacyStatus}</dd></div>
                  </dl>
                </div>
              )}
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div><p className="eyebrow">INGEST</p><h3>OBS → YouTube</h3></div>
                <span className={'stream-chip ' + (ingestActive ? 'active' : '')}>
                  {snapshot.stream?.streamStatus ?? '未绑定'}
                </span>
              </div>
              <div className="stream-identity">
                <span>Bound Stream</span>
                <strong>{snapshot.stream?.title ?? '选择 Broadcast 后读取'}</strong>
                <code>{snapshot.stream?.id ?? '—'}</code>
              </div>
              <div className="signal-metrics">
                <div><span>Ingest</span><strong>{snapshot.stream?.streamStatus ?? 'unknown'}</strong></div>
                <div><span>Health</span><strong>{snapshot.stream?.healthStatus ?? 'unknown'}</strong></div>
                <div><span>Issues</span><strong>{snapshot.stream?.configurationIssues.length ?? 0}</strong></div>
              </div>
              {snapshot.stream?.configurationIssues.map(renderConfigurationIssue)}
              <p className="field-help">
                本轮没有 RTMP Relay。OBS 直接使用 YouTube Studio 中该 Stream 的 RTMPS 地址与 Key；LivePilot 不把 Key 返回浏览器。
              </p>
            </section>
          </div>

          <section className={'control-panel stage-' + (error ? 'error' : snapshot.stage)} aria-live="polite">
            <div className="control-status">
              <div className="pulse-ring" aria-hidden="true"><span /></div>
              <div><p className="eyebrow">CURRENT STATUS</p><h2>{stage.label}</h2><p>{stage.detail}</p></div>
            </div>
            <div className="control-actions">
              <button
                className="button go-live"
                disabled={Boolean(!selected || busy || anotherIsActive || !ingestActive || snapshot.stage === 'live' || snapshot.stage === 'complete')}
                onClick={handleStartLiveClick}
              >
                {busy === 'start' ? '正在确认 live…' : ingestActive ? '开始直播' : '等待 ingest active'}
              </button>
              <button
                className="button end-live"
                disabled={!canEnd}
                onClick={handleStopLiveClick}
              >
                {busy === 'stop' ? '正在确认 complete…' : '结束直播'}
              </button>
            </div>
          </section>

          <footer>
            <span>API quota estimate: {snapshot.quota.used} / {snapshot.quota.limit}</span>
            {snapshot.quota.exceeded && <strong>配额已耗尽 · {snapshot.quota.resetsAt}</strong>}
          </footer>
        </>
      )}

      {error && (
        <section className="notice error-notice" role="alert">
          <div className="error-code">{error.code}</div>
          <div>
            <strong>{error.message}</strong>
            <p>{error.action}</p>
            {snapshot.connected && error.code === 'TOKEN_INVALID' && (
              <button className="button ghost reauthorize" onClick={handleConnectClick}>
                重新授权同一频道
              </button>
            )}
          </div>
        </section>
      )}
    </main>
  )
}
