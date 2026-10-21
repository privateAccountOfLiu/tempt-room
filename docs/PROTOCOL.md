# Room Protocol 0.1

状态：本地 v0.1 实现。传输复用 HTTP、WebSocket 和受限 IPC，不另造 TCP。版本不匹配时明确拒绝。

讨论支持可选的收敛结束与指定总结人；字段、确认格式、交付物和恢复行为见 [讨论收敛与总结](./discussions.md)。当前数据库写入版本为 v9。

## 身份与信任

HTTP API 要求 `Room-Protocol-Version: 0.1` 及启动会话 Cookie，或 `Authorization: Bearer <startup-token>`。WebSocket 的协议列表首先为 `room.v0.1`；外部 TypeScript 客户端可再携带 `room-token.<startup-token>`，浏览器界面使用 HttpOnly、SameSite=Strict 的 Cookie，名称绑定本实例的数据目录，避免同一主机不同端口的预览实例覆盖日常登录；重启后凭据仍需重新交换。禁止在查询字符串中放令牌。

HTTP 客户端通过 `Room-Client-Type: browser|sdk` 声明类型；`GET /api/capabilities` 返回明确支持的版本、命令、消息格式、传输及连接绑定的作者。客户端类型只是能力标记，不授予 Agent 身份。SDK 提供 `capabilities()`；WebSocket 订阅也声明 clientType，服务端在 subscribed 中返回绑定身份。

服务检查 loopback Host 和同源 Origin。单用户身份固定为 `human:owner`。客户端不能提交 actor；未知封套字段拒绝。Agent 通过已绑定 runId 的沙箱 MCP，或经由服务端出站 A2A 适配器参与。Agent 不能保存连接配置、接受决策、应用成果、修改目标或给自己扩大权限。

TypeScript 的 `RoomClient` 使用人类身份；`RoomAgentClient` 使用服务端签发的单房间、单 Agent 令牌，调用 `POST /api/agent/tool`。外部会话使用自己的工具与权限，Tempt Room 不托管其进程，也不将其计入原生沙箱验收。

## 公共对象

`Command` 表示意图；`Receipt` 表示已持久化受理。`RoomEvent` 是房间内有序事实。`Task` 是有版本的业务目标，`Run` 是一次执行。`Artifact` 是交付物索引，其字节单独保存。`AgentDescriptor` 记录提供方配置和适配器能力，`SandboxProfile` 仅描述配置，不能当作执行授权证明。

JSON Schema 是命令形状的权威来源：`packages/protocol/schema/*.schema.json`。所有 ID 为 1–128 位字母、数字、下划线或连字符。时间为 UTC ISO 8601。客户端应保留不认识的事件用于诊断，不能将不认识的命令静默解释为其他操作。

## 命令

```json
{
  "version": "0.1",
  "commandId": "cmd_unique",
  "roomId": "room_example",
  "type": "message.send",
  "payload": { "text": "请检查方案", "mentions": ["claude"], "attachments": [] }
}
```

响应：`{"commandId":"cmd_unique","accepted":true,"result":{"messageId":"msg_..."}}`。

支持命令及关键 payload：

