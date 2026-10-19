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
source HEAD: 011ac59b65c0872806e6d4fddb91c1dc07465d5c (dirty)
typecheck: passed
test: passed
replay: passed
report: .state/collaboration-baseline/run-2026-10-19T15-57-40-945Z-5adc4514/report.json
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
- `npm test`：305/305
- `npm run test:preflight`：7/7 通过（`.state/preflight/run-8fYmvH/report.json`，256.3s）
- 本轮 `--with-native` 的 sandbox-probe 出现 native-host 请求超时；该项未参与 B02 验收，未改动 sandbox 代码
- `npm run test:replay`：通过（随 verify 记录）
- `npx tsc --noEmit`：通过
- 浏览器 E2E：45/45 通过（`.state/browser-e2e/run-NaqQqK/report.json`）
- 本轮未运行 `--allow-paid` 真实模型，未启动模型请求

证据：

- `.state/collaboration-baseline/run-2026-10-19T15-57-40-945Z-5adc4514/report.json`
- `.state/collaboration-baseline/run-2026-10-19T15-57-40-945Z-5adc4514/typecheck.stdout.txt`
- `.state/collaboration-baseline/run-2026-10-19T15-57-40-945Z-5adc4514/test.stdout.txt`
- `.state/collaboration-baseline/run-2026-10-19T15-57-40-945Z-5adc4514/replay.stdout.txt`

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
