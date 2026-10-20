# Next Agent 实施进度（v1.1 / M0 波次）

本文件记录 `next-agent-implementation-plan-v1.1.md` 的实际实施状态，不能替代计划本身或验收证据。目标仍是 M0–M1 的完整闭环；当前完成的是 M0 中可独立验收的一波：A00 基线证据、A01 审计分页、A02 调度公平。

## 本次完成

### A00 — 协作基线证据

- 新增 `scripts/verify-collaboration-baseline.ts`、`tests/verification-report.test.ts`
- `package.json` 新增 `verify:collaboration`
- 顺序运行 `npm run typecheck`、`npm test`、`npm run test:replay`，保存：
  - cwd、HEAD、dirty 状态、Node/npm/Git 版本
  - 每条命令 argv、开始/结束时间、exitCode、stdout/stderr 文件、SHA256
  - report schemaVersion、source、test totals、`modelRequests: 0`
- 任一命令失败时脚本退出非 0；报告仍会写入证据目录
- 测试使用成功/失败假 runner，验证 totals、exit code、dirty/HEAD 区分、输出哈希

本次真实运行：

```text
collaboration baseline: PASS
source HEAD: 5ca9850fb887eb177dc98a9763b3e2d2559ee53b (dirty)
typecheck: passed
test: passed
replay: passed
report: .state/collaboration-baseline/run-2026-10-20T10-01-01-244Z-bede87da/report.json
```

### A01 — 审计导出分页

- `Store.scanEvents(roomId,{afterSeq,throughSeq,pageSize})`：
  - 每页最多 1000 条
  - 只读取 `seq <= throughSeq`
  - 游标不前进或中间断号时报错，不把截断结果标成功
- `/api/rooms/:id/audit/export`：
  - 先冻结 `throughSeq = room.seq`
  - 通过 NDJSON 流输出，使用 Node `Readable` 背压
  - 增加 `x-audit-history-floor`、`x-audit-through-seq` 响应头
  - 保持 owner 鉴权；新增事件不混入已冻结水位
- 扩展 `tests/audit-export.test.ts`：
  - 0 / 500 / 501 / 2501 条追加事件的完整导出
  - 事件 seq 连续
  - 非 owner token 返回 401
  - scan watermark 冻结与后续增量读取

### A03 — host 变更归因与独立执行目录

- 新增 `apps/server/src/host-workspace.ts`：
  - `hostStatus` 从 Git porcelain 状态码升级为“状态码 + 文件内容 SHA256”
  - 覆盖 tracked、untracked、删除、重命名和“执行前后同为 M 但内容再次变化”
  - `hostChangeReport` 只报告执行期间观察到的变化，并明确“未证明由该 Agent 独占产生”，不做归因
- host 聊天工作区改为每 Run 独立目录 `workspaces/host-chat/<roomId>/<runId>`；不再复用旧房间共享目录，不再执行 `git add -A` 自动提交
- host 聊天结束后生成「本机对话变更清单」artifact，不替用户提交既有修改
- host 任务仍使用真实项目目录（D01a 尚未接入），报告只做内容变化清单，不改写用户工作树
- 新增 `tests/host-workspace-isolation.test.ts` 3 项；`npm test` **295/295**

### B06 — InputBatch 交付主体

- 新增 apps/server/src/input-delivery.ts：
  - createBatch 在一个事务内把 pending InboxDelivery 变成 InputBatch，写 input.batch.created，并把 delivery 标为 batched
  - provideBatch 在把冻结 prompt 交给适配器前记录 provided/receiptEvidence；不会二次提供
  - acknowledgeBatch 只允许对应 AgentSession 确认已提供的批次；写 input.batch.acknowledged
  - 批次带 runId/generation/executionId/payloadHash/fromSeq..throughSeq
- service.inputDelivery 接入 RoomService；input.ack owner 命令实现
- Worker 对带 agentSessionId 的 Run：
  - startRun 先创建批次并附着 run.inputBatchId
  - prompt 提交前标记 provided（worker-next-turn）
  - 批次创建失败不隐藏运行，run 仍按冻结 prompt 执行
- 新增 tests/input-delivery.test.ts 2 项：批次创建/提供/确认与错误会话拒绝；Worker 唤醒运行自动创建并提供批次
- 外部 Agent 回执：新增 room_input_ack 工具与 input.ack agent 权限
  - Agent 只能确认属于自己 AgentSession 的输入批次
  - 错误 Agent 返回 403
  - owner 仍可确认
- input-delivery 测试扩展 Agent 确认与越权拒绝
- 输入投递模式：Subscription.deliveryMode → WakeIntent.deliveryMode → Run.inputDeliveryMode
  - next-turn：Run 启动前创建并 provided 输入批次（既有行为）
  - tool-boundary / steer：不在启动时创建批次；在工具调用完成边界创建并提供 InputBatch，结果附加 inputBatch 元数据
- 新增 input-delivery 1 项测试：投递模式传播、启动无批次、工具边界注入并标记 provided
- input.reconcile owner 命令：expire / unknown / provided 三态核对；过期批次同步把 delivery 标为 expired
- Worker 启动恢复：created 批次过期、provided 批次未知（仅当其 Run 已终态/不存在）
- API GET /api/rooms/:id/input-batches
- 集成面板新增「输入批次」区：状态、deliveryMode、seq 范围、标记未知/过期/确认回执
- 新增 input-delivery 1 项测试：unknown→expire、delivery 过期、Agent 越权拒绝
- steer 投递门禁：dispatchPendingWakes 在 deliveryMode=steer 时要求 fingerprint 匹配的 steerDuringRun=verified_supported
  - 未验证时 WakeIntent 标记 suppressed(steer_unverified)，不创建 Run
  - 通过 capability.verify 记录证据后，steer wake 正常派发并标记 Run.inputDeliveryMode=steer