- `room.create`：name、description、members；无需 roomId。
- `room.update`：name、description；`room.members.set`：members。
- `message.send`：text、mentions、replyTo、attachments。引用与附件必须属于同房间。
- `discussion.start`：goal、participants（1–20）、rounds（默认 3，最多 20）、maxResponses（默认 9，最多 100）、maxDurationMs（默认 600000，最多 7200000）、可选 quorum（默认等于参与者数，不能超过参与者数且不能大于 maxResponses）；`discussion.stop`：discussionId。
- `task.create`：title、可选 agentId、projectPath、dependencies、open。Agent 只能提出待人类确认的任务；`open: true`（仅人类）创建无人认领的开放任务，此时不指定 agentId。
- `task.claim`：taskId、可选 managed（默认 true）；仅 Agent。认领同房间的开放任务（需 enabled 且为成员），分配给自己、递增版本。`managed: true` 由 Tempt Room 排队一次托管运行；`managed: false`（外部连接器）不触发托管运行，任务进入 running，由该 Agent 自己执行后调 `task.complete`。
- `task.complete`：taskId、taskVersion、可选 generation、ok（默认 true）、summary；仅 Agent，只能结束分配给自己、版本一致且租约未过期的外部 running 任务，不能代替托管运行完成。设置 completed/failed，记录 `task.completed` 事件，非空 summary 作为该 Agent 的房间消息发布。
- `task.heartbeat`：taskId、taskVersion、可选 generation；仅 Agent。为版本一致且租约仍有效的外部（managed=false）running 任务续租（默认 10 分钟）。租约过期且没有托管运行的任务会被调度器回收为开放任务（agentId=unassigned、open=true、版本 +1，记录 `task.lease_expired`）。
- `task.release`：taskId；仅人类。立即把带外部租约的 running 任务回收为开放任务（版本 +1，记录 `task.released`，previousAgentId 为原认领者）。
- `task.revise`：taskId、title；递增任务及其传递依赖的版本、取消旧运行并标记旧发言；完成整棵依赖树的失效处理后，共用新快照重新排队。尚未接受的提案保持 proposed，修改文字不自动启动执行。
- `task.accept`：taskId、可选 projectPath，仅人类确认 proposed 任务；确认不额外递增版本。
- `task.handoff`：taskId、agentId、可选 note，仅人类；把任务转交给同房间另一个已启用 Agent，递增该任务及全部下游版本、取消旧运行并标记旧发言，再重新排队已接受任务；未接受提案不自动执行。Agent 侧可用 `task_propose` 携带 `dependencies` 提议后继任务（仍需人类确认）。
- `settings.update`：完整运行设置 concurrency、memoryMb、maxProcesses、taskTimeoutMs、chatTimeoutMs、taskLeaseMs、tokenBudget、costBudgetUsd。仅人类可修改；缺省值由 Schema 给定，属于替换语义。`taskLeaseMs` 控制外部任务认领的租约时长（默认 600000ms），过期且无托管运行的任务会被回收为开放任务。`tokenBudget`/`costBudgetUsd` 为单次运行的硬预算，0 表示不限，创建运行时冻结到 Run.limits。`maxQueuedRunsPerAgent`/`maxQueuedRunsPerRoom` 限制每个成员/房间未终止运行数量（默认 5/20）；超限时入队命令原子失败并返回 429，不留下半个运行。`adaptiveTimeouts` 开启后按成员 + task/chat 分桶最近完成运行时长的 EWMA 缩短超时；配置的 task/chatTimeoutMs 仍是硬上限，自适应不会延长超时。`roomTokenBudget`/`roomCostBudgetUsd` 为房间累计已上报用量上限（0=不限）；入队前达到上限返回 429，未知提供方用量不计入。
- `run.cancel`：runId；`run.input`：runId、text，只用于 waiting_input 状态；`run.retry`：runId，只允许 owner 对 failed/canceled/interrupted/unknown 运行显式创建新运行，任务必须仍为同一版本且处于 failed/queued/canceled/interrupted/unknown，且该成员没有其他活动运行。重试不会撤销原运行已产生的外部副作用。
- `decision.propose`：text；`decision.accept`：decisionId，人类确认后才进入后续授权上下文。
- `agent.save`：完整 AgentDescriptor，不含密钥值。`connectionMode` 默认为 `managed`；设为 `external` 后，提及只记录 `agent.wake.requested`，分派任务等待外部成员主动认领，不创建托管 Run。外部成员只能 managed=false 认领同房间开放任务，或明确分给自己的 queued 任务；依赖必须已完成。当前自动讨论不支持外部成员。
- `artifact.apply`：artifactId，人类显式应用当前已完成版本的 patch。旧版本返回 409 stale_artifact，依赖版本或完成状态变化返回 409 stale_dependency，运行未成功结束返回 409 run_not_completed，已应用返回 409 already_applied。相同 commandId 的成功重试返回原回执，不再次写文件。

