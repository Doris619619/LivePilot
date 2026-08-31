# Third-party notices

## pjmdesi/stream-manager

LivePilot 的 Google OAuth / YouTube Live API 和 Broadcast 生命周期实现，基于对 `pjmdesi/stream-manager` 下列固定版本的源码审计、迁移与重构：

~~~text
Repository: https://github.com/pjmdesi/stream-manager
Commit: bf47f634e4348f98c19beaa28274d0473db51e7d
Tag/version at audit time: v2.4.0 / 2.4.0
License: MIT
Copyright (c) 2026 pjmdesi
~~~

完整 MIT 许可文本保存在：

~~~text
LICENSES/stream-manager-MIT.txt
~~~

迁移后保留的业务行为包括：

- Google OAuth offline access、authorization-code exchange 和 token refresh
- Access Token 到期前刷新与 single-flight 并发控制
- YouTube API 错误原因与 quota exceeded 处理
- Channel、Broadcast 和 Live Stream 查询/创建
- Broadcast ↔ Stream bind 与重新读取确认
- ingest `streamStatus == active` 安全门
- 根据 `enableMonitorStream` 决定 testing 分支
- testing/live/complete transition 重试与真实 lifecycle 确认

LivePilot 将上述行为重构为 Next.js server-only 模块和 Web route handlers，并补充了 state + PKCE、一次性 callback transaction、加密 token 持久化、同源/CSRF/owner session 校验、跨进程操作锁、持久化直播风险状态以及浏览器 DTO 脱敏。

下列 upstream 架构没有迁入 LivePilot：Electron、BrowserWindow、preload、IPC、electron-store、NSIS、ffmpeg 和 RTMP Relay。LivePilot 浏览器前端不会接收 Google Client Secret、OAuth Token 或 YouTube Stream Key。