- 新增 input-delivery 测试：steer 未验证抑制、验证后派发
- 投递门禁扩展到 tool-boundary：要求 fingerprint 匹配的 preToolGate=verified_supported；未验证 WakeIntent suppressed(pre_tool_gate_unverified)
- tool-boundary 测试增加 capability.verify 前置；新增未验证抑制测试
- 尚未完成：真实 steer 适配器通道、批次分页/筛选、推送刷新
### B05b — 能力证据持久化与 UI

- 新增 agentCapabilityFingerprint：绑定 provider、adapter 版本、executable 版本、运行布局、connectionMode、executionMode、模型与行为配置摘要
- 新增 capability.verify owner 命令：按 fingerprint+capability 确定性 ID 写入 capability.verified 事件，B02 唯一键保证同一能力只有一条当前证据
- 新增 API：
  - GET /api/rooms/:id/agents/:agentId/capabilities：当前指纹、证据、三态结果
  - POST /api/agents/:id/capabilities/probe：确定性契约探测；demo 仅写入可验证项，其他真实 CLI 保持 unverified
- Agent 设置表单新增「能力证据」面板：指纹、三态计数、验证时间、验证按钮
- 版本/模型/配置变化产生新指纹，旧证据自动失效为 unverified
- 新增 tests/capability-evidence.test.ts 2 项：探测持久化/指纹失效、命令指纹不匹配拒绝
- 自动路由仍待接入：当前调度继续使用兼容能力提示，不会把未验证证据当成支持
### 运行环境状态（2026-10-20）

- 按用户明确授权启动本地服务验证；服务运行于 http://127.0.0.1:4317（PID 22204；2026-10-20 18:04 重启到 context 分段提示词构建）
- 日常数据库 `.state/room.sqlite` 已从 v9 迁移到 v16
- 迁移前自动备份：`.state/room.sqlite.v9.1792484018897.bak`
- 已验证：GET /（200）、GET /api/rooms（200）、房间 snapshot（200）、GET /api/metrics（200）、capability-history（200）、resource-leases（200）；resource.reserve→resource.release 实测 200
- `.state/server.lock` 指向当前服务进程

- 能力证据历史：新增 capability_evidence_history 投影表、capability.history.recorded 事件；DATABASE_VERSION 升至 16
- capability.verify 每次记录当前证据并追加历史（当前 evidence 表仍按 fingerprint+capability 唯一）
- API GET /api/rooms/:id/agents/:agentId/capability-history（按当前 fingerprint 过滤）
- capability-evidence 测试扩展：同一指纹重复探测当前证据保持 10 条、历史累计 20 条
- Agent 设置能力面板显示历史条数与最近 5 条历史（支持/不支持/未验证、时间）
### B04 — 订阅投递与幂等唤醒主体

- 新增 apps/server/src/wake-policy.ts：纯触发策略；typing/partial/ACK/audit/状态/自身消息默认不唤醒，显式点名与 assigned-task 触发
- 新增 apps/server/src/inbox.ts：InboxService 扫描订阅、持久 InboxDelivery 与 WakeIntent；确定性 ID + B02 唯一键保证重复扫描不重复投递
- subscription.set 命令接入：owner 设置订阅，校验房间、AgentSession、成员资格与 scanSeq
- Worker.tick 接入订阅扫描；扫描水位用 head 记忆避免自身 subscription.updated 造成空转
- 队列上限：maxInboxDeliveries / maxInboxBytes；超限返回 429 inbox_full 并在事务内回滚本次扫描
- 权限/会话/成员撤销立即阻断；scanSeq 与 pending delivery 分开保存
- 新增 tests/inbox-subscription.test.ts 3 项：唤醒白名单、幂等扫描、队列上限与禁用
- 新增 dispatchPendingWakes：pending WakeIntent 为每个 AgentSession 生成一个 queued Run；重复 tick 不重复派工；active Run 存在时保持 pending
- 新增 GET /api/rooms/:id/subscriptions
- 集成面板新增「订阅」区：agentSessionId、deliveryMode、scanSeq、sourcePolicy、启用/停用切换
- 尚未完成：InputBatch 与输入回执（B06）
### B03 — 讨论生命周期主体（pause/resume/激活额度）

- discussion.start 在同一事务创建参与成员 AgentSession、首轮 Run（带唯一 responseSlotId）并冻结 activationLimit/activationsUsed
- 新增 discussion.paused / discussion.resumed 事件；pause 只允许 active→paused，resume 只允许 paused→active；AgentSession 同步 paused/active
- pause 持久化：重启后仍为 paused，Worker 不派发非 summary 的讨论 Run；恢复后允许原 queued Run 继续
- settleDiscussion 在 paused 时不推进轮次/不取消未完成者；summary Run 仍可结算
- 讨论 Run 禁止普通 run.retry；summary retry 保持可见（既有测试）
- 激活额度：scheduleRound 在 enqueue 前检查 activationLimit；超额以 activation_limit 停止，不静默继续；responses 与 activationsUsed 同时计数
- 新增 tests/discussion-lifecycle.test.ts 3 项：AgentSession/responseSlot、pause 持久化与 Worker 不派发、激活额度
- sessionKey 新增 v3 逻辑会话 scope（agentSessionId + workspace + 模式）；无 agentSessionId 的旧 chat 保持 v2 可续接
- 新增 tests/session-scope.test.ts 2 项
- 额外上下文输入计费：Worker 在 context reconciliation 推进 generation 前调用 recordDiscussionContinuation；计入 activationsUsed，超限时以 activation_limit 结束并取消当前 run
- 新增 discussion-lifecycle 1 项测试
- 总结独立激活额度：Discussion.summaryActivationLimit/summaryActivationsUsed
  - 讨论结束时先检查总结额度；额度用尽则 summary=failed 且不 enqueue
  - 总结 Run 的额外上下文输入计入 summaryActivationsUsed，超限时 summary=failed
  - run.retry 重试总结同样受 summaryActivationLimit 限制
