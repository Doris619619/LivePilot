/**
 * Renders the first local multi-account Channel/Job/Run control console. All actions
 * submit opaque IDs to same-origin server routes; no media path or ingest secret enters
 * browser state.
 */
'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { ControlPlanePayload, ControlPlaneSnapshot, PublicError, Result } from '@/shared/types'

/** Reads the standard server Result envelope without exposing transport errors to render code. */
async function result<T>(response: Response): Promise<Result<T>> {
  return response.json() as Promise<Result<T>>
}

/** Keeps a failed-but-still-pushing worker visible as occupying its Channel until an explicit Stop succeeds. */
function occupiesChannel(run: NonNullable<ControlPlaneSnapshot['runs'][number]>): boolean {
  return !['completed', 'failed'].includes(run.phase)
    || ['starting', 'pushing', 'stopping', 'unresponsive', 'recovery_required'].includes(run.workerPhase)
}

/** Provides the Job/Run console with a conservative two-second local status refresh. */
export function ControlPlaneConsole() {
  const [snapshot, setSnapshot] = useState<ControlPlaneSnapshot | null>(null)
  const [csrf, setCsrf] = useState('')
  const [error, setError] = useState<PublicError | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [channelId, setChannelId] = useState('')
  const [videoAssetId, setVideoAssetId] = useState('')
  const [audioAssetIds, setAudioAssetIds] = useState<string[]>([])
  const [jobName, setJobName] = useState('')

  /** Applies a browser-safe server snapshot and remembers its session-bound CSRF token. */
  const apply = useCallback((payload: ControlPlanePayload) => {
    setSnapshot(payload.snapshot)
    setCsrf(payload.csrfToken)
    setError(payload.snapshot.error)
  }, [])

  /** Refreshes the current control plane without issuing any lifecycle mutation. */
  const refresh = useCallback(async () => {
    try {
      const response = await result<ControlPlanePayload>(await fetch('/api/control-plane', { cache: 'no-store', credentials: 'same-origin' }))
      if (response.ok) apply(response.data)
      else setError(response.error)
    } catch {
      setError({ code: 'NETWORK_ERROR', message: '浏览器无法连接 LivePilot 服务端。', action: '确认本机服务仍在运行后刷新。', retryable: true })
    }
  }, [apply])

  useEffect(() => {
    const initial = window.setTimeout(() => { void refresh() }, 0)
    return () => window.clearTimeout(initial)
  }, [refresh])
  useEffect(() => {
    const timer = window.setInterval(() => { if (!busy) void refresh() }, 2_000)
    return () => window.clearInterval(timer)
  }, [busy, refresh])

  /** Posts a server-owned operation and refreshes all Channel/Run state from its reply. */
  const mutate = useCallback(async (label: string, url: string, body: Record<string, unknown>) => {
    setBusy(label)
    setError(null)
    try {
      const response = await result<ControlPlanePayload>(await fetch(url, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-LivePilot-CSRF': csrf }, body: JSON.stringify(body),
      }))
      if (response.ok) apply(response.data)
      else setError(response.error)
    } catch {
      setError({ code: 'NETWORK_ERROR', message: '浏览器无法连接 LivePilot 服务端。', action: '确认本机服务仍在运行后重试。', retryable: true })
    } finally {
      setBusy(null)
    }
  }, [apply, csrf])

  /** Starts a state-bound OAuth transaction; Google navigation occurs only after server approval. */
  const connect = useCallback(async () => {
    setBusy('connect')
    try {
      const response = await result<{ authorizationUrl: string }>(await fetch('/api/auth/connect', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-LivePilot-CSRF': csrf }, body: '{}',
      }))
      if (response.ok) window.location.assign(response.data.authorizationUrl)
      else setError(response.error)
    } finally { setBusy(null) }
  }, [csrf])

  const videos = useMemo(() => snapshot?.media.filter((asset) => asset.kind === 'video') ?? [], [snapshot?.media])
  const audio = useMemo(() => snapshot?.media.filter((asset) => asset.kind === 'audio') ?? [], [snapshot?.media])

  /** Captures the selected MP3 IDs from a multiple select without exposing file paths. */
  function changeAudio(event: ChangeEvent<HTMLSelectElement>) {
    setAudioAssetIds([...event.currentTarget.selectedOptions].map((option) => option.value))
  }

  /** Submits a long-lived preset; all execution state will be created only when it starts. */
  function createJob() {
    void mutate('create-job', '/api/jobs', { channelId, name: jobName, videoAssetId, audioAssetIds })
  }

  if (!snapshot) return <main className="app-shell loading-shell"><p>正在读取 LivePilot 控制台…</p></main>

  const operationMessage = busy === 'start'
    ? '正在准备 Broadcast、FFmpeg Worker 和 YouTube ingest；请勿重复点击。'
    : busy === 'stop'
      ? '正在确认 YouTube complete，随后停止对应 FFmpeg Worker。'
      : busy ? '正在执行服务器操作…' : null

  return (
    <main className="app-shell">
      <header className="topbar"><div className="brand"><div><h1>LivePilot</h1><p>Channel · Job · Run · FFmpeg</p></div></div><button className="button ghost" disabled={Boolean(busy)} onClick={() => void refresh()}>刷新</button></header>
      {operationMessage && <section className="notice"><strong>{operationMessage}</strong></section>}
      {error && <section className="notice error-notice" role="alert"><div className="error-code">{error.code}</div><div><strong>{error.message}</strong><p>{error.action}</p></div></section>}
      {!snapshot.configured && <section className="notice warning"><strong>需要配置 Google OAuth 与 LIVEPILOT_APP_SECRET。</strong></section>}
      <section className="panel">
        <div className="panel-heading"><div><p className="eyebrow">OAUTH CONNECTIONS</p><h3>YouTube 频道</h3></div><button className="button primary" disabled={!snapshot.configured || Boolean(busy)} onClick={() => void connect()}>{busy === 'connect' ? '正在前往 Google…' : '添加 Google / YouTube 账号'}</button></div>
        {snapshot.channels.length === 0 ? <p className="field-help">连接后会为授权 Channel 建立独立的 Connection 和运行边界。</p> : <ul>{snapshot.channels.map((channel) => <li key={channel.id}><strong>{channel.title}</strong> · {channel.youtubeChannelId} · reusable stream: {channel.reusableStreamId ?? '尚未创建'}</li>)}</ul>}
      </section>
      <section className="workspace-grid">
        <section className="panel"><div className="panel-heading"><div><p className="eyebrow">LIVE JOB</p><h3>创建内容预设</h3></div></div>
          <label className="field-label">Channel<select value={channelId} onChange={(event) => setChannelId(event.currentTarget.value)}><option value="">选择 Channel…</option>{snapshot.channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.title}</option>)}</select></label>
          <label className="field-label">预设名称<input value={jobName} onChange={(event) => setJobName(event.currentTarget.value)} maxLength={120} /></label>
          <label className="field-label">循环视频<select value={videoAssetId} onChange={(event) => setVideoAssetId(event.currentTarget.value)}><option value="">选择视频…</option>{videos.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
          <label className="field-label">循环 MP3 音乐列表<select multiple value={audioAssetIds} onChange={changeAudio}>{audio.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
          <button className="button secondary full" disabled={Boolean(busy || !channelId || !jobName || !videoAssetId || audioAssetIds.length === 0)} onClick={createJob}>保存 Live Job</button>
          <p className="field-help">媒体来自服务端允许目录。独立音乐将替换视频内嵌音轨；第一阶段仅支持采样率和声道一致的 MP3 列表。</p>
        </section>
        <section className="panel"><div className="panel-heading"><div><p className="eyebrow">RUNS</p><h3>每频道一条活动运行</h3></div></div>
          {snapshot.jobs.length === 0 ? <p className="field-help">先创建一个 Live Job。</p> : snapshot.jobs.map((job) => {
            const active = snapshot.runs.find((run) => run.channelId === job.channelId && occupiesChannel(run))
            const run = snapshot.runs.find((item) => item.jobId === job.id && occupiesChannel(item))
            return <div className="selected-details" key={job.id}><strong>{job.name}</strong><p>视频与 {job.audioAssetIds.length} 首 MP3 循环</p>{run ? <button className="button end-live" disabled={Boolean(busy)} onClick={() => void mutate('stop', '/api/runs/stop', { runId: run.id })}>{busy === 'stop' ? '正在结束直播…' : `结束 Run · ${run.phase}`}</button> : <button className="button go-live" disabled={Boolean(busy || active)} onClick={() => void mutate('start', '/api/runs/start', { jobId: job.id })}>{busy === 'start' ? '正在准备直播…' : active ? '该 Channel 已有活动 Run' : '开始直播'}</button>}</div>
          })}
        </section>
      </section>
      <section className="panel"><div className="panel-heading"><div><p className="eyebrow">RUNTIME</p><h3>Worker / YouTube 状态</h3></div></div>{snapshot.runs.length === 0 ? <p className="field-help">尚无运行记录。</p> : <ul>{snapshot.runs.map((run) => <li key={run.id}><strong>{run.phase}</strong> · worker {run.workerPhase} · ingest {run.ingestStatus ?? 'unknown'} · YouTube {run.youtubeLifecycle ?? 'unknown'} · {run.progress.fps ?? '—'} fps · {run.progress.speed ?? '—'} · exit {run.exitCode ?? '—'}{run.error ? ` · ${run.error.code}: ${run.error.message}` : ''}</li>)}</ul>}</section>
    </main>
  )
}
