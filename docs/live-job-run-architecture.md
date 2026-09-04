<!-- 文件用途：说明 LivePilot 第一阶段的 Connection、Channel、Live Job、Live Run、FFmpeg 与 YouTube 生命周期边界。 -->

# LivePilot Channel → Job → Run 架构

## 职责边界

- **OAuth Connection** 保存一个 Google 授权的加密 token，并在第一阶段映射一个已解析 Channel；此限制不构成长期的一对一接口约束。
- **Channel** 保存 YouTube Channel 身份、Connection 引用和 reusable Stream ID。Stream Key 从不落盘。
- **Live Job** 是可复用的内容预设：视频资产、MP3 音乐列表和循环策略。它没有 Broadcast ID、PID 或运行状态。
- **Live Run** 是一次执行记录：冻结的 Job 快照、Broadcast/Stream ID、worker telemetry、YouTube ingest/lifecycle、错误和终态。

## 并发与恢复

锁顺序固定为 `Connection → Channel → Job`。Start/Stop 只取得 Connection 与 Channel 锁，并在 Channel 锁内原子检查是否已有 active Run；不会等待 Job 锁。Job 配置更新只在需要检查 active Run 时才依序取得 Channel 和 Job 锁。

FFmpeg 使用 `-progress pipe:3`。只有输出时间单调前进才算 `pushing`；存活但没有心跳会成为 `unresponsive`。服务进程重启后没有可安全验证的 ChildProcess 句柄，因此持久化 Run 标记为 `recovery_required`，不对历史 PID 执行 kill。

## 失败顺序

1. worker 启动或 progress 失败：不执行 YouTube transition。
2. ingest 超时：停止 worker，Run 保留失败详情。
3. live transition 结果不确定：保留 worker 与 Run，先读取 YouTube 再人工结束，避免误断可能已 live 的流。
4. Stop：必须先确认 YouTube `complete`，之后才停止同一内存 worker；前一步失败时 Run 为 `stop_failed` 且 worker 保持运行。

## 媒体安全

`LIVEPILOT_MEDIA_ROOTS` 由管理员在服务端配置。浏览器只提交媒体 ID；服务端在创建 Job 和启动 Run 时重新扫描、realpath 校验根目录包含关系。第一阶段 playlist 仅接受由服务端 FFmpeg 预检且采样率/声道一致的 MP3。

## Windows RTMPS 出站

Worker 可以使用受信任的 `LIVEPILOT_FFMPEG_HTTP_PROXY` 指向 loopback HTTP CONNECT 代理。若 Windows 环境已验证 SOCKS5（例如 Clash mixed-port），优先配置 `LIVEPILOT_FFMPEG_SOCKS5_PROXY`：每条 Run 在 `127.0.0.1` 的随机端口创建临时 HTTP CONNECT → SOCKS5 bridge，FFmpeg 只连接该短生命周期 listener，bridge 随 worker 退出关闭。

代理地址必须是无凭据的 loopback 地址；浏览器不能配置代理或获取 Stream Key。该 bridge 不替代或修改 Proxifier、Clash、TUN、系统代理及其规则。