- 新增 discussion-lifecycle 1 项测试：总结额度独立于讨论额度
- DiscussionForm 新增「总结激活上限（可选）」输入，随 discussion.start 提交 summaryActivationLimit
- 浏览器 E2E 讨论表单断言新增「总结激活上限」可见
- 讨论详情展示发言额度与总结额度用量；浏览器 E2E 断言「发言额度」
- 尚未完成：更多额度策略
### B02 — 可重放投影与 v10 迁移

- 数据库版本 v9→v10；新增投影表：agent_sessions、subscriptions、inbox_deliveries、input_batches、wake_intents、capability_evidence、discussion_rounds
- 新事件注册与 projector：agent_session.created/paused/resumed/ended、subscription.updated、inbox.delivered、input.batch.created/provided/acknowledged/expired、wake.requested/assigned/suppressed、capability.verified、discussion.round.opened/closed/late.received
- 唯一约束：inbox(agentSessionId,sourceEventId)、wake(scopeKey,sourceEventId)、capability(fingerprint,capability)、run responseSlotId、单 AgentSession 活动 Run
- v10 迁移前创建缺失表；旧数据库先备份，旧 checkpoint payload 缺新数组时按空集合解码，不重写旧事件字节
- Store.put / projectionBytes / snapshotAt / rebuildProjections / 清空逻辑覆盖新表
- 新增 tests/collaboration-projections.test.ts 4 项：新库投影与重建一致、inbox 唯一键、v9→v10 备份与事件字节不变、旧 checkpoint 兼容
- 服务端 B03/B04 前不产生这些事件；日常数据库未迁移，全部验证在 fixture/临时库完成
### B01 — 协作协议对象（B 批起点）

- 新增 `packages/protocol/src/collaboration.ts`：AgentSession、Subscription、InboxDelivery、InputBatch、WakeIntent、CapabilityEvidence，全部 Zod strict schema 为事实源
- Run 扩展可选追踪字段：`agentSessionId`、`inputBatchId`、`operationScopeId`、`responseSlotId`、`startedAt`、`finishedAt`、`adapterFingerprint`
- Discussion 扩展可选字段：paused 状态、triggerPolicy、activationLimit、activationsUsed、roundWindowMs、activeRoundId、authorizationRef、lifecycleVersion；endReason 增加 budget_exhausted/activation_limit
- 新增严格命令 schema：`discussion.pause`、`discussion.resume`、`subscription.set`、`input.ack`；服务端在 B03/B04 前明确返回 501，不假装已实现
- `scripts/schema.ts` 生成 6 个新 JSON schema 并更新 command/discussion/run schema
- 新增 `tests/collaboration-protocol.test.ts` 3 项：严格对象、旧 Run/Discussion 兼容、命令 schema 严格性
- B02 的迁移与投影已接入；B01/B02 共同构成协作事实层

### B05a — 能力指纹与三态证据格式（M0 前移切片）

- 新增 `apps/server/src/adapter-capabilities.ts`：
  - 10 项能力名：streamOutput/nextTurnInput/toolBoundaryInput/steerDuringRun/cancelOwnedTree/cancelRemoteTask/resumeSession/queryOutcome/usageScope/preToolGate
  - `adapterFingerprint` 绑定 provider、adapter 版本、executable/runtime 版本、connectionMode、executionMode、模型与行为配置摘要；不包含密钥
  - 三态：verified_supported / verified_unsupported / unverified
  - 证据带 suiteVersion、testedAt、evidenceHash；指纹不匹配时 `verifiedCapabilityState` 返回 unverified，不降级成“支持”或“实测不支持”
- 新增 `scripts/verify-adapter-capabilities.ts` + `npm run verify:capabilities`：
  - 运行 2 个模拟契约并输出报告
  - 真实 CLI 明确标记 `not_run`，不伪造证据
- 新增 `tests/adapter-capabilities.test.ts` 3 项：指纹变化、显式契约三态、陈旧指纹与自然语言声明不可路由
- B05b 才接入持久化、UI 与自动路由；本轮不把空接口接入生产路径

### A02 — 调度公平与 anti-starvation

- 新增 `ReadyScheduler`：
  - 房间 round-robin
  - 房间内按 Agent flow 做 smooth weighted round-robin
  - credit 改变时重置（集合/权重变化），等待次数保留
  - `maxBypassDispatches` 保证低权重/新加入 flow 的服务上界
  - 只有 `run.started` 成功后才 `recordServed`
- Worker 调度改为：
  - 先构造就绪候选（状态、活动 Run、线程、同成员房间、host 项目目录、依赖完成）
  - `ReadyScheduler.pick` 选一个候选
  - `startRun` 提交短事务并启动进程
  - `recordServed` 在启动成功后记账
- 设置新增 `maxBypassDispatches`（默认 5），UI 与浏览器 E2E 断言同步
- `fairOrder` 保留为无权重 stateless 兼容排序，不再参与 Worker 派发
- 新增 `tests/ready-scheduler.test.ts`，覆盖：
  - 真实 epoch 时间、持续 3000 次、2:1 权重长期份额
  - 100 Agent 稳定集合无饥饿
  - 高权重 + 低权重时 bypass 等待上界
  - 多房间轮询与阻塞房间不拖累
  - 新 flow 加入时 credit 重置但不丢等待