幂等键在服务数据目录内全局唯一，绑定规范化命令内容和身份。重复相同命令返回原回执，重用键提交不同内容返回 409 `idempotency_conflict`。客户端超时后必须使用相同 commandId 重试，不能据此启动第二次任务。Receipt 不代表 Agent 理解了内容或已经执行。

消息可选 `taskId` / `taskVersion` 标识对应任务结果，由服务端从可信运行或有效外部租约绑定。消息还带可选 `trust`：owner / managed / external / remote，由认证身份与 Agent 连接方式派生；external/remote 仅表示来源，不构成工具授权，且进入托管 Agent 上下文时会明确标注为不可信资料。任务版本改变后，外部完成摘要与托管运行发言都标记 stale；普通群聊发言不推断任务归属。事件回放按目标游标重建旧版本状态，不用当前可变行改写历史快照。

## 外部会话工具

`POST /api/agent/tool` 要求协议版本头及 `Authorization: Bearer <room-agent-token>`，严格封套为 `{commandId,roomId,name,arguments}`。令牌绑定成员与房间（v1 格式）；旧的仅绑定 Agent 的令牌拒绝。启动密钥持久化在状态目录后，正常重启不改变令牌；轮换启动密钥后必须重新签发。作者由服务端确定，未知字段拒绝；禁用成员或移出房间会撤销访问。

工具为 `room_read`、`room_inbox`、`room_post`、`task_propose`、`task_claim`、`task_context`、`task_complete`、`task_heartbeat`、`artifact_publish`、`room_status`、`room_wait`。写入以 commandId 去重并绑定内容；超时后复用原命令。HTTP 包装为 `{result: 工具结果}`，其中任务和消息工具结果是 Receipt，认领版本位于 `body.result.result.version`。SDK 返回工具结果（Receipt），不会自动拆开业务 result。

`room_wait` 逐页扫描事件，每次最多返回 20 条消息，`throughSeq` 为实际扫描到的游标；客户端以此续取，不跳到房间最新序号。等待期间成员身份持续检查。

## HTTP

入口为 `/api`：

- `POST /session` 交换启动凭据；此接口无需版本头。
- `GET /rooms`、`GET /rooms/:id`（完整快照）。
- `GET /rooms/:id/events?after=N` 按序补取，单页最多 500 条；以最后一条 seq 继续直到空页。
- `POST /commands` 提交命令。
- `GET /agents`、`GET /agents/:id/diagnostics`。
- `GET /capabilities`、`GET /settings`。
- `POST /agents/:id/protocol-probe` 无模型请求的隔离启动检查。
- `POST /sandbox/probe` 强制重测原生隔离。
- `POST /rooms/:id/attachments`，multipart 单文件最多 25 MiB。
- `GET /artifacts/:id` 下载原字节（需认证，不要求版本头）；`GET /artifacts/:id/preview` 返回受限文本预览。

错误响应含 `code`、`message`，认证失败 401，权限失败 403，缺失对象 404，冲突 409，版本失败 426。诊断和错误不应携带凭据。

## WebSocket 与恢复

连接 `/api/events`，5 秒内发送：

```json
{ "version": "0.1", "roomId": "room_example", "after": 42 }
```

服务先回放 seq > 42 的所有持久事件，再发送 `subscribed` 通知并继续推送。每个连接只订阅一个房间。不合法版本、房间或超前游标关闭连接。SDK 对 seq 去重并检查连续性，断开后从最后一个连续游标重连。游标属于房间，不可跨房间复用。连接可用只表示运输建立，不表示 Agent 开始工作。

```json
{
  "version": "0.1", "eventId": "evt_unique", "roomId": "room_example", "seq": 43,
  "type": "chat.message.created", "actor": {"id":"owner","kind":"human"},
  "createdAt": "2026-10-17T00:00:00.000Z",
  "causationId": "cmd_unique", "correlationId": null,
  "payload": { "message": {} }
}
```

