# 协议映射与状态机

本文是 `@local/dsh-a2a` 的实现契约：哪些方法被接受、参数如何归一化、Task 如何推进、错误如何表达。线上类型的唯一定义在 `src/shared/protocol.ts`。

> **实现状态（第 4 步）**：入站 Card/Bearer/JSON-RPC/状态机/DSH Agent/SSE 与出站发现/远程 RPC/Skill→Tool 注册/设置面板均已接入。`tasks/pushNotificationConfig/*` 明确返回 `-32003`。流式响应目前按 assistant/message 粒度发送 artifact，不做 token 级增量；出站 Skill 工具使用阻塞 send。

## 1. 版本与兼容

| 对端版本 | 发现 | 发送 | 流式 |
| --- | --- | --- | --- |
| A2A 0.3.x | `GET /.well-known/agent-card.json`（标准），兼容 `/.well-known/agent.json` | `message/send` | `message/stream` |
| A2A 0.2.x | `GET /.well-known/agent.json` | `tasks/send` | `tasks/sendSubscribe` |
| A2A 0.1.x | `GET /.well-known/agent.json` | `tasks/send` | `tasks/sendSubscribe` |

A2A 0.3.0 把 Agent Card 的 well-known 路径从 `agent.json` 改为 `agent-card.json`。本插件按需求以 `agent.json` 为主路径，同时把 `agent-card.json` 注册为同内容别名；两个路径都公开、都不走 Bearer 校验，响应体完全一致。出站发现时先请求 `agent-card.json`，404 再回退到 `agent.json`。

服务端同时接受两套方法名，内部归一化为同一个 `SendTaskInput`。出站客户端按对端 Agent Card 的 `protocolVersion` 选择方法名：

```ts
const modern = compareVersions(card.protocolVersion ?? '0.1.0', '0.3.0') >= 0
const sendMethod = modern ? 'message/send' : 'tasks/send'
const streamMethod = modern ? 'message/stream' : 'tasks/sendSubscribe'
```

无法解析的 `protocolVersion` 按 0.2 处理，并记录一次警告。不根据 HTTP 状态或错误消息猜测版本。

## 2. JSON-RPC 信封

请求：

```json
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "method": "message/send",
  "params": { "message": { "...": "..." } }
}
```

成功：

```json
{ "jsonrpc": "2.0", "id": "req-1", "result": { "kind": "task", "...": "..." } }
```

失败：

```json
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "error": { "code": -32602, "message": "message.parts must be a non-empty array", "data": { "field": "message.parts" } }
}
```

约束：

- `id` 必须是字符串、有限数字或 `null`；通知（无 `id`）不产生响应，但服务端仍会执行任务。
- 单次请求只处理一个信封；数组批处理返回 `-32600`（A2A 不使用批处理）。
- `params` 必须是对象；缺失或非对象返回 `-32602`。
- 响应 `Content-Type: application/json; charset=utf-8`；流式为 `text/event-stream`。

## 3. 方法表

| 方法 | 参数 | 结果 | 备注 |
| --- | --- | --- | --- |
| `message/send` | `MessageSendParams` | `Task \| Message` | 默认阻塞到终态 |
| `tasks/send` | `LegacyTaskSendParams` | `Task` | 把 `id` 归一化为 `taskId`、`sessionId` 归一化为 `contextId` |
| `message/stream` | `MessageSendParams` | SSE 事件流 | 首帧前先写 200 与 headers |
| `tasks/sendSubscribe` | `LegacyTaskSendParams` | SSE 事件流 | 同上 |
| `tasks/get` | `{ id, historyLength? }` | `Task` | 未知 id → `-32001` |
| `tasks/cancel` | `{ id }` | `Task` | 终态 → `-32002` |
| `tasks/resubscribe` | `{ id }` | SSE 事件流 | 重放当前状态，再转发后续事件 |
| `tasks/pushNotificationConfig/set` | `TaskPushNotificationConfig` | `TaskPushNotificationConfig` | 首版 → `-32003` |
| `tasks/pushNotificationConfig/get` | `{ id }` | `TaskPushNotificationConfig` | 首版 → `-32003` |
| `tasks/pushNotificationConfig/list` | `{ id }` | `TaskPushNotificationConfig[]` | 首版 → `-32003` |
| `tasks/pushNotificationConfig/delete` | `{ id }` | `null` | 首版 → `-32003` |

## 4. 参数归一化

### 4.1 消息

```json
{
  "kind": "message",
  "messageId": "m-1",
  "role": "user",
  "parts": [{ "kind": "text", "text": "Review this diff." }],
  "contextId": "ctx-7",
  "taskId": "task-3",
  "metadata": {}
}
```