回归修复：房间轮询后，`codex-attach` 原先假定“第一个 Run 一定是原生执行”的测试改为等待并选择真实挂载 codex 状态的 Run；取消断言接受 `cancel_requested`/`canceled` 的合法竞态。

## 验证结果

- `npm run verify:collaboration`：PASS（typecheck / test / replay）
- `npm run verify:capabilities`：PASS（2 个模拟契约；真实 CLI not_run；`.state/capability-probes/run-2026-10-19T15-13-32-804Z-4c86d96b/report.json`）
- `npm test`：331/331
- `npm run test:preflight`：7/7 通过（`.state/preflight/run-954Fck/report.json`，163.2s）
- 本轮 `--with-native` 的 sandbox-probe 出现 native-host 请求超时；该项未参与 B02 验收，未改动 sandbox 代码
- `npm run test:replay`：通过（随 verify 记录）
- `npx tsc --noEmit`：通过
- 浏览器 E2E：45/45 通过（`.state/browser-e2e/run-VPo76F/report.json`）
- 本轮未运行 `--allow-paid` 真实模型，未启动模型请求

证据：

- `.state/collaboration-baseline/run-2026-10-20T10-01-01-244Z-bede87da/report.json`
- `.state/collaboration-baseline/run-2026-10-20T10-01-01-244Z-bede87da/typecheck.stdout.txt`
- `.state/collaboration-baseline/run-2026-10-20T10-01-01-244Z-bede87da/test.stdout.txt`
- `.state/collaboration-baseline/run-2026-10-20T10-01-01-244Z-bede87da/replay.stdout.txt`

## C04a 起点 — 房间并发槽位

- ExecutionSettings 新增 maxConcurrentRunsPerRoom（默认 4）
- Worker.dispatchCandidates 按实际活动 Run 的 roomId 计数：
  - 房间达到上限后该房间其余 Run 保持 queued
  - 其他房间/其他成员不受影响（房间槽位与全局 concurrency 叠加）
- 运行设置 UI 新增「房间并发运行上限」；浏览器 E2E 断言可见
- 新增 tests/room-concurrency.test.ts 1 项：同房间第二个 Run 等待第一个完成
- 新增 packages/protocol/src/resource-lease.ts 与 resource_leases 投影表；DATABASE_VERSION 升至 15
- 新增 apps/server/src/resource-manager.ts：
  - canonical key 规范化（Windows 大小写/分隔符）
  - acquire 排他 + capacity；quarantined 资源拒绝复用
  - release 必须提供 remainingProcesses=0 的 cleanupProof
  - quarantine 与 restart 恢复：旧 active 租约无清理证明时隔离
- Worker 对 host project key 获取持久 project 租约；终态释放或隔离，重启恢复隔离旧租约
- 新增 tests/resource-lease.test.ts 2 项：键排他/清理证明、隔离阻断/重启隔离
- 新增 resource.release owner 命令：quarantined/active 租约可在提供 remainingProcesses=0 cleanupProof 后释放并恢复复用
- release 对仍有受控进程返回 cleanup_unproven，不误放行
- 资源租约测试扩展：隔离租约解除需要可信证据、释放后 kanonical key 可重新获取
- 房间并发槽位改为按持久 Run 状态（running/waiting_input）统计，其他 Worker 进程的活动运行同样占槽位
- 新增 room-concurrency 1 项测试：外部/另一 Worker 持久 running Run 占满房间时本 Worker 保持 queued
- 新增 GET /api/rooms/:id/resource-leases
- 集成面板新增「资源租约」区：kind/状态/canonicalKey/holderRun/capacity，quarantined/active 可填写清理证据后 release
- AgentSession 持久 session 租约：Worker 启动带 agentSessionId 的 Run 前 acquire kind=session、capacity=1 的租约；终态释放/隔离
- 与 runs_agent_session_active 唯一索引互补：索引阻止同会话并发活动 Run，租约提供跨进程审计与崩溃隔离证据
- 新增 resource-lease 测试：session 租约排他、清理证明释放、释放后可复用
- 新增 resource.reserve owner 命令：按 kind/canonicalKey/capacity 预留 port/database 等资源，可选 leaseMs
- resourceLeaseKindSchema 新增 database；owner 可预留/释放，Agent 无权调用
- 新增 resource-lease 测试：port 容量排他、database capacity=2、owner 权限、释放后重新预留
- 租约 TTL：resource.reserve 可带 leaseMs；Worker.tick 调用 expireResourceLeases，将过期 active 租约标记 revoked 并写 resource.released
- 新增 resource-lease 测试：TTL 过期后 revoke、不可再 release、同 key 可重新预留
- 集成面板「资源租约」新增预留入口：owner 可填 kind/key/capacity/租约分钟，调用 resource.reserve 并刷新列表
- 尚未完成：真实进程树清理证明、自动解除隔离策略## E01 起点 — 有界可观测指标

- 新增 apps/server/src/metrics.ts：collectMetrics/metricsText
- 指标覆盖：
  - queueDepth / activeRuns / oldestPendingAgeMs
  - unknownRuns / unknownIntegrations / integrationConflicts
  - pendingWakes / pendingDeliveries / unknownBatches
  - budgetReservedUsd / unknownCostReservations / subscriptions
- 新增 GET /api/metrics：
  - owner 认证
  - JSON 默认；Accept: text/plain 或 ?format=prometheus 返回 Prometheus 文本
  - 不引入 runId 等高基数 label
