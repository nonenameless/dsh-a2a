# A2A curl 验收手册

以下命令针对已经安装并启用 `@local/dsh-a2a` 的 Web profile。默认假设：

```bash
export DSH_BASE=http://127.0.0.1:3080
export DSH_A2A_TOKEN='replace-with-your-token'
```

入站令牌可以在 **Settings → A2A 网络 → 入站令牌** 设置，也可以让 profile 读取 `DSH_A2A_TOKEN`。没有令牌时，Agent Card 仍然可读，但 JSON-RPC 返回 `503`。

---

## 1. 发现 Agent Card

```bash
# 需求中的主路径
curl -s "$DSH_BASE/.well-known/agent.json" | python -m json.tool

# A2A 0.3 标准路径，返回同一份文档
curl -s "$DSH_BASE/.well-known/agent-card.json" | python -m json.tool

# 健康探针（公开）
curl -s "$DSH_BASE/a2a/health" | python -m json.tool
```

预期：卡片包含 `protocolVersion: "0.3.0"`、`url` 指向 `/a2a`、`capabilities.streaming: true`、`securitySchemes.bearer`。

---

## 2. 鉴权失败路径

```bash
# 不带令牌 -> 401 + WWW-Authenticate
curl -i -X POST "$DSH_BASE/a2a" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"tasks/get","params":{"id":"missing"}}'

# 错误令牌 -> 401
curl -i -X POST "$DSH_BASE/a2a" \
  -H 'authorization: Bearer wrong-token' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"tasks/get","params":{"id":"missing"}}'
```

未配置任何令牌时返回 `503`，响应体提示去 Settings 或设置 `DSH_A2A_TOKEN`。

---

## 3. 创建任务（A2A 0.3）

```bash
curl -s -X POST "$DSH_BASE/a2a" \
  -H "authorization: Bearer $DSH_A2A_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": "send-1",
    "method": "message/send",
    "params": {
      "message": {
        "kind": "message",
        "messageId": "msg-1",
        "role": "user",
        "parts": [
          { "kind": "text", "text": "List the top-level directories and summarize the repo." }
        ]
      }
    }
  }' | tee /tmp/a2a-send.json | python -m json.tool
```

响应是一个 `Task`。用返回的 `id` 作为 `TASK_ID`：

```bash
export TASK_ID=$(python -c 'import json,sys; print(json.load(open("/tmp/a2a-send.json"))["result"]["id"])')
```

任务状态：

- `completed`：`artifacts[0].parts` 是最终文本；
- `input-required`：`status.message` 是问题，`id` 用于继续；
- `failed` / `canceled`：`status.message` 是原因。

---

## 4. 查询 / 取消 / 续订

```bash
# 查询（historyLength 可选）
curl -s -X POST "$DSH_BASE/a2a" \
  -H "authorization: Bearer $DSH_A2A_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":\"get-1\",\"method\":\"tasks/get\",\"params\":{\"id\":\"$TASK_ID\",\"historyLength\":20}}" | python -m json.tool

# 取消
curl -s -X POST "$DSH_BASE/a2a" \
  -H "authorization: Bearer $DSH_A2A_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":\"cancel-1\",\"method\":\"tasks/cancel\",\"params\":{\"id\":\"$TASK_ID\"}}" | python -m json.tool

# 重新订阅 SSE（终态任务会立即重放终态并关闭）
curl -N -X POST "$DSH_BASE/a2a" \
  -H "authorization: Bearer $DSH_A2A_TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":\"resub-1\",\"method\":\"tasks/resubscribe\",\"params\":{\"id\":\"$TASK_ID\"}}"
```

---

## 5. 流式任务（SSE）

```bash
curl -N -X POST "$DSH_BASE/a2a" \
  -H "authorization: Bearer $DSH_A2A_TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -d '{
    "jsonrpc": "2.0",
    "id": "stream-1",
    "method": "message/stream",
    "params": {
      "message": {
        "kind": "message",
        "messageId": "msg-stream-1",
        "role": "user",
        "parts": [{ "kind": "text", "text": "Summarize this repository in three bullets." }]
      }
    }
  }'
```

每个 `data:` 是一个 JSON-RPC response。典型顺序：

1. `status-update` `working`，`final:false`；
2. `artifact-update` 完整结果，`lastChunk:true`；
3. `status-update` `completed`，`final:true`。

