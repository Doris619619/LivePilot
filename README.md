# LivePilot

LivePilot 是一个浏览器可访问的单账号 YouTube Live 控制台。它采用 Next.js + TypeScript：浏览器负责选择直播和发起操作，Google OAuth、Refresh Token、Client Secret、YouTube API 调用与状态机全部运行在服务端。

本轮没有 Electron、preload、IPC、NSIS，也没有 RTMP Relay。OBS 直接使用 YouTube Studio 中目标 Stream 的 RTMPS 地址和 Stream Key 推流；LivePilot 不会把 Stream Key 返回浏览器。

## 单账号 MVP

- 连接或断开一个 Google / YouTube 账号
- 显示当前频道名称与 Channel ID
- 查询未结束的 Broadcast，或创建默认 `unlisted` 的测试 Broadcast
- 确定性复用已有 Stream；没有合适 Stream 时创建一个可复用 RTMP Stream
- 绑定 Broadcast 与 Stream，并重新读取确认 `boundStreamId`
- 每 2 秒显示 ingest、health 与 Broadcast lifecycle 状态
- 只在 `streamStatus == active` 后允许 Start Live
- 按 `enableMonitorStream` 决定是否先 transition 到 `testing`
- 重试 transition，并重新查询确认真正进入 `live` / `complete`
- 对 OAuth、token、频道、直播权限、bind、ingest、transition、quota 与网络错误给出可行动提示

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

OBS ──────────────────────────────► YouTube ingest
     direct RTMPS with Studio key
~~~

- 开发和生产启动脚本都只监听 `127.0.0.1`。当前版本不是可直接暴露到公网或局域网的多用户服务。
- 所有修改型 API 都要求同源、JSON、受会话约束的 CSRF token；连接后的控制 API 还要求本地 owner session。
- OAuth 使用服务端一次性 `state`、PKCE 和与浏览器 flow 绑定的 transaction；callback transaction 在换 token 前原子消费，不能重放。
- Access Token、Refresh Token、OAuth transaction 和安全状态使用 AES-256-GCM 加密后原子写入 `.data`；应用密钥来自 server-only 环境变量。
- Token 提前 5 分钟刷新，并使用 single-flight 与授权 epoch 防止并发 refresh 或断开后的旧请求把 token 写回。
- Client Secret、Token 和 Stream Key 不进入 React props、API DTO、DOM、日志或 Git。页面只显示 Stream ID、名称和非敏感状态。
- Start 会再次读取 ingest 状态，防止用户依据过期 UI 点击；活动 Broadcast 和本地风险记录会阻止危险的切换、重授权或断开。

`.data` 只适合本机单实例 MVP。若未来部署到多实例或公网，必须先增加真实用户认证、共享数据库/密钥管理、分布式锁、HTTPS 与运维审计；不能直接复用当前本地 owner-session 边界。

## 前置条件

- Node.js 20.9 或更高版本
- npm
- OBS Studio
- 已创建 YouTube Channel 且已启用直播功能的 Google 账号
- Google Cloud 项目已启用 YouTube Data API v3

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

## OBS 与开播流程

1. 打开 LivePilot，点击“连接 Google / YouTube”，在 Google 页面完成授权。
2. 确认页面显示正确的 Channel。
3. 选择已有 Broadcast，或创建默认不公开的测试 Broadcast。
4. LivePilot 会选择或创建可复用 Stream，完成 bind，并显示 Stream ID 和状态。
5. 在 YouTube Studio 的直播控制室读取该 Stream 的 RTMPS 地址和 Stream Key，把它们配置到 OBS。LivePilot 不提供查看或复制密钥的接口。
6. OBS 开始推流，等待页面显示 ingest `active`。
7. 点击“开始直播”。服务端会重新确认 ingest，必要时先进入 `testing`，再 transition 到 `live` 并轮询确认。
8. 在一个没有频道管理权限的窗口打开公开观看页，确认画面真实可见。
9. 点击“结束直播”。服务端 transition 到 `complete` 并轮询确认。
10. 停止 OBS，并确认 YouTube 观看页已结束。

建议第一次始终使用 `unlisted` 测试 Broadcast。若控制台因 quota、网络或进程故障无法确认结束，应立即在 YouTube Studio 手工结束直播。

## 状态机

~~~text
选择/创建 Broadcast
  → 排除其他 active/testing Broadcast
  → 读取已绑定 Stream，或确定性复用/创建可复用 Stream
  → bind 并重新读取确认
  → OBS 直接推流到 YouTube
  → streamStatus == active
  → enableMonitorStream == true ? testing 并确认 : 跳过 testing
  → transition(live) 并确认 lifeCycleStatus == live
  → 用户点击结束
  → transition(complete) 并确认 lifeCycleStatus == complete
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

单元测试使用假的 Google/YouTube 网络边界，不包含真实账号、Token 或 Stream Key。真实 OAuth、OBS ingest、观看页与 YouTube lifecycle 必须由账号本人按上一节验收。

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