- 新增 tests/metrics.test.ts 1 项：计数正确、Prometheus 文本、未认证 401
- UsagePanel 新增「协作指标」卡：队列深度、活动运行、待唤醒、待投递、未知集成、集成冲突、预算预留、未知成本预留
- 浏览器 E2E 用量面板断言新增「协作指标」
- traceId 串联：命令执行生成 traceId，写入 Run/Task/Artifact/Integration；事件 metadata 从实体 traceId 派生
- wake 派发的 Run 继承 source event traceId；artifact 继承 run traceId；integration 继承 artifact traceId
- 新增 GET /api/rooms/:id/traces/:traceId：返回共享 traceId 的 durable 事件
- 新增 tests/trace.test.ts：task.create→task.created/run.created 同 trace、未认证 401
- Worker 在 startRun/finish 记录 startedAt/finishedAt
- metrics 新增 enqueueToStartAvgMs / enqueueToStartP95Ms / runDurationAvgMs
- UsagePanel 指标卡展示平均排队→启动、P95 排队、平均运行时长；浏览器 E2E 断言可见
- Run 详情新增「追踪链路」：展示 traceId 与最近 12 个同 trace durable 事件（type/seq/时间）
- 浏览器 E2E 运行详情断言新增「追踪链路」
- metrics 新增 enqueueToStart/runDuration 延迟直方图：bucket 100/500/1000/5000/30000/+Inf 以及 count
- Prometheus 文本输出 `tempt_room_*_bucket{le=...}`；metrics test 断言 bucket/count
- Run 详情追踪链路按 aggregate 分组为可折叠树（room/task/run/artifact 等，最近 30 个事件）
- 用量面板指标卡新增「排队延迟分布」横向条形图（100/500/1000/5000/30000/+Inf）
- 浏览器 E2E 断言新增「排队延迟分布」
- 尚未完成：实时图表轮询历史、trace 跨房间时钟对齐## D04a — 用量样本去重与统一聚合

- 新增 packages/protocol/src/usage.ts：UsageSample（provider/session/turn/request/scope/counterEpoch/tokens/cost/source）
- 新增 apps/server/src/usage.ts 纯聚合器：
  - requestId/turnId 确定性身份去重，重复通知只计一次
  - run/last-request 样本跨请求累加，不再覆盖
  - session-total 按 session+counterEpoch 单调差分；epoch 变化从新基线开始，不产生负数
  - 缺失指标保持 undefined 并标记 unknown，不与 0 混淆
- 新增 usage_samples 投影表与 usage.recorded 事件；DATABASE_VERSION 升至 13
- Worker 每次适配器 usage 输出生成确定性 UsageSample 事件，与 run.updated 同事务
- API GET /api/rooms/:id/usage-samples
- 新增 tests/usage-ledger.test.ts 3 项：去重/跨 Run 累加、session delta 与 reset、unknown 指标
- 新增 packages/protocol/src/budget-reservation.ts：reserved/settled/released/unknown
- 新增 budget_reservations 投影表与 budget.reserved/budget.updated 事件；DATABASE_VERSION 升至 14
- Service.enqueue 在 run.created 前原子预留房间费用预算：
  - 仅当房间 roomCostBudgetUsd > 0 且 Run 有 costBudgetUsd 时预留
  - spent(usageByGeneration)+held(reserved/unknown)+本次估算 超过房间预算立即 429，事务回滚
- Worker.finish 结算预留：有可信 costUsd → settled(actual)，无成本 → unknown 继续占用额度
- budget.reconcile owner 命令：settle/release 人工核对 unknown 预留
- API GET /api/rooms/:id/budget-reservations
- 新增 tests/budget-reservation.test.ts 2 项：并行预留互斥+已知结算、unknown 保持占用+人工释放
- 新增 GET /api/rooms/:id/usage-summary（服务端统一聚合器结果）
- UsagePanel 新增「服务端用量账本」：
  - 样本数/去重数、已知/未知输入输出与费用
  - budget reservations 列表：状态、预留/实际、来源、释放操作
  - 3 秒轮询刷新
- 浏览器 E2E 用量面板断言新增「服务端用量账本」
- ExecutionSettings 新增 unknownCostPolicy(block/allow，默认 block)
- Service.enqueue 对带 costBudgetUsd 的 Run 检查能力证据：
  - demo/api 视为已知路径；
  - 其他 provider 必须有 fingerprint 匹配的 usageScope verified_supported，否则 409 cost_unknown
  - owner 可切换 allow 显式允许未知成本执行
- 运行设置 UI 新增「未知成本策略」选择；浏览器 E2E 断言可见
- 新增 tests/unknown-cost-policy.test.ts：未验证阻止、能力验证后允许、policy allow 后允许
- 用量账本新增「导出 CSV」：导出 usage 样本与预算预留（kind/id/agentId/runId/time/tokens/cost/status）
- 浏览器 E2E 断言新增「导出 CSV」
- 尚未完成：按请求级预留估算、未知费用自动停止策略细化
## M1 验收 — 并行任务确定性 fixture

- 新增 scripts/acceptance-parallel-tasks.ts：
  - `--check` 不启动任何模型，modelRequests=0
  - 绑定真实 fixture 项目并冻结 manifest
  - 两个不同 Agent 创建严格契约任务，各自在独立 workspace 写出不同交付文件
  - 发布两个可复核 patch artifact
  - owner 分别记录验收 accepted
  - 两个 artifact 通过持久 integration 队列依次 verification/staging/apply
  - 最终源项目同时包含两个 Agent 的成果，README 基线保持不变
  - 每一步检查写入 .state/acceptance-parallel-tasks/run-*/report.json