`input-required` 的 `final` 是 `false`，流保持打开；用同一 `taskId` 或 `contextId` 发送下一条 `message/send`，原流会收到后续 Artifact 与终态。

---

## 6. 多轮 input-required

第一次响应：

```json
{
  "result": {
    "id": "task-123",
    "contextId": "ctx-9",
    "status": {
      "state": "input-required",
      "message": {
        "parts": [
          { "kind": "text", "text": "Which directory should I inspect?" },
          { "kind": "data", "data": { "questions": [{ "id": "q1", "question": "Which directory?" }] } }
        ]
      }
    }
  }
}
```

继续（推荐带 `taskId`，也可以只带 `contextId`）：

```bash
curl -s -X POST "$DSH_BASE/a2a" \
  -H "authorization: Bearer $DSH_A2A_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": "continue-1",
    "method": "message/send",
    "params": {
      "message": {
        "kind": "message",
        "messageId": "msg-2",
        "role": "user",
        "taskId": "task-123",
        "contextId": "ctx-9",
        "parts": [{ "kind": "text", "text": "packages/host" }]
      }
    }
  }'
```

也可以用结构化答案：

```json
{ "kind": "data", "data": { "answers": [{ "id": "q1", "selected": [], "custom": "packages/host" }] } }
```

---

## 7. A2A 0.2 兼容

```bash
curl -s -X POST "$DSH_BASE/a2a" \
  -H "authorization: Bearer $DSH_A2A_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": "legacy-1",
    "method": "tasks/send",
    "params": {
      "id": "legacy-task-1",
      "sessionId": "legacy-ctx-1",
      "message": {
        "role": "user",
        "messageId": "legacy-msg-1",
        "parts": [{ "kind": "text", "text": "Say hello." }]
      }
    }
  }' | python -m json.tool
```

流式别名是 `tasks/sendSubscribe`，参数相同。

---

## 8. 推送配置（明确不支持）

```bash
curl -s -X POST "$DSH_BASE/a2a" \
  -H "authorization: Bearer $DSH_A2A_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"push-1","method":"tasks/pushNotificationConfig/list","params":{"id":"x"}}'
```

预期 `error.code = -32003`。

---

## 9. 出站节点与 Skill 工具

出站节点通过 **Settings → A2A 网络** 添加：

1. 填写 `ID`、名称、`Base URL`（不含 `/a2a`）；
2. 选择 Bearer 或 None；
3. 填写节点令牌（只写）；
4. 勾选“启动时自动发现”，保存；
5. 点击“刷新卡片”确认 `Skills` 数与工具名出现。

工具名形如：

```text
a2a__research__web_search
```

之后在 DSH 对话中直接让模型调用该工具即可。工具参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `input` | string | 任务文本 |
| `taskId` | string? | 继续 input-required |
| `contextId` | string? | 复用远端上下文 |

手动验证技能注册可以查看 Host 日志或面板的“已注册工具”一列；没有配置节点时不会注册任何 A2A 工具。

---

## 10. 常见错误

| HTTP / code | 含义 | 处理 |
| --- | --- | --- |
| `503` + `-32603` | 未配置入站令牌 | Settings 设置令牌或 `DSH_A2A_TOKEN` |
| `401` | 令牌缺失/错误 | 检查 `Authorization: Bearer` |
| `415` | Content-Type 不是 JSON | 使用 `application/json` |
| `413` | body 超过 `server.maxBodyBytes` | 缩小消息或提高上限 |
| `-32602` | 参数非法 | 检查 `message.parts`、`id`、`historyLength` |
| `-32001` | Task 不存在 | 进程重启后 Task 内存记录会丢失 |
| `-32002` | Task 已终态，不能取消 | 用 `tasks/get` 确认状态 |
| `-32003` | 不支持 push | 用 SSE / `tasks/resubscribe` |
| `-32601` | 未知方法 | 检查方法名与协议版本 |

## 11. 一键脚本

```bash
#!/usr/bin/env bash
set -euo pipefail
BASE="${DSH_BASE:-http://127.0.0.1:3080}"
TOKEN="${DSH_A2A_TOKEN:?set DSH_A2A_TOKEN}"

curl -fsS "$BASE/a2a/health" >/dev/null
curl -fsS "$BASE/.well-known/agent.json" >/dev/null
curl -fsS -X POST "$BASE/a2a" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"smoke","method":"tasks/get","params":{"id":"does-not-exist"}}' \
  | grep -q 'Task not found'
echo "A2A smoke OK"
```