- 0.3 的 `messageId` 必填；缺失返回 `-32602`。0.2 的 `tasks/send` 允许缺失，由服务端生成。
- `contextId` 缺失时生成新的 `ctx-<uuid>`；响应里回传。
- `taskId` 只允许指向同一 `contextId` 的 Task；跨上下文复用在 `-32602` 中拒绝。
- `parts` 允许 `text` / `data` / `file`；未知 `kind` 返回 `-32005`。
- 0.2 的 `parts[].type` 会被归一化为 `kind`。

### 4.2 旧版 `tasks/send`

```json
{
  "id": "task-3",
  "sessionId": "ctx-7",
  "message": { "role": "user", "parts": [{ "kind": "text", "text": "..." }] },
  "historyLength": 20
}
```

归一化规则：

| 旧字段 | 新字段 |
| --- | --- |
| `id` | `taskId`（同时作为返回 Task 的 `id`） |
| `sessionId` | `contextId` |
| `pushNotification` | `configuration.pushNotificationConfig` |
| `historyLength` | `configuration.historyLength` |

当旧请求只给 `id` 而不给 `sessionId` 时，`contextId` 取该 Task 已存在的值；任务不存在则生成新的上下文。

## 5. Task 状态机

```
                 ┌──────────── cancel / fail ────────────┐
                 ▼                                       │
submitted ──▶ working ──▶ input-required ──▶ working ──▶ completed
    │            │              │
    │            └──────────────┴──────────▶ canceled
    └───────────────────────────────────────▶ failed
```

合法迁移表（行 = 当前，列 = 目标）：

| from \ to | submitted | working | input-required | completed | canceled | failed |
| --- | --- | --- | --- | --- | --- | --- |
| submitted | — | ✅ | — | — | ✅ | ✅ |
| working | — | — | ✅ | ✅ | ✅ | ✅ |
| input-required | — | ✅ | — | ✅ | ✅ | ✅ |
| completed | — | — | — | — | — | — |
| canceled | — | — | — | — | — | — |
| failed | — | — | — | — | — | — |

- 终态不可复活；`tasks/cancel` 对终态返回 `-32002`。
- 重复的 `working` 状态更新是 no-op，不会重复推送。
- `input-required → completed` 允许：客户端可能直接给出最终答复而不继续工作。
- 状态更新带 `timestamp`（RFC 3339，UTC）和可选 `message`。

### 5.1 `input-required` 的产生与解除

1. DSH Agent 调用 `ask_user_question`。
2. `interaction-bridge.ts` 在 Agent 作用域注册 `user-questions/request` 监听器，拿到问题列表并**暂不 resolve**。
3. Task 进入 `input-required`，`status.message` 是一个 `role: "agent"` 的 Message，`parts` 为问题文本 + 选项（`data` 部件带结构）。
4. 客户端用同一个 `taskId` 发送 `message/send`；桥接器把答复映射为 `AskUserQuestionAnswer` 并 resolve 原问题。
5. Task 回到 `working`，Agent 继续 turn；最终 `completed`。

如果客户端发送的是普通文本而非结构化答复，桥接器按顺序匹配选项标签；匹配不到则作为 `custom` 自由文本。

审批（`approval/request`）不走 `input-required`：A2A 任务没有可交互的审批人，首版直接拒绝并让 Agent 收到拒绝结果，避免永久挂起。

## 6. 流式帧

`message/stream` 的响应：

```
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no

data: {"jsonrpc":"2.0","id":"req-1","result":{"kind":"status-update","taskId":"t1","contextId":"c1","status":{"state":"working","timestamp":"2026-01-01T00:00:00.000Z"},"final":false}}

data: {"jsonrpc":"2.0","id":"req-1","result":{"kind":"artifact-update","taskId":"t1","contextId":"c1","artifact":{"artifactId":"t1-output","name":"result","parts":[{"kind":"text","text":"final answer"}]},"lastChunk":true}}

data: {"jsonrpc":"2.0","id":"req-1","result":{"kind":"status-update","taskId":"t1","contextId":"c1","status":{"state":"completed","timestamp":"2026-01-01T00:00:01.000Z"},"final":true}}
```

规则：