- package.json 新增 acceptance:parallel 脚本
- 新增 tests/parallel-task-acceptance.test.ts 1 项：断言两 Agent、独立 workspace、双验收、双集成 applied、组合结果可用、modelRequests=0
- 真实模型模式未启用；--real 明确报错，需沿用 E02 显式成本/授权
## D02b — 集成 staging 验证与重启对账切片

- Worker 集成处理扩展：
  - 从 artifact changes manifest 物化 staging 目录
  - 将 patch 应用到 staging，不触碰业务源目录
  - 如果任务契约带 acceptance，执行 owner 已批准的验证命令；保存 exitCode 结果摘要
  - 验证失败 → verification_failed，源文件与 artifact 均不变
  - 验证通过 → verificationId + ready_to_apply → applying → applied
  - 无验收命令时仍走 ready_to_apply → applying → applied
- Worker 启动恢复：
  - 上次进程遗留的 validating/staging/testing/ready_to_apply/applying 集成统一标记 unknown(errorCode=restart_unknown)
  - 不自动重放未知集成；artifact.integrate 对 unknown/blocked 记录返回 409，要求 owner 先审查
- integrated 依赖条件接入真实 integration：只有该任务存在 applied 集成才解锁下游；Worker 派发同时传入集成列表
- 新增 tests/integration-queue.test.ts 2 项：staging 验证成功/失败、重启 unknown 阻断
- 新增 integration.authorize owner 命令与 authorization=auto/waiting/authorized：
  - artifact.integrate 可要求 requireAuthorization，验证通过后停在 ready_to_apply/waiting，源文件不变
  - owner 授权后下一 tick 才 applying/applied
- 集成记录 verificationExitCode、verificationOutputHash、verificationEnvironment(node/platform/arch)
- 新增集成测试：ready_to_apply 等待授权、验证元数据、授权后应用
- 验证命令 argv 模式：
  - acceptance check 支持 argv 数组；argv[0] 必须在 node/npm/npx/git/python/python3/dotnet 白名单内
  - argv 模式不经 shell；非法可执行文件立即 verification_failed(errorCode=verification_command_rejected)
  - 旧 command 字符串保留 shell 兼容路径
- 验证环境记录 node/platform/arch/npm/git；staging 在成功应用后清理，失败保留供审查
- 重启集成恢复按 apply journal 分类 unknown errorCode：journal_applied / journal_incomplete / journal_rolled_back / restart_unknown，仍不自动重放
- 新增 3 项集成测试：argv 验证成功与 staging 清理、argv 白名单拒绝、journal 证据分类
- 新增 integration.reconcile owner 命令：
  - mark_applied：仅当 errorCode=journal_applied 时允许，标记集成 applied 并补写 artifact.applied
  - retry：unknown/blocked 记录回到 queued + authorization=waiting，需再次 owner 授权才应用
  - abandon：标记 blocked(owner_abandoned)
- 集成测试新增 journal 核对 mark_applied 与 retry 重新授权路径
- 集成队列 UI：新增「集成」面板页，展示状态、授权等待、artifact、verificationId、errorCode，并提供授权应用/标记已应用/重试/放弃操作；2 秒轮询刷新
- 浏览器 E2E 移动端协作面板断言新增「集成」可见
- 新增 integration.rollback owner 命令与 artifact.rolled_back 事件：
  - 只允许 applied 集成回滚
  - 回滚前逐个校验当前文件内容仍等于 patch after 内容
  - 任一文件被用户修改 → blocked(errorCode=rollback_conflict)，不覆盖用户改动
  - 全部匹配才恢复 before 内容/删除新增文件，artifact.applied=false，集成状态 rolled_back
- 集成面板新增已应用集成的「回滚」按钮与已回滚状态
- 新增 integration-queue 1 项测试：正常回滚、冲突回滚拒绝
- Worker 重启自动对账：apply journal complete=applied 的 applying 集成直接恢复为 applied，并补写 artifact.applied(reconciledBy=journal)
  - 不再要求 owner 手动 mark_applied
  - journal_incomplete/rolled_back/restart_unknown 仍标记 unknown，不自动重放
- 集成测试更新：journal_applied 重启自动恢复 applied/artifact.applied
- ExecutionSettings 新增 stagingRetentionMs（默认 24h，0 表示不清理）
- Worker.tick 清理 root/staging 下超过保留期的目录；正在使用/清理失败的目录保留到下次扫描
- 运行设置 UI 新增「staging 保留时长（小时）」；浏览器 E2E 断言可见
- 新增 tests/staging-retention.test.ts：过期目录删除、新鲜目录保留
- 重启恢复对 incomplete apply journal 执行安全自动回滚：
  - 校验当前文件仍等于 patch after 内容或已等于 before 内容
  - 任一文件不符合 → journal_rollback_conflict，不覆盖用户改动
  - 全部匹配 → 从 journal backups 恢复 before 内容/删除新增文件，写 complete=reconciled-rollback
  - 集成保持 unknown(errorCode=journal_recovered_rollback) 等待 owner 复核，不自动重新应用
- 新增 integration-queue 1 项测试：不完整 journal 重启回滚源文件
- 尚未完成：旧 command shell 路径移除、journal 自动回滚失败的人工恢复 UI
## D02a — 持久集成队列主体

- 新增 packages/protocol/src/integration.ts：Integration schema 与状态机（queued/validating/staging/testing/ready_to_apply/applying/applied/conflict/verification_failed/unknown/blocked）
- 新增 integrations 投影表、integration.queued/integration.updated 事件；DATABASE_VERSION 升至 12
- 新增 artifact.integrate owner 命令：
  - 只做鉴权、交付物绑定和幂等预检
  - 返回 integrationId + queued/applied 状态，不在命令事务里执行 Git/文件操作
  - 同一 artifact 已有进行中/已应用集成时返回原集成，不重复入队
