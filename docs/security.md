# 安全模型与部署指南

本文说明 `@local/dsh-a2a` 的信任边界、已实现的控制、仍然存在的风险，以及公开部署前的检查清单。

## 1. 资产与信任边界

| 资产 | 位置 | 风险 |
| --- | --- | --- |
| 入站 Bearer 令牌 | 凭据记录 `dsh-a2a/inbound` 或 `DSH_A2A_TOKEN` | 泄露即获得 `server.cwd` 内的 Agent 能力 |
| 节点 Bearer 令牌 | 凭据记录 `dsh-a2a/node/<id>` 或节点 `tokenEnv` | 泄露即可以该身份调用远端 Agent |
| DSH 工作区 / 工具 | 入站 Agent 的 `server.cwd` | 远程调用方可触发 shell、文件、网络工具 |
| Session 日志 | DSH 持久化 | 包含任务内容；不进入 A2A 日志缓冲 |
| 管理 API | 同源 GUI 会话 | 可改节点、写令牌、刷新卡片 |

边界：

1. **A2A 对端 → 本插件**：不可信输入，必须过 Bearer、body 上限、JSON-RPC 校验、Task 状态机。
2. **本插件 → 远端 Agent**：节点配置由本机用户提供；远端返回的 Card/Task 仍是不可信数据。
3. **浏览器 → 管理 API**：同源会话 + `authorizeIndex`；令牌永远不回传浏览器。
4. **模型 → 工具**：远端 Skill 工具是模型可调用的能力，必须视为与本地工具同等敏感。

## 2. 已实现的控制

### 入站鉴权

- `Authorization: Bearer <token>`，严格解析 scheme 与 token 长度；
- 比较前对两侧做 SHA-256，再 `timingSafeEqual`，不泄露长度/前缀；
- 令牌来源优先级：凭据记录 → `tokenEnv`；
- 未配置令牌：Agent Card 仍公开，RPC 返回 `503`，不静默放行；
- 认证失败返回 `401` + `WWW-Authenticate`，不返回令牌或内部栈。

### 出站鉴权

- 每个节点独立令牌，存在凭据记录 `dsh-a2a/node/<id>`；
- 节点 `auth.mode: none` 时不发送任何令牌；
- 远端错误只回传 code/message，不回传请求头；
- 令牌只进入 `Authorization` 头，不写入日志或工具结果。

### 请求面

- `server.maxBodyBytes` 硬上限，按实际接收字节检查，不信任 `Content-Length`；
- JSON-RPC 信封、方法、params、Message parts 全部校验；
- Task 状态机拒绝非法迁移；
- 每任务 `server.timeoutMs` 截止；超时取消 Agent；
- SSE 心跳与断线清理，客户端断开不取消任务（可 resubscribe）。

### SSRF 与远端地址

- 只允许 `http` / `https`；
- 拒绝 URL 内嵌用户名/密码；
- 始终拒绝云元数据地址（`169.254.169.254`、`metadata.google.internal`）；
- `client.allowPrivateHosts: false` 时拒绝 loopback/私网/`.local`/link-local；
- 发现请求 `redirect: 'manual'`，拒绝 3xx，避免重定向绕过地址检查；
- Card 的 `url` 也会重新做地址检查，不只检查节点 base URL。

**残留风险**：没有做 DNS pinning，DNS rebinding 仍可能把已解析的主机指向内网。高安全部署应使用固定 IP/代理，或把 `allowPrivateHosts` 设为 `false` 并在网络层限制出口。

### 管理面

- 所有 `/a2a/admin/*` 经过 `ctx.connection.authorizeIndex`；
- 不支持跨域管理调用（无 CORS 头）；
- 节点变更通过 config editor 持久化，不手写 profile 文件；
- 令牌通过 `ctx.credentials.modifyRecord` 写入，面板只看到“已配置”；
- 管理请求同样受 `maxBodyBytes` 限制。

### Agent 执行

- 每个 `contextId` 派生独立 Session，不劫持用户当前会话；
- `approval/request` 在 A2A Agent 作用域内统一返回 `rejected`，避免无人审批导致挂起；
- `ask_user_question` 通过 `user-questions/request` 转成 `input-required`，等待远端答复；
- 取消任务会调用 `agent.cancel()` 并拒绝未决问题。

### 日志

- `LogBus` 只保留方向、状态、任务/上下文 id、耗时、短原因；
- 不记录消息正文、Authorization、令牌、文件内容；
- 容量由 `logs.capacity` 限制，默认 500。

## 3. 能力边界（最重要）

**入站 Bearer 令牌等价于一个在 `server.cwd` 内运行的 DSH Agent。**

拿到令牌的远程 Agent 可以让模型调用该 profile 暴露的工具，包括 shell、文件读写、网络访问等。缓解措施：

1. 只把令牌发给受信任的 Agent；
2. 为 A2A 入站任务使用独立的 DSH profile 或受限的工具预设；
3. `server.cwd` 指向专用工作目录，不要指向包含生产凭据的目录；
4. 每个对端使用不同令牌，便于单独撤销；
5. 公网部署必须放在 TLS 反向代理后，并限制来源 IP。

## 4. 残留风险

| 风险 | 说明 | 建议 |
| --- | --- | --- |
| Prompt injection | 远端消息可能诱导 Agent 调用危险工具 | 受限 profile、工具白名单、专用 cwd |
| 令牌泄露 | 令牌出现在日志、截图、issue | 定期轮换，按节点/对端拆分 |
| DNS rebinding | `allowPrivateHosts` 只检查字面地址 | 网络层出口限制、固定 IP |
| 内存增长 | Task 记录和日志有界但进程内保留 | 定期重启、限制 `logs.capacity`、后续加 Task TTL |
| 无速率限制 | 持有令牌者可高频创建任务 | 反向代理限流、按令牌配额 |
| 远端不可信 Card | Card 的 skill 描述会进入模型上下文 | 只添加可信节点；面板显示来源 |
| 审批一律拒绝 | 需要人工审批的工具无法在 A2A 任务中使用 | 把这类能力放到本地会话 |
| 无出站 TLS 固定 | 依赖系统 CA 与 DNS | 使用受控 CA/代理 |

## 5. 部署检查清单

- [ ] 使用 HTTPS 反向代理，`server.publicUrl` 填外部地址；
- [ ] 设置强随机入站令牌（面板或 `DSH_A2A_TOKEN`），不要用默认值；
- [ ] 每个远端节点独立令牌；
- [ ] `client.allowPrivateHosts` 按需设置；公网场景设为 `false`；
- [ ] `server.cwd` 指向专用工作目录；
- [ ] 限制 `/a2a/admin/*` 只对可信网络开放；
- [ ] 监控 `401`、`413`、`503` 与任务失败日志；
- [ ] 定期轮换令牌，删除不再使用的节点；
- [ ] 升级 DSH 后重新运行 `npm run typecheck && npm test`。

## 6. 事件响应

令牌疑似泄露：

1. 在 Settings 清除入站令牌，或删除对应节点令牌；
2. 取消正在运行的任务（`tasks/cancel` 或重启插件）；
3. 检查 Session 日志与活动面板，确认是否有异常工具调用；
4. 轮换所有共享同一令牌的节点；
5. 如涉及主机凭据，按 DSH 的安全流程处理。

移除插件：

```text
plugin_manager remove_bundle target=@local/dsh-a2a
```

移除后 `/.well-known/agent.json`、`/a2a/*` 与管理面板入口都会消失；已写入的凭据记录可能需要手动清理。
