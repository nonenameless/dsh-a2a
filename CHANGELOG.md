# Changelog

## 1.1.1 — 2026-11-12

- 发布到 npm：包名改为 `@jasper_alaric/dsh-a2a`，移除 `private`，`publishConfig.access` 设为 `public`。
- 补齐 `repository` / `homepage` / `bugs` 元数据，指向 GitHub 仓库。
- 新增 `docs/images/` 面板截图，README 增加「界面」小节。
- 面板：只有 peer 令牌时，鉴权行显示「N 个 peer 令牌」而不是「未配置令牌」。

## 1.1.0 — 2026-11-11

### Inbound per-peer tokens

- `server.auth.peers`：每个 peer 一枚独立 Bearer（凭据 `dsh-a2a/peer-<id>`），命中后按 peer 归属写入活动日志与任务记录；旧单令牌仅作显式配置的回退（`server.auth.tokenEnv`，留空即关闭）。
- 管理 API：`POST /a2a/admin/peer-token`；`GET /a2a/admin/state` 的 `server.peers` 报告每枚令牌是否已配置。
- 设置面板新增“入站 peer 令牌”区（只写、不回显）。

### A2A 1.0 (protoJSON) compatibility

- 入站接受 `SendMessage` / `SendStreamingMessage` / `GetTask` / `CancelTask` / `SubscribeToTask` 与 0.3 方法名并存。
- 入站接受 `role: "ROLE_USER" | "ROLE_AGENT"`，以及不带 `kind` 的 parts（按 `text`/`data`/`file` 推断）。
- 入站接受 `configuration.returnImmediately`；仍以单次阻塞响应返回终态，`GetTask` 轮询路径同时可用。
- 出站：对端返回 `-32601` 时自动改用 `SendMessage` 重试一次；能解析裸 task 与 `{task}` 包裹两种 1.0 响应，以及 `TASK_STATE_*` 状态枚举。

### Fixed

- **凭据键格式**：节点令牌键由 `dsh-a2a/node/<id>` 改为 `dsh-a2a/node-<id>`。旧键包含两个斜杠，DSH 在**下次启动**加载凭据时会抛 `credential key … must be "<scope>/<id>"`，导致 profile 起不来。
- 节点 id 收紧为 `[a-z][a-z0-9-]{0,47}`，与凭据 id 段一致。

### Hardened

- Agent Card 与 JSON-RPC 响应改为**边接收边限流**（1 MiB / 8 MiB），不再先读完整响应再检查。
- 阻塞调用收到 `text/event-stream` 响应时立即报错，避免无限缓冲把进程拖死。
- 任务超时回调里的 `executor.cancel()` 失败不再逃逸（定时器中的未捕获异常会杀掉 Host 进程）。
- 空闲 Agent 回收（闲置 10 分钟或超过 32 个上下文）与已完成任务回收（500 条上限），缓解长时间连接的内存增长。

### Verification

- 109 个用例通过；与 OpenClaw（1.0 protoJSON）和 Hermes（1.0，裸 task 响应）实测双向互通。

## 1.0.0 — 2026-11-10

首个可用版本。双向 A2A 通信、任务生命周期、设置面板与安全控制。

### Inbound (A2A Server)

- `GET /.well-known/agent.json` 与 A2A 0.3 别名 `/.well-known/agent-card.json`；
- JSON-RPC 2.0 `message/send`、`message/stream`，兼容 0.2 `tasks/send` / `tasks/sendSubscribe`；
- `tasks/get`、`tasks/cancel`、`tasks/resubscribe`；
- `submitted` / `working` / `input-required` / `completed` / `canceled` / `failed` 状态机；
- 基于 `contextId` 的确定性 DSH Session 映射与多轮；
- `ask_user_question` → `input-required` → 下一条消息答复；
- SSE 状态/Artifact 帧、15 秒心跳、断线续订；
- 每任务超时与 Agent 取消。

### Outbound (A2A Client)

- Agent Card 发现（0.3 路径优先，旧路径回退）；
- 每节点 Bearer 令牌（凭据记录或环境变量）；
- 0.3/0.2 方法自动选择；
- Skill → DSH Tool 动态注册、Card 变化重建、节点删除释放；
- 阻塞式远端任务投影，`input-required` 可继续；
- SSRF 策略、私网开关、重定向拒绝。

### UI

- `settings.section` 面板：服务状态、Card 链接、节点表格/表单、只写令牌、活动流；
- 3 秒轮询管理快照；
- 主题 token、中文/英文文案、浅色/深色兼容。

### Security

- 入站 Bearer 常量时间比较；
- 管理 API 同源鉴权；
- 请求体上限、超时、错误脱敏；
- A2A Agent 审批统一拒绝；
- 不记录消息正文/令牌。

### Verification

- 94 个测试（单元、集成、真实 HTTP E2E 回环）；
- 已在 Web profile 安装并验证 Agent Card / health / 401 / slot 挂载；
- 面板像素渲染与真实模型任务仍需人工验证。
