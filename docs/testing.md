# 测试矩阵与验收

本文件说明如何在不依赖真实模型的情况下验证协议、状态机、SSE、工具注册和双向链路，以及如何补做真实模型测试。

## 1. 快速验收

```bash
cd plugins/dsh-a2a
npm install
npm run typecheck   # src + tests
npm run test        # 14 files / 94 tests
npm run build       # lib/host/index.js + lib/client.js + lib/types
```

当前测试分布：

| 文件 | 覆盖 |
| --- | --- |
| `tests/unit/config.spec.ts` | 默认值、路径/URL/技能/节点校验、CORS 归一化 |
| `tests/unit/auth.spec.ts` | Bearer 解析、SHA-256 + timingSafeEqual、凭据/环境优先级 |
| `tests/unit/agent-card.spec.ts` | 本地卡片、远程卡片解析、私网策略 |
| `tests/unit/jsonrpc.spec.ts` | 信封校验、方法分发、错误映射、无堆栈泄露 |
| `tests/unit/task-manager.spec.ts` | 状态机、阻塞等待、取消、终态、订阅重放 |
| `tests/unit/interaction.spec.ts` | 文本/结构化问题答复、审批 reject 回退 |
| `tests/unit/sse-parser.spec.ts` | 多行 data、CRLF、event/id/retry、跨 chunk |
| `tests/unit/admin-service.spec.ts` | 节点持久化、令牌写入/清除、非法节点拒绝 |
| `tests/integration/rpc-route.spec.ts` | 真实 `node:http`：401/415/413/400/200、SSE、CORS |
| `tests/integration/activation.spec.ts` | Cordis 激活、`ctx.a2a`、全部路由注册 |
| `tests/integration/agent-executor.spec.ts` | 假 Agent：创建 Session、turn/end、input-required |
| `tests/integration/rpc-client.spec.ts` | 0.3/0.2 出站、Bearer、input-required、远端错误 |
| `tests/integration/tool-registrar.spec.ts` | Skill→Tool 注册、调用、释放、Card 变化 |
| `tests/e2e/bidirectional.spec.ts` | 真实 HTTP 回环：A2AClient → Server → 假 Agent → Task |

## 2. E2E 回环做了什么

`tests/e2e/bidirectional.spec.ts` 不启动第二个插件实例，而是：

1. 用真实 `Context` + 假 `agents` 服务承载 `A2AService`；
2. 用 `createRpcHandler` 挂到真实 `node:http`；
3. 用 `A2AClient` 作为出站调用方；
4. 假 Agent 在 `followup()` 后产生 `assistant/message` 与 `turn/end`；
5. 断言 0.3 `message/send`、0.2 `tasks/send`、SSE `message/stream` 三条路径。

这覆盖了网络、鉴权、JSON-RPC、任务状态机、SSE 和出站投影，只替换了模型调用本身。

## 3. 真实模型测试（需要 API key）

真实模型测试不放进默认 suite，避免 CI 无 key 失败。

前置：

```bash
export DEEPSEEK_API_KEY=sk-...
```

在 profile 中确认：

- `server.auth.mode` 为 `bearer` 并已设置 `DSH_A2A_TOKEN`，或临时设为 `none`；
- `server.model` 配置了可用 provider/model，或 profile 有 `agentDefaultModel`；
- `server.cwd` 指向测试工作目录。

然后：

```bash
export DSH_BASE=http://127.0.0.1:3080
export DSH_A2A_TOKEN=...
bash examples/curl.md 中的“创建任务”命令
```

验收点：

- 返回 `status.state: "completed"`；
- `artifacts[0].parts[0].text` 是合理回答；
- `tasks/get` 能读到相同历史；
- `message/stream` 依次收到 `working`、`artifact-update`、`completed`；
- 取消一个长任务后状态为 `canceled`。

## 4. 安装与面板验收

```text
plugin_manager install_bundle target=E:\Deepseek Harness\plugins\dsh-a2a
```

返回 `application: applied` 后：

```bash
curl -s http://127.0.0.1:3080/.well-known/agent.json
curl -s http://127.0.0.1:3080/.well-known/agent-card.json
curl -s http://127.0.0.1:3080/a2a/health
```

面板：

1. 打开 Settings；
2. 左侧应出现 **A2A 网络**（order 60）；
3. 页面应显示 RPC URL、Card 路径、鉴权状态、节点表格、活动流；
4. 设置入站令牌后，`POST /a2a` 从 `503` 变为 `401`（无令牌请求）或 `200`（正确令牌）。

Client slot 可以通过 Inspect 验证：

```text
cordis_inspect_query client Slots.listSubTree root=settings.section
```

occupant 中应出现 `id: "a2a"` 且 `active: true`。

> 没有浏览器控制时，slot 注册成功不等于像素渲染成功；需要人工打开 Settings 确认布局与交互。

## 5. 出站节点验收

1. 启动一个真实 A2A peer（或使用 `tests/integration/rpc-client.spec.ts` 的 mock 服务）；
2. 在 Settings 添加节点，填 base URL、Bearer/None、令牌；
3. 保存后等待插件重载，点击“刷新卡片”；
4. 节点行应显示 Card 名称、版本、Skill 名称与工具名；
5. 在对话中让模型调用 `a2a__<node>__<skill>`；
6. 面板活动流应出现 `outbound` 记录与任务状态。

没有配置节点时，不应注册任何 A2A 工具；`Tool.listTools` 中也不应出现 `a2a__*`。

## 6. 故障注入清单

| 场景 | 预期 |
| --- | --- |
| 错误 Bearer | 401，任务不创建 |
| 超长 body | 413 |
| 非法 JSON | 400，`-32700` |
| 非法状态迁移 | `-32600`，任务状态不变 |
| 远端 401/500 | 工具抛出/返回错误，不影响其他工具 |
| 远端返回非法 Task | 工具抛出 `Remote result ...` |
| 发现 3xx | 拒绝，不跟随重定向 |
| 节点 Card 无 skills | 发现失败，节点显示错误 |
| 取消运行中任务 | `canceled`，Agent 收到 cancel |
| 进程重启 | `tasks/get` 返回 `-32001`；contextId 可 resume Session |

## 7. 已知测试缺口

- 没有真实浏览器点击/截图测试；
- 没有真实 DeepSeek 模型的常驻 suite（需要 key）；
- 没有多节点并发压力测试；
- 没有远端 OAuth2/OIDC 流程测试；
- 没有 Task TTL/LRU 的长期内存测试。