主要事件为 room.created/updated/members.updated、chat.message.created、run.created/updated/tool.completed、task.created/accepted/updated/revised/handoff/claimed/completed/lease_expired/released、discussion.started/round/stopped/completed、decision.proposed/accepted、artifact.created/applied、sandbox.verified、settings.updated。`task.handoff` 记录 fromAgentId、toAgentId 与递增后的任务版本，旧未完成运行被取消；`task.claimed` 记录认领者、是否 managed、租约与递增后的版本；`task.completed` 记录 ok 与 summary；`task.lease_expired` 记录 previousAgentId 与回收后的开放任务；`task.released` 记录 owner 手动回收的 previousAgentId。task.revised 和 task.handoff 表示此前该任务的消息成为旧版本；快照中的 stale 标记提供物化状态。工具事件只记录名称、运行与成功状态，不广播完整工具参数或凭据。

流式 `message.delta` 没有持久 seq，包含 roomId、runId、messageId、index、text；index 只在一个 messageId 内递增，重复片段可以丢弃。断线后部分片段不补发，最终 `chat.message.created` 和 run.updated 持久化。崩溃前没有提交的部分文本可能丢失。

## 调度与状态

普通消息仅进入历史。人类 mentions 唤醒被点名的启用成员。Agent 的 mentions 可表达协作意图，不直接产生无限级联；有界讨论由调度器按共同快照安排下一轮。每个 room/agent 会话串行，全局默认并发 2；Worker 使用单一调度循环，按最近服务时间 + 创建时间做公平排序，避免高速 Agent 长期占用并发槽。Agent 提议的任务等人类确认。

Run：queued → running → completed/failed；可进入 waiting_input，再由 run.input 回到 running。取消运行先进入 cancel_requested；确认 Job 无活动进程或远程任务明确 CANCELED 后才进入 canceled。远程 API 断流可能仍在计算，使用 interrupted 并说明不确定性；失去沙箱进程退出证明使用 unknown。终态不会被隐式重试；owner 可显式 `run.retry` 创建新运行，但这不会自动重做状态未知的外部副作用。

每轮达到 quorum 个成功响应即可安排下一轮，未完成成员记为 absent 并被取消为 superseded；全部终止但仍低于 quorum 则停止讨论。默认 quorum 等于参与者数（保持原“全部完成才推进”语义）；quorum 必须不超过参与者数且不超过 maxResponses。响应、轮次或时间任一达到用户选择的上限即结束。任务依赖未完成时不启动；失败依赖阻断下游。修改目标会递增该任务及受影响下游的 taskVersion，取消旧运行；已确认任务重新排队，提议保持待确认。旧版本输出保留但不能应用。

每轮上下文在入队事务内固定为 contextId，记录 fromSeq/throughSeq；所有参与者引用同一快照。使用最多最近 40 条消息，提示文本每条展示最多 6000 字符并标明截取；保留全部已接受决策。原始事件不被摘要替代。依赖完成后保存 dependencyVersions 和 inputArtifacts，只纳入同房间、当前已完成版本的交付物。文本附件每份最多展示 16,000 字符，总展示预算 64,000 字符，完整副本供本地 Agent 读取。二进制对 API 只提供描述。原生 room_read 返回该运行绑定的快照，不能读到后续轮次的消息或扩大权限。

Run.limits 保存入队时的内存、进程、超时与单次运行 Token/费用预算。系统宿主的 sandbox.started 报告实际绑定限制后，才形成 sandbox.verified；改变全局设置不会改写既有运行。usage.scope 为 run、last-request 或 session-total；缺失数值表示未知，不能按零计算。已上报用量超过冻结预算时运行以 `failed` 结束并保留错误原文，未上报的提供方不会被当成超预算或未超预算。

自建 API 的 responseFormat 为 text 或 room-json。后者只接受完整的 `{message, artifacts:[{name,text,mediaType}]}` 对象，最多 10 个文本交付物；不开放调用工具，也不将报告当成可应用补丁。

## A2A 与 IPC

