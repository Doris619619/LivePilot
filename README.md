# LivePilot

LivePilot 是一个浏览器可访问的本机 YouTube Live 控制台，面向逐步集中管理多个频道。它采用 Next.js + TypeScript：浏览器只选择 Channel、Live Job 和受控媒体资源；OAuth、Refresh Token、FFmpeg、YouTube API 调用与状态机全部运行在服务端。

核心链路不依赖 OBS：`LivePilot → FFmpeg Worker → YouTube`。OBS 既不是安装前提也不是本轮集成目标；YouTube Stream Key 仅在服务端短暂用于 FFmpeg，绝不返回浏览器。

## 第一阶段能力

- 每个 OAuth Connection、Channel、Live Job 与 Live Run 均有独立记录；Job 不保存一次性 Broadcast、PID 或 runtime。
- 从管理员配置的媒体根目录选择循环视频和兼容 MP3 音乐列表；独立音乐默认忽略视频内嵌音轨。
- 为 Run 创建默认 `unlisted` Broadcast、复用或创建 Channel 所有的 Stream、绑定并确认。
- 在 Windows 上启动/停止受控 FFmpeg，采集 `-progress` 心跳、frame、fps、bitrate 与 speed。
- 仅在 FFmpeg 真实推进且 YouTube ingest `active` 后 transition 到 `live`；结束时先确认 `complete`，再停止 worker。

## 架构与安全边界

~~~text
Browser (UI + same-origin session)
                 │
                 ▼
Next.js route handlers (127.0.0.1 only)
                 │
        OAuth / token / lifecycle
                 │
                 ▼
Google OAuth + YouTube Live Streaming API

FFmpeg Worker ────────────────────► YouTube ingest
  server-held RTMPS key only
~~~

- 开发和生产启动脚本都只监听 `127.0.0.1`。当前版本不是可直接暴露到公网或局域网的多用户服务。
- 所有修改型 API 都要求同源、JSON、受会话约束的 CSRF token；连接后的控制 API 还要求本地 owner session。
- OAuth 使用服务端一次性 `state`、PKCE 和与浏览器 flow 绑定的 transaction；callback transaction 在换 token 前原子消费，不能重放。
- Access Token、Refresh Token 与 OAuth transaction 使用 AES-256-GCM 加密后按 Connection 原子写入 `.data`；应用密钥来自 server-only 环境变量。
- Token refresh 按 Connection single-flight；Channel operation lock 保证一个频道只能有一个 active Run，锁顺序固定为 Connection → Channel → Job。
- Client Secret、Token、Stream Key、ingest URL、FFmpeg 命令和原始 stderr 不进入 React props、API DTO、DOM、日志或 Git。
- Run 持久化 worker/ingest/lifecycle 和脱敏错误。服务重启后的陈旧 PID 标为 `recovery_required`，不会被不安全地复用或杀死。

`.data` 只适合本机单实例 MVP。若未来部署到多实例或公网，必须先增加真实用户认证、共享数据库/密钥管理、分布式锁、HTTPS 与运维审计；不能直接复用当前本地 owner-session 边界。

## 前置条件

- Node.js 20.9 或更高版本
- npm
- 已创建 YouTube Channel 且已启用直播功能的 Google 账号
- Google Cloud 项目已启用 YouTube Data API v3
- 一个或多个本地媒体根目录；第一阶段音乐列表仅支持采样率和声道一致的 MP3

YouTube 首次启用直播可能存在平台等待期。应用无法替代 Google 的账号审核或直播权限开通。

## Google Cloud 与本地配置

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 创建或选择项目。
2. 启用 **YouTube Data API v3**。
3. 配置 OAuth consent screen；应用处于 Testing 时，把实际账号加入 Test users。
4. 创建 **Web application** 类型的 OAuth Client。
5. 在 Authorized redirect URIs 中原样加入：

   ~~~text
   http://127.0.0.1:3000/api/auth/callback
   ~~~

6. 复制示例配置：

   ~~~powershell
   Copy-Item .env.example .env.local
   ~~~

7. 填写 `.env.local`：

   ~~~dotenv
   YOUTUBE_CLIENT_ID=你的-client-id.apps.googleusercontent.com
   YOUTUBE_CLIENT_SECRET=你的-client-secret
   LIVEPILOT_BASE_URL=http://127.0.0.1:3000
   YOUTUBE_REDIRECT_URI=http://127.0.0.1:3000/api/auth/callback
   LIVEPILOT_APP_SECRET=至少-32-个随机字节
   LIVEPILOT_DATA_DIR=.data
   LIVEPILOT_MEDIA_ROOTS=D:\LiveMedia;E:\Archive\LiveMedia
   # 可选：使用已审计的 ffmpeg.exe，而不是随依赖安装的版本
   # LIVEPILOT_FFMPEG_PATH=D:\Tools\ffmpeg\bin\ffmpeg.exe
   # 可选：仅让 FFmpeg 的 RTMPS 连接经由本机 HTTP CONNECT 代理（例如 Clash mixed-port）
   # LIVEPILOT_FFMPEG_HTTP_PROXY=http://127.0.0.1:7890
   ~~~

可用 PowerShell 生成本地应用密钥；只把输出写进 `.env.local`：

~~~powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
~~~

配置读取发生在服务端。修改 `.env.local` 后必须重启 LivePilot。

官方资料：

