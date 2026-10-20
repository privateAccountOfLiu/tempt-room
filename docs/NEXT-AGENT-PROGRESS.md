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
source HEAD: 6e9ce3388f0de82a7bb8213c3c1b4852d7e8a10f (dirty)
typecheck: passed
test: passed
replay: passed
report: .state/collaboration-baseline/run-2026-10-20T04-42-30-868Z-db577138/report.json
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
- 尚未完成：tool-boundary/steer 模式、外部 Agent 回执、unknown/expired 对账、UI 输入批次视图
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
### B04 — 订阅投递与幂等唤醒主体

- 新增 apps/server/src/wake-policy.ts：纯触发策略；typing/partial/ACK/audit/状态/自身消息默认不唤醒，显式点名与 assigned-task 触发
- 新增 apps/server/src/inbox.ts：InboxService 扫描订阅、持久 InboxDelivery 与 WakeIntent；确定性 ID + B02 唯一键保证重复扫描不重复投递
- subscription.set 命令接入：owner 设置订阅，校验房间、AgentSession、成员资格与 scanSeq
- Worker.tick 接入订阅扫描；扫描水位用 head 记忆避免自身 subscription.updated 造成空转
- 队列上限：maxInboxDeliveries / maxInboxBytes；超限返回 429 inbox_full 并在事务内回滚本次扫描
- 权限/会话/成员撤销立即阻断；scanSeq 与 pending delivery 分开保存
- 新增 tests/inbox-subscription.test.ts 3 项：唤醒白名单、幂等扫描、队列上限与禁用
- 新增 dispatchPendingWakes：pending WakeIntent 为每个 AgentSession 生成一个 queued Run；重复 tick 不重复派工；active Run 存在时保持 pending
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
- 尚未完成：额外对账轮次计费、总结独立授权额度与 UI
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
- `npm test`：330/330
- `npm run test:preflight`：7/7 通过（`.state/preflight/run-08zo4k/report.json`，153.1s）
- 本轮 `--with-native` 的 sandbox-probe 出现 native-host 请求超时；该项未参与 B02 验收，未改动 sandbox 代码
- `npm run test:replay`：通过（随 verify 记录）
- `npx tsc --noEmit`：通过
- 浏览器 E2E：45/45 通过（`.state/browser-e2e/run-ZupOU0/report.json`）
- 本轮未运行 `--allow-paid` 真实模型，未启动模型请求

证据：

- `.state/collaboration-baseline/run-2026-10-20T04-42-30-868Z-db577138/report.json`
- `.state/collaboration-baseline/run-2026-10-20T04-42-30-868Z-db577138/typecheck.stdout.txt`
- `.state/collaboration-baseline/run-2026-10-20T04-42-30-868Z-db577138/test.stdout.txt`
- `.state/collaboration-baseline/run-2026-10-20T04-42-30-868Z-db577138/replay.stdout.txt`

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
- 尚未完成：验证环境版本/argv 白名单、ready_to_apply 独立授权门、staging 清理与 journal 对账恢复、旧同步 apply 移除
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
- 尚未完成：真实 verifier 命令执行环境、exitCode/输出哈希自动记录、验收历史列表、integrated 条件
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
- 尚未完成：绑定撤销/编辑 UI、host worktree 显式选择、TaskForm 展示绑定基线文件清单
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