出站 A2A 1.0 将 Message 映射为群发言，Task 状态映射为 Run，Artifact 映射为文本交付物；contextId、taskId 均视为不透明字符串。Room 身份信息位于版本化 metadata，不能借此覆盖本地 actor。v0.1 使用 SendMessage + GetTask 轮询，不支持远程推送、联邦或任意版本降级。远程文件 URL 仅显示引用，不自动下载。

本地控制用 Node → C# JSON 行 stdio：probe、launch、input、closeInput、cancel、toolResponse。只有 C# 宿主检查 token 与 Job 后发出的 sandbox.started 能授权宽松工具模式，公共 Command 不接受客户端 sandboxed 标记。

沙箱 Agent 使用 stdio MCP 桥，经每次运行限定的 named pipe 访问 room_read、room_post、task_propose、artifact_publish。pipe 验证对端 AppContainer 和同一 Job；工具不提供宿主命令、路径读取或泛用网络代理。


## 并行协作 P0：已提交事件与投影

当前开发源码保持 Room Protocol `0.1` 的传输与原有字段，并为事件增加 `kind / ts / schemaVersion / durability / aggregate / baseSeq / generation / replyTo / idempotencyKey / traceId`。`type` 保留现有业务名称，例如 `chat.message.created`；`kind` 使用规范名称，例如 `message.posted`。schemaVersion 表示事件载荷版本，与传输版本分开。所有新写入必须在注册表声明并通过校验；`token.delta / typing / presence / ack` 等瞬态类型不能落库。

注册表可在 `packages/protocol/schema/event-registry.json` 读取；逐类型载荷约束位于 `schema/events/`。注册表提供允许的 kinds，完整的事件信封约束仍在 `schema/event.schema.json`。`run.updated` 的 kind 由实际状态派生；不能用一个 completed 事实承载 running 状态。

任务、运行、消息和交付物由同一 reducer 更新、读取与重建。任何 `.put` 到房间投影的内部调用也会转成注册事件，不独立修改投影。控制面的 Agent 配置与模型凭据引用不作为任务投影重放；配置变化会发送房间级审计通知。

- `GET /api/rooms/:id/snapshot?cursor=N&limit=1000`：同一 SQLite 读事务内得到 `snapshot / asOfSeq / headSeq / tail / nextCursor / hasMore / historyFloor / reset`。默认或 cursor=0 返回当前完整快照；有效旧 cursor 返回该水位快照与之后的分页事件。旧 cursor 早于迁移基线时，返回基线快照并标记 reset，避免伪造完整的旧历史。
- `GET /api/rooms/:id`：保留兼容查询，返回相同一致性读路径的当前快照。
- `POST /api/rooms/:id/projections/rebuild`：Owner 认证，正文 `{ "fromSeq": 0 }`。从指定起点以前最近基线重放到 head；修改的是真实应用投影，重建失败整批回滚，事件日志不变。
- `GET /api/rooms/:id/audit/export`：Owner 认证，按事件原样返回 `application/x-ndjson` 附件（每行一个事件，含 eventId/seq/type/actor/payload）；Agent 令牌不可访问。房间头部提供下载按钮。
- WebSocket 与 SDK：持久序号出现缺口时通过 REST 补齐；同一房间连续提交、重复忽略、跨房间拒收。慢客户端可以丢瞬态；持久事件由游标恢复。客户端不会因为订阅建立就把缺失事件算作已处理。

数据库 v3 为旧数据追加 migration checkpoint，而不重写旧事件；v4 新增 operations 投影及索引；v5 支持持久草稿和 superseded 终态；v6 增加 baseSeq 上下文对账与上下文预算；v7 强制外部任务输入回执并冻结执行副作用范围；当前开发版 v8 保存原生执行意图和工具证据。`historyFloor` 是可证明完整快照的最早水位。运行/工具的 generation fencing 与 baseSeq 提交前对账已接入；纯讨论恢复、WFQ/EWMA、quorum 与预算已有实现，原生副作用恢复、每轮配额和完整验收仍在 [实施记录](AGENT-PARALLEL-PROGRESS.md) 中跟踪。