- 每帧一个 `data:` 行，JSON 单行（不换行）；帧之间空行。
- `id` 与请求一致；同一 Task 的多个订阅者各自收到独立副本。
- 每 15 秒写一行 `: heartbeat` 注释，防止代理超时。
- 客户端断开**不取消任务**；重新连接用 `tasks/resubscribe`。
- 终态帧 `final: true` 后服务端结束响应。
- `input-required` 是 `final: false`：流保持打开；客户端可以用同一 `taskId` 或同一 `contextId` 发送下一条 `message/send`，任务完成后原流会收到 artifact 与终态帧。
- 当前版本在 turn 结束时发送一个完整 artifact（`lastChunk: true`），不发送 token 级增量。状态事件仍是即时的。
- 每个 Task 保留一个有界事件缓冲（256 帧）供 `tasks/resubscribe` 重放；订阅者只收到当前状态与最终 artifact，不重放历史 token 流。

## 7. 错误码

| code | 含义 | 何时返回 |
| --- | --- | --- |
| -32700 | Parse error | 请求体不是合法 JSON |
| -32600 | Invalid Request | 信封不合法、批处理、非法状态迁移 |
| -32601 | Method not found | 未知方法 |
| -32602 | Invalid params | 参数校验失败 |
| -32603 | Internal error | 未预期异常（不含堆栈） |
| -32001 | Task not found | `tasks/get` / `cancel` / `resubscribe` 未知 id |
| -32002 | Task not cancelable | 终态任务取消 |
| -32003 | Push notification not supported | 推送配置方法 |
| -32004 | Unsupported operation | 能力未声明或版本不支持 |
| -32005 | Content type not supported | 不支持的 Part / MIME |
| -32006 | Invalid agent response | 出站对端返回无法解析的 Task/Message |
| -32007 | Authenticated extended card not configured | 请求扩展卡片但未配置 |

`error.data` 只放字段路径、状态名、任务 id 等可诊断信息；不回传令牌、请求头或消息正文。

## 8. 认证

- `auth.mode: none`：不校验；仅建议回环开发。
- `auth.mode: bearer`：校验 `Authorization: Bearer <token>`。
  - 令牌来源优先级：凭据存储 `dsh-a2a/inbound` → `tokenEnv` 环境变量。
  - 比较前先做 SHA-256，再 `timingSafeEqual`，避免长度泄露。
  - 缺失/错误令牌返回 HTTP 401 + `WWW-Authenticate: Bearer`，不返回 JSON-RPC 错误（JSON-RPC 层之前拒绝）。
  - 未配置任何令牌时：Agent Card 仍可读，RPC 返回 503，管理 API 提示“未配置令牌”。
- Agent Card 的 `securitySchemes` 只在 `bearer` 模式出现。

## 9. 与 DSH Session 的映射

```
contextId (A2A) ──sha256──▶ sessionId = "a2a-" + hex.slice(0, 32) ──▶ ctx.agents.get/resume/create
```

- 同一个 `contextId` 始终映射同一个 Session，进程重启后可通过 `agents.resume` 恢复。
- 一个 Session 同时只承载一个进行中的 Task；新 Task 进入时若旧 Task 仍是 `working`，返回 `-32600`（客户端应先取消或等待）。
- A2A 的 `taskId` 与 DSH 的 `turn` 不是一一对应：一个 Task 可以跨越多个 turn（`input-required` 就是这种情况）。
- Agent 使用与普通 DSH Agent 相同的工具集；`ask_user_question` 由作用域 `user-questions/request` 桥接接管，审批类问题按 reject 选项回答，避免无人应答时挂起。

## 10. 出站（Client）契约

- 发现：`GET <base>/.well-known/agent-card.json`，404 时回退 `<base>/.well-known/agent.json`；5 秒超时，最多 2 次重定向；只接受 `application/json`。
- 发送：`POST <base>/a2a`，`Content-Type: application/json`，`Accept: application/json`（非流式）或 `text/event-stream`（流式）。
- 鉴权：每个节点独立 Bearer；令牌从凭据记录读取，不进入 Agent Card 缓存。
- 超时：连接 10 秒，整体 `requestTimeoutMs`；取消工具调用时通过 `AbortSignal` 中断 fetch。
- 结果映射：
  - `Task.status.state === completed` → 拼接 `artifacts[].parts` 文本；无 artifact 时用 `status.message`。
  - `input-required` → 工具结果带 `state` 与问题文本，模型可继续调用同一工具并传 `taskId`。
  - `failed` / `canceled` → 工具结果 `ok: false`，`text`/`error` 携带状态消息；传输或 JSON-RPC 错误才抛出。
- 工具命名：`<prefix>__<nodeSlug>__<skillSlug>`，只保留 `[a-z0-9_]`，冲突时追加短哈希；每个工具在节点/技能变化时先释放再注册。
