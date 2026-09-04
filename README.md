<!-- 文件用途：说明 LivePilot 的 Portable OBS 多频道架构、本机安全边界与运行验收流程。 -->

# LivePilot

LivePilot 是本机运行的多频道 YouTube Live 控制面。它不编码、不扫描媒体、不启动或终止 OBS，也不读取、存储、展示或下发 YouTube Stream Key。

```text
LivePilot
  Connection → Channel → ObsInstance → LiveRun
                                 ↓
                    Portable OBS（独立目录/配置）
                                 ↓
                 Proxifier → Clash → YouTube RTMPS
```

`Connection` 加密保存 OAuth token，并按 Connection 做 refresh single-flight。第一阶段一次授权解析一个 `Channel`，但 `Channel.connectionId` 保持一对多扩展空间。`Channel` 保存 YouTube ID、展示信息、可复用 Stream ID 和独立操作锁；每个 Channel 只有一条未确认结束的 Run。

`ObsInstance` 唯一归属一个 Channel，保存标签、固定 `127.0.0.1`、WebSocket 端口与最后观测状态；其密码单独 AES-256-GCM 加密，所有公开 DTO 都不含密码。`LiveRun` 只保存 Broadcast/Stream ID、YouTube 生命周期、ingest、OBS 状态、错误与时间线；没有 PID、编码器、媒体快照、progress 或 stderr。

## Windows 多账号 OBS 模式

每个 Channel 使用一个独立 Portable OBS 目录、配置目录、Profile / Scene、WebSocket 端口与 YouTube Stream Key。以固定 OBS 版本运行：

```powershell
.\obs64.exe --portable --multi
```

先完成一台 Portable OBS A 的闭环，再复制为 B/C。每个实例都必须：仅监听 `127.0.0.1`、开启 WebSocket 认证、使用不重复端口，并只在本实例的服务设置中配置对应 Stream Key。LivePilot 不会动态改 Stream Key、场景、视频、音乐或循环策略。

Proxifier / Clash / TUN 是外部已验证环境，LivePilot 不修改。上线前在 Proxifier 连接日志中确认每个 Portable OBS 的实际 `obs64.exe` 路径都命中正确代理规则。

## 配置与启动

前置条件：Node.js 20.9+、已启用 YouTube Live 的 Google Channel，以及 OBS WebSocket 5.x。复制 `.env.example` 为 `.env.local`，填写 Google OAuth 和至少 32 字节的 `LIVEPILOT_APP_SECRET`；在 Google Cloud 的 Web OAuth Client 中把 `http://127.0.0.1:3000/api/auth/callback` 登记为精确回调地址。

```powershell
npm install
npm run dev
```

浏览器打开 <http://127.0.0.1:3000>，逐个添加 Google / YouTube 账号。选择 Channel 后一次性提交 Portable OBS 标签、端口和 WebSocket 密码；密码提交后不会再显示。运行服务与所有 API 只接受同源、CSRF 保护的本机 owner session。

## 生命周期与恢复

开始顺序固定为：取得 Channel lock → 确认 OBS 可达且 inactive → 创建 Run → 创建/绑定 Broadcast 与该 Channel 的 reusable Stream → OBS `StartStream` 并确认 active → 等待 YouTube ingest active → `testing`（如要求）→ `live` 并回读确认。

结束顺序固定为：取得 Channel lock → YouTube `complete` 并回读确认 → OBS `StopStream` 并确认 inactive → Run completed。若 YouTube complete 失败，LivePilot 绝不停止 OBS。若 OBS 断开或 StopStream 未确认，Run 进入 `stop_failed` / `recovery_required`，同 Channel 被阻止创建新 Run；在 OBS 中处理后点击“刷新 OBS 状态”，只有服务端确认 inactive 才可恢复。

服务重启不接管或终止 OBS。重新读取控制面和 OBS 状态后按上述恢复规则处理。旧本机 control-plane 若为早期格式，会备份为带 `ffmpeg-v1` 后缀的私有文件，保留 Connection、Channel、reusable Stream 并清空旧 Job/Run；如旧 Run 可能仍活动，迁移会拒绝执行，必须先确认本机不存在遗留输出。

## 验收

先手工验收 OBS A：LivePilot 创建/绑定 → OBS 开始推流 → YouTube ingest active → live → complete → OBS 停止。稳定后为 B/C 使用不同 OAuth Channel、目录、端口与 Stream Key，验证三条 Channel 可并行且互不阻塞。

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

协议依据：[OBS 多实例源码](https://github.com/obsproject/obs-studio/blob/master/frontend/obs-main.cpp)；[OBS WebSocket 5.x 协议](https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md?plain=1)。YouTube 生命周期沿用 `Broadcast → Stream bind → ingest active → testing → live → complete` 的回读确认原则。