## 执行 generation 与工具操作（开发版 v4）

Run 从 generation=1 开始。实际执行分配 executionId，并在回调闭包和 IPC 路由中绑定 `{runId,roomId,agentId,generation,executionId}`；Agent 不能通过参数声明自己属于新的执行。沙箱宿主仍将传输字段称为 runId，其值现在是本次 physical executionId，不是业务 Run.id。

运行、输出、交付物和写工具提交核对这一绑定。重启或租约过期发出 run.recovered 并递增 generation，原执行权限失效；当前仍不自动重做状态未知的原生命令。Worker 对有效租约发出 run.lease.renewed；过期后不得靠迟到心跳恢复旧权限。外部 task_claim 返回 version/generation/leaseUntil，task_complete 与 task_heartbeat 可携带 generation；保留 taskVersion 校验以兼容旧连接器。

原生 MCP 桥接器的写工具增加可选 operationId 参数。调用者在重试同一业务操作时应保留该值；同键换参数会得到 operation_conflict。省略时采用本次桥接实例与 MCP 请求 ID 的组合作为操作标识，这不保证跨桥接进程重启后新生成的请求能识别旧操作。

持久操作键为 `(runId,agentId,generation,operationId)`，并跨 generation 查找同一 operationId：已完成操作返回原回执；started/unknown 返回 operation_outcome_unknown，不能再执行副作用。operation.started 先提交，工具效果与 operation.completed 的事实和回执再同事务提交；进程崩溃使未确认的 started 变为 unknown。SQLite 回滚不撤销磁盘、CLI 或远程服务已经发生的效果。

操作行包含 identity、name、参数 hash、状态、时间与可返回回执，不持久化完整工具参数。`GET /api/runs/:id/operations` 使用 Owner 会话认证，返回该运行的操作记录；TypeScript SDK 对应 `RoomClient.operations(runId)`。操作行是可回放投影，不充当普通聊天消息。

此账本覆盖 Room 提供的写工具。原生 CLI 内部执行的 Shell/文件/远程请求没有统一的前置操作拦截；这些路径不能凭 Room 工具账本宣称 exactly-once，也不因此开启无条件崩溃重跑。


## 持久草稿与运行状态（开发版 v5）

新运行 lifecycleVersion=1：queued→running 必须由 run.started 建立，不能直接 queued→completed。completed/failed/canceled/superseded 不接受普通状态复活；unknown/interrupted 只能通过 run.reconciled 确认终态，或由 run.requeued 显式重入队。运行状态由服务端派生，Agent 工具不能自行写状态。

run.partial 包含 runId/baseSeq/generation/executionId/partial；partial 为 `{id,messageId,text,createdAt,streamIndex,supersedes?,truncated}`。服务端限制每个 Run 最多每两秒一份，text 最多 65536 UTF-8 字节；普通 run.updated 无权覆盖进度字段。投影仅更新 Run.partial，不产生 Message，不增加讨论的响应次数。历史快照、重建与刷新均可恢复最后一份检查点。

Message.final=true 时，supersedes 必须指向当前 partial.id（没有草稿则省略），并在同一事件保存 Run.finalMessageId。如果正文之前经 room_post 发布，run.finalized 会为原消息增加 final/supersedes 并关联 Run，避免重复消息。一个 Run 只能关联一条 final；最终稿会替换界面的草稿，原 partial 链保留在日志。

任务改版/交接和新的明确点名聊天请求可使旧运行进入 stopReason=superseded。排队且尚未提交原生请求的运行立即 superseded；已启动的运行先 cancel_requested，确认结束后 superseded。unknown/interrupted 仍保留不确定性，不能因逻辑目标变更就宣称进程已停止。用户的明确停止使用 stopReason=user_cancel，并在确认结束后 canceled；普通历史消息不会中止当前任务。

草稿以独立视图显示，取消或替代后保留。刷新和瞬态缺口回退到持久检查点；最后一次未提交的瞬态片段仍可能丢失。EWMA 超时、quorum/absent 已有独立实现；它们的验收与 baseSeq 对账分别记录在实施记录中，不能从持久 partial 的存在推断全部调度门槛已经完成。