- Worker 新增持久集成队列处理：
  - 单 Worker 按 createdAt 串行处理一条
  - 有活动 Run 时暂停应用
  - validating → 调用现有带 journal/备份的 workspaces.apply → applied
  - apply_conflict/source_changed/stale_* 归为 conflict；recovery_required 为 blocked；rollback_incomplete/其他为 unknown
  - 应用失败保留原 artifact 与源文件
- API GET /api/rooms/:id/integrations；交付物预览新增「入队异步集成」入口（保留旧同步路径兼容）
- 新增 tests/integration-queue.test.ts 2 项：异步入队幂等应用、源文件并发修改归为 conflict 且不改源
- 尚未完成：staging 项目/验证命令执行与 verificationId、ready_to_apply 授权门、journal 对账恢复、旧同步 artifact.apply 的 SDK/UI 移除
## D03b — 验收状态 UI

- 任务卡片显示严格任务的「执行完成/进行中」与「验收待验收/已通过/已拒绝」双状态
- 任务完成后 owner 可直接「验收通过」或「验收拒绝」：
  - 通过：携带该任务现有产物 ID，写 task.verification.recorded
  - 拒绝：写 rejected 验收记录
- 验收按钮只在 strict 且执行 completed 且未通过时出现，避免把执行完成误显示成验收通过
- 验收历史：Task.verificationHistory 保留最近 20 条 verification record（outcome、recordedAt、verificationId、reason），lastVerification 同步最新
- 任务卡片新增「验收历史」折叠列表，显示最近 5 条通过/拒绝记录
- 修订/交接失效传播扩展：reviseTaskTree 同时遍历 dependencyRequirements，严格依赖后继的 acceptanceStatus 统一回到 pending、版本递增
- 新增测试：rejected→accepted 历史与时间戳、上游修订使 accepted 下游失效
- 尚未完成：独立 verifier 进程与完整环境记录、验收历史分页/导出、integrated 条件真实集成状态已接入但历史未在 UI 展示
## D03a — 执行完成与验收分离

- 新增 packages/protocol/src/task-acceptance.ts：
  - acceptanceStatus: not_required/pending/accepted/rejected
  - dependencyRequirement: execution/accepted_artifact/integrated
  - taskVerificationRecord（verificationId、outcome、产物/哈希、命令引用、exitCode、输出哈希）
- Task 新增 strict/objective/acceptanceChecks/allowedPaths/requiresAcceptance/requiresIntegration/acceptanceStatus/acceptedArtifactIds/verificationId/baselineRef/dependencyRequirements/lastVerification
- 带 contract 的 task.create 自动进入严格模式：冻结验收项、allowedPaths、基线引用、依赖要求，acceptanceStatus=pending
- 新增 task.verification.record owner 命令：
  - 校验 taskVersion 与产物归属
  - accepted 才写 acceptedArtifactIds 与 acceptanceStatus=accepted
  - 写 task.verification.recorded 事件
- Worker.finish 不再把严格任务自动视为已验收；completed 只到 pending，失败/取消为 rejected
- task.complete 外部摘要、task.revise、task.handoff 会使严格验收失效回到 pending
- 新增 dependencyRequirementsReady 纯函数，Worker 派发同时检查 execution/accepted_artifact/integrated；integrated 在 D02 接入前保持阻塞
- 新增 tests/task-acceptance.test.ts 2 项：依赖条件纯函数、执行完成未验收时下游不派发、验收后派发、修订使验收失效
- 尚未完成：独立 verifier 进程与验证环境记录、UI 验收按钮、integrated 条件、下游失效传播广度
## D01b — 项目绑定 UI

- 房间设置新增「项目绑定」区域：
  - 项目绝对路径输入与 sandbox/host 模式多选
  - 绑定按钮调用 project.bind
  - 展示版本、源目录、manifest 前缀、文件数
  - 错误内联显示
- 任务创建表单：
  - 加载当前房间绑定列表，可按版本选择
  - 选择后提交 projectBindingId/bindingVersion，projectPath 隐藏并由服务端取绑定源目录
  - 未选择时保留原项目绝对路径/仅讨论流程
- 浏览器 E2E 房间设置步骤新增「项目绑定」可见性断言
- TaskForm 在选择项目绑定时展示 baseline manifest 文件数/字节；浏览器/单元验证通过
- 尚未完成：绑定撤销/编辑 UI、host worktree 显式选择
## D01a — 项目绑定与独立工作区

- 新增 packages/protocol/src/project-binding.ts：ProjectBinding 严格 schema（sourcePath、baseCommit、manifestHash、allowedExecutionModes、verificationRefs、version）
- 新增 apps/server/src/project-manifest.ts：
  - canonicalProjectPath 解析别名并拒绝符号链接/重解析点根目录
  - buildProjectManifest 递归扫描实际文件内容，排除 .git/node_modules/dist/.state 等，生成排序文件清单与 manifestHash
  - projectBaseCommit 读取 Git HEAD（可选）