- [OAuth 2.0 for Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [YouTube Live Streaming API](https://developers.google.com/youtube/v3/live/docs)
- [Broadcast 与 Stream 实施指南](https://developers.google.com/youtube/v3/live/guides/implementation/broadcasts-and-streams)
- [Broadcast 生命周期](https://developers.google.com/youtube/v3/live/life-of-a-broadcast)

## 安装与启动

~~~powershell
npm install
npm run dev
~~~

然后打开 <http://127.0.0.1:3000>。

生产构建与本地运行：

~~~powershell
npm run build
npm run start
~~~

## FFmpeg 开播流程

1. 配置 `LIVEPILOT_MEDIA_ROOTS`，把视频和 MP3 放在允许目录下，重启服务。
2. 打开 LivePilot，逐个连接 Google / YouTube Channel。
3. 为 Channel 创建 Live Job，选择循环视频和一个或多个 MP3。
4. 点击“开始直播”。服务端创建 Live Run、准备/绑定 Broadcast 与 reusable Stream，然后启动 FFmpeg。
5. LivePilot 收到 FFmpeg 推进心跳后轮询 YouTube ingest；只有 `active` 才会 transition 到 `live` 并确认。
6. 在无频道管理权限的窗口确认真实观看页。
7. 点击“结束 Run”。服务端确认 `complete` 后才停止 FFmpeg。

建议第一次始终使用 `unlisted` 测试 Broadcast。若控制台因 quota、网络或进程故障无法确认结束，应立即在 YouTube Studio 手工结束直播。

## 状态机

~~~text
Job 快照创建 Run
  → Channel lock 排除其他 active Run
  → 选择/创建 Broadcast，复用/创建 Channel Stream 并 bind 确认
  → 启动 FFmpeg，收到结构化 progress heartbeat
  → streamStatus == active
  → enableMonitorStream == true ? testing 并确认 : 跳过 testing
  → transition(live) 并确认 lifeCycleStatus == live
  → 用户点击结束 Run
  → transition(complete) 并确认 lifeCycleStatus == complete
  → 停止同一 Run 的 FFmpeg worker
~~~

`liveStarting` 不等同于成功；只有 API 重新读取到精确的 `live` / `complete` 才向页面报告完成。

## 自动验证

~~~powershell
npm run typecheck
npm run lint
npm test
npm run build
~~~

或一次执行：

~~~powershell
npm run verify
~~~

单元测试使用假的 Google/YouTube 网络边界，不包含真实账号、Token 或 Stream Key。真实 OAuth、FFmpeg ingest、观看页与 YouTube lifecycle 必须由账号本人按上一节验收。

## 常见错误

| 错误 | 建议动作 |
|---|---|
| `CONFIG_MISSING` | 填写 `.env.local` 并重启服务端 |
| `NOT_CONNECTED` / `TOKEN_INVALID` | 重新连接同一个 YouTube Channel |
| `OAUTH_FAILED` | 核对 Web OAuth Client、Test user 与精确 callback URI |
| `NO_CHANNEL` | 确认授权账号已创建 YouTube Channel |
| `LIVE_STREAMING_NOT_ENABLED` | 在 Studio 启用直播并等待平台开通 |
| `LIVE_PERMISSION_BLOCKED` | 在 YouTube Studio 查看频道限制 |
| `NO_BROADCAST` | 选择或创建测试 Broadcast |
| `NO_STREAM` | 清理名称冲突的 reusable Streams 后重试 |
| `BIND_FAILED` | 检查 Broadcast/Stream 状态并重新选择 |
| `INGEST_NOT_ACTIVE` | 检查 OBS 是否正向 Studio 中对应 Stream 推流 |
| `TESTING_TRANSITION_FAILED` | 检查 monitor stream、ingest health 与 Broadcast 状态 |
| `LIVE_TRANSITION_FAILED` | 确认 ingest active 后重试；必要时去 Studio 操作 |
| `COMPLETE_TRANSITION_FAILED` | 立即在 Studio 手工结束并确认观看页停止 |
| `QUOTA_EXCEEDED` | 必要时去 Studio 手工结束；等待配额重置或申请额度 |
| `NETWORK_ERROR` | 检查服务端到 Google API 的网络和代理 |
| `BUSY` | 等待当前操作完成，不要并行操作同一账号 |

## 来源与迁移范围

YouTube OAuth/API、quota 处理和 Broadcast 生命周期设计基于对下列 MIT 项目的实际源码审计与 Web/server 重构：

- [pjmdesi/stream-manager](https://github.com/pjmdesi/stream-manager)
- 固定审计 commit：[bf47f634e4348f98c19beaa28274d0473db51e7d](https://github.com/pjmdesi/stream-manager/tree/bf47f634e4348f98c19beaa28274d0473db51e7d)
- 完整版权与许可文本：[LICENSES/stream-manager-MIT.txt](LICENSES/stream-manager-MIT.txt)
- 迁移说明：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

保留的业务行为包括 token 提前刷新/single-flight、quota gate、Broadcast/Stream/bind API、ingest gate、`testing → live → complete` 顺序、重试与状态确认。Electron、preload、IPC、electron-store、BrowserWindow、NSIS 和 RTMP Relay 均未迁入目标架构。

本轮不包含多账号、Start/Stop All、一路流分发多个频道、数据库、SaaS、Twitch、TikTok、Facebook 或自动排程。

## 项目文档

- [docs/工程协作规范.md](docs/工程协作规范.md)
- [docs/PR撰写规范.md](docs/PR撰写规范.md)

这两份文档按用户要求从 `D:\Repo\Threadline\docs` 原样复制，因此其中的 Threadline 名称和原相对链接也原样保留；它们没有被当作本次需求指令解释或改写。