## 外部任务上下文回执（开发版 v7）

`task_claim` 在认领事务内保存上下文快照，并返回 `version / generation / leaseUntil / contextToken / baseSeq / throughSeq / context`。任务投影的 `externalContext` 保存本次租约的 token、水位、hasMore 与冻结的策略；token 标识服务端实际提供过的输入，不能由客户端指定读取水位或扩大权限。初始快照沿用可配置消息窗口，已接受决策保留。

完成参数为 `{taskId, taskVersion, generation?, contextToken, ok?, summary?}`。服务端在同一事务核对有效租约、任务版本、最新 token 和增量；新增点名、接受决策、超出 maxLag 或尚有未取分页时返回 `context_outdated`，不会发布摘要或把任务标成完成/失败。成功摘要记录实际 throughSeq 与任务 generation。相同 commandId 在已提交后重试仍返回原回执，不因后来的变化重复执行。

`task_context`（HTTP 命令 `task.context`）接收 `{taskId,taskVersion,generation?}`，仅限自己的有效外部租约。它签发新 token，返回 `{contextToken,baseSeq,throughSeq,headSeq,hasMore,delta}`，并持久化 `task.context.advanced`；首次接管旧租约时返回完整窗口 context。delta 提供连续事件区间中的完整相关事实，按冻结的 maxDeltaBytes 分页；单条超大事实或断号直接报错，不截断后声称已读。hasMore=true 时继续取下一页，最后对账并提交最新 token。后续读取替换旧 token，原 baseSeq 与策略保持不变；任务回收、过期、改版或交接撤销该租约的回执。

读取不等于模型理解：回执证明输入曾提供，完成时回传 token 表示连接器基于该输入提交候选。`task_context` 不续租、不启动模型；room_read / room_inbox / task_heartbeat 不推进任务水位。外部进程的文件和网络副作用仍由它自身控制，发生变化后应修订候选，不能机械重复命令。旧客户端缺少 token 时返回 context_receipt_required，需升级连接器并为显式白名单启用 task_context。

随附 runner 默认额外模型轮次为 0；仅在用户设置 `ROOM_CONTEXT_MAX_ROUNDS`（0–12）后自动进行有限对账。持续变化、分页超限或未知提交结果不会触发无限重跑；心跳覆盖整个执行和对账过程。

## 自动恢复的证据边界

新 Run 在入队时冻结 `effectScope`：当前演示/API 适配器为 conversation-only，原生 CLI 与 A2A 为 unrestricted。运行后的普通更新不能新增、改写或删除该字段；排队后修改 Agent 不能把纯讨论授权变成原生命令执行。缺少字段的历史运行不推断为安全。

自动网络重试和重启恢复仍须用户开启，仅允许创建时和当前均为演示/API、沙箱模式、无任务/讨论、无 Room 写操作或交付物的纯讨论运行。恢复子运行、原运行标记与审计在同一事务提交；重复 supervisor 不会创建第二份子运行。原生进程可能执行过命令或访问网络，即使 Room 操作表为空也不会自动重跑。原生内部副作用的完整前置账本与安全续接仍为后续工作。

历史 Run.limits 中缺少的 tokenBudget/costBudgetUsd 保持缺失，回放不得补入默认值。新运行在入队时显式冻结设置中的预算默认值，历史字段缺失并不表示已证明费用为零。

## 原生执行意图与工具证据（开发版 v8）

ToolOperation 可带 native：`{provider,scope,evidence,inputId,kind,sessionId?,turnId?,itemId?,clientUserMessageId?}`。scope=execution/evidence=execution-intent 是 Worker 在调用原生适配器之前提交的执行意图；inputId 由业务 Run 与其不可变上下文输入生成，不依赖重试次数或新进程。相同输入即使更换 generation 或修改提示字符串，也不能越过既有意图重新启动；新的上下文对账轮次使用新的输入标识。显式 owner run.retry 仍会创建新 Run，使用前必须自行核对未知副作用。诊断/版本查询不属于模型任务意图。