- 新增 project_bindings 投影表与 project.bound/project.updated 事件；DATABASE_VERSION 升至 11
- project.bind owner 命令：冻结实际文件 manifest、允许执行模式与验证命令引用；版本递增；Agent 禁止绑定
- Task 增加 projectBindingId/bindingVersion/baselineManifestHash；task.create 校验绑定与版本，projectPath 取自绑定源目录
- Run 增加 projectBindingId/bindingVersion/sourceCommit/dirtyBaselineHash/workspacePath；Worker 在任务执行前记录绑定字段与当前文件基线，两 Run 使用不同独立 workspace
- API GET /api/rooms/:id/project-bindings
- 新增 tests/project-binding.test.ts 3 项：manifest 冻结/编辑变更/重解析拒绝；Task 版本绑定与 Agent 禁权；两 Run 独立工作区且源目录不变
- 尚未完成：project.bindings 的 TaskForm/RoomForm UI、绑定编辑/撤销、host worktree 显式模式、集成阶段旧绑定版本拒绝
## M1 起点：Task 契约

- 新增 packages/protocol/src/task-contract.ts：
  - objective、projectBinding(id/version/baselineRef/manifestHash/allowedPaths)
  - acceptance 数组（描述、验证命令、verifierVersion、verifierHash）
  - expectedArtifacts、dependencies（execution/accepted_artifact/integrated）
  - authorizedExecutor、limits、failureHandling、collaborationBoundary
- Task 增加可选 contract；task.create/task.revise 接受契约并冻结；契约依赖必须引用同房间存在的任务且版本不超前
- 新增 tests/task-contract.test.ts 3 项：严格 schema、契约持久化/修订版本、依赖校验
- 尚未完成：项目绑定/基线 manifest 生成、独立工作区、验收/集成分离、真实双 Agent 并行交付脚本
## 未完成 / 下一波

- B05a 能力探针与三态结果格式（M0 前移切片）
- B03/B04 会话生命周期、订阅投递与唤醒
- B05b 能力证据持久化/UI/路由
- M1 双 Agent 固定契约任务闭环
- M1 双 Agent 固定契约任务闭环：Task 契约、独立工作区、验收/集成分离、并行验收脚本

## 约束提醒

- 本波次未迁移日常数据库，未启动真实模型，未修改账号或模型配置。
- `maxBypassDispatches` 是派发次数上界，不是 CPU/Token/完成时间 WFQ；真正的加权资源份额仍需后续立项。
- 审计导出从 seq 0 开始读取当前 event log；historyFloor 以响应头展示，不重写旧事件。

## E03 起点 — CI release preflight

- `.github/workflows/ci.yml` 新增 release-preflight job（needs: verify）
- 运行 `npm run test:preflight`：typecheck、单测、secret scan、build、SDK consumer、browser E2E、production smoke
- 上传 `.state/preflight/**` 与 `.state/browser-e2e/**` 作为 release evidence artifact，保留 14 天
- 尚未完成：真实模型双 CLI 实验的 CI 条件门禁、跨平台（非 Windows）隔离验证

## C02 起点 — 工具前置授权策略模块

- 新增 apps/server/src/tool-authorization.ts：authorizeTool 纯函数
  - agent 调用必须有 run fence（runId/generation/executionId）
  - 写工具要求 fingerprint 匹配的 preToolGate=verified_supported
  - 参数路径拒绝 traversal、Windows ADS、保留设备名
  - 只收窄既有 roomToolPolicy/allowlist，不扩大权限
  - 返回结构化 decision/reason/argumentDigest
- 新增 tests/tool-authorization.test.ts 2 项
- 尚未完成：接入真实 MCP/ACP/host 工具入口、授权记录持久化、批准/取消竞态处理和 CLI 不可拦截缺口标注

## B09 起点 — 讨论窗口估算

- 新增 apps/server/src/discussion-windows.ts：
  - 按 provider + adapterFingerprint + model + taskClass 分桶
  - 使用真实执行时长样本计算经验分位数（P95），样本上限 50
  - 冷启动默认 90s，clamp 15s–10min
  - EWMA 仅作为独立平滑值暴露，不冒充 P95
- 新增 tests/discussion-windows.test.ts 2 项：冷启动/P95/clamp、桶隔离与 EWMA
- discussion.start 持久化 DiscussionRound（openedSeq/openedAt/windowDeadline/slotIds/quorum），写 discussion.round.opened
- 轮次推进先 close 旧 round（closedSeq/closedAt/closeReason=round_complete）再 open 新 round
- discussion 结束/停止时 close 当前 round（closeReason=结束原因）
- 新增 tests/discussion-rounds.test.ts：open/close 生命周期与窗口截止字段
- settleDiscussion 检测迟到结果：run 已终态且属于更早轮次或讨论已结束
- 写 discussion.round.late.received：绑定原 round/run/agent/generation/status，round 标记 late；不重新打开轮次、不修改已冻结决议
- 同一 run 的 late 事件幂等
- 新增 discussion-rounds 测试：late 事件绑定原轮次且不重复
- 尚未完成：Worker 按 windowDeadline 展示/关闭、关闭后结果集合冻结、p95 窗口接入调度

## B08 起点 — 上下文分段与字节预算

- 新增 apps/server/src/context-segments.ts：
  - 四段输入：objective / accepted constraints / related task / history tail
  - UTF-8 字节预算；目标/约束/关联任务不被历史尾部挤掉
  - 固定段超限抛 context_segment_too_large，不静默截断后标记已消费
  - history 仅在预算内保留最近消息，记录 omitted/truncated
  - 每段记录 fromSeq/throughSeq/hash/bytes
- 新增 GET /api/runs/:id/context-segments 返回确定性分段预览
- 新增 tests/context-segments.test.ts 3 项；trace 测试扩展路由断言
- Worker.context 使用 buildContextSegments 计算 history 段实际字节/省略条数，替换写死的「最近 40 条」说明；仍保留原有消息渲染与决策约束
- 尚未完成：prompt 直接渲染四段内容、逐段外部读取版本证据、订阅增量段