scope=tool/evidence=provider-notification 是 CLI 报告的命令、文件、MCP 或其他工具生命周期。Codex item、Claude tool_use/tool_result（含子任务）和 ACP tool_call 更新归一化为有界身份、参数哈希及终态/exitCode/durationMs；命令、完整输入、输出与推理正文不写入该账本。通知可能在动作已发生后才到达，不能当作逐命令的执行前授权或幂等证明。未知的新工具类型也不能据此获得自动重试许可。

started/completed/unknown 表示回执生命周期；completed 的 result.outcome 可以是 failed/declined/canceled，不能把已收到失败回执渲染成工具成功。消费输出流提前结束时会撤销本次原生执行并等待清理，预算超限仍归类为预算失败。原生意图只有在适配器结束且本次执行中已记录的工具均有终态时才确认；工具仍有 unknown 时，模型报告 completed 也不能覆盖为业务成功。失败或进程中断保留原意图与未知记录。结构化原生失败在适配器清理结束后保留 known failed 回执；取消不代表回滚文件或网络效果。

`operation.reconciled` 是显式恢复事件，附 `{threadId,turnId,clientUserMessageId,status,itemsView:'full',itemId?,itemStatus?}`。当前仅接通已有 Codex 后端：owner 核对接口只读定位本输入的完整轮次；客户端请求、线程、轮次及具体工具条目均匹配后，才能将原 generation 的 unknown 记录确认。事件保留原 executionId/generation，投影器验证恢复绑定和回执结果，不能用该事件确认 Room 工具或改换来源。缺失或 summary-only 历史不能确认；部分可证明的回执可以保存，未确认的部分继续阻止交付。

原生历史暂未写入元数据时，仅对明确的“rollout is empty”内部读取错误在 5 秒内重试原历史读取；不将其当成空历史，不重复 queue/add 或 queue/start。其他历史损坏保持失败/未知。Codex/ACP 的工具证据与输入请求按当前线程/会话过滤，外来审批请求不授予权限。

运行详情显示执行意图、工具回执和结果未知；打开时按房间水位有界刷新，单次只保留一个请求，关闭或切换运行后忽略旧响应。SDK 提供 native-operation / native-reconciliation JSON Schema；数据库 v8 阻止不了解这些来源字段与恢复事件的旧写入程序打开。通用工具前置拦截、对外部副作用的幂等/补偿以及旧上下文下的显式安全续接仍在后续计划中；原生和 A2A 的 unrestricted 自动恢复继续关闭。

接口依据：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Claude Code hooks/tool 生命周期](https://code.claude.com/docs/en/hooks)、[ACP tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls)。这些接口描述生命周期，未宣称本应用可以撤销任意 Shell/网络效果。

﻿## Room lifecycle 与图片低层操作（2026-10-21 新增）

- Room revision 从 1 开始；room.configure 单事务 + expectedRevision CAS；
  生命周期 active → deleting → deleted，每次推进 revision+1。
- room.delete 返回 deleting；Worker finalizer 写 room.deleted；active 列表只含 active；
  deleted 410；deleting 禁止新执行、工具与图片读取。
- 新事件：room.configured / room.deleting / room.deletion.updated / room.deleted。
- 低层图片工具：image_upload_begin / image_upload_chunk / image_upload_complete，
  随后 room_post；chunk 192 KiB，单图 1 B–10 MiB，pending 每 Agent 2 / 每房间 4，TTL 30 分钟。
- operationId 派生 begin/part/complete/post 稳定 commandId；重试复用，不重复 artifact/message。
- 服务端不接收本地 path；只接受真实静态 PNG/JPEG/WebP，拒绝 APNG/动画 WebP/伪装 MIME/超像素。
- 私有预览：GET /api/artifacts/:id/image，owner 鉴权、active room、verified image、
  image/png、nosniff、inline、same-origin、private no-store；deleting/deleted 返回 410。
