# 实施计划闭环审计（v1.1）

更新：2026-10-21
对应计划：[next-agent-implementation-plan-v1.1.md](../next-agent-implementation-plan-v1.1.md)

本文件按 A–F 波次逐项给出状态与证据。状态定义：

- **完成**：实现 + 自动化测试 + 运行/发布证据
- **可选未实施**：计划标注 P2/按需，不影响核心闭环
- **外部边界**：依赖宿主客户端或第三方协议，房间侧无法实现，已在能力矩阵明示

## A 批

| 波次 | 状态 | 证据 |
| --- | --- | --- |
| A00 固化代码与验证证据 | 完成 | `docs/NEXT-AGENT-PROGRESS.md`、preflight 报告 |
| A01 审计分页截断 | 完成 | `tests/audit-export.test.ts`（覆盖全部分页与 watermark） |
| A02 加权调度饥饿 | 完成 | `tests/fair-scheduler.test.ts` |
| A03 host 变更归因 / 共享提交 | 完成 | `tests/host-workspace-isolation.test.ts`（内容哈希二次编辑、独立 host 工作区） |

## B 批

| 波次 | 状态 | 证据 |
| --- | --- | --- |
| B01 协议对象 | 完成 | `packages/protocol/src/collaboration.ts`、event replay 契约测试 |
| B02 投影与迁移 | 完成 | DB v16、`tests/event-replay.test.ts`、preflight replay |
| B03 可恢复 AgentSession | 完成 | `tests/session-inbox.test.ts`、`tests/session-scope.test.ts` |
| B04 订阅/唤醒/队列 | 完成 | `tests/inbox-subscription.test.ts`、`tests/wake-chain.test.ts` |
| B05 能力证据矩阵 | 完成 | `tests/capability-evidence.test.ts`、`tests/adapter-capabilities.test.ts` |
| B06 输入批次与边界补投 | 完成（Codex 真实 steer） | `tests/input-delivery.test.ts`、`tests/steer-channel.test.ts`、`tests/steer-delivery.test.ts`、[B06-REAL-STEER.md](B06-REAL-STEER.md) |
| B07 外部 MCP/runner 恢复 | 完成 | `tests/session-inbox.test.ts`、`tests/runner-output.test.ts`、runtime cursor reset |
| B08 上下文/外部读取版本 | 完成 | `tests/context-segments.test.ts`、`tests/external-reads.test.ts`、`tests/api-output.test.ts` |
| B09 独立轮次窗口/迟到结果 | 完成 | `tests/discussion-windows.test.ts`、`tests/discussion-rounds.test.ts` |

## C 批

| 波次 | 状态 | 证据 |
| --- | --- | --- |
| C01 跨 Run 操作去重 | 完成 | `tests/native-operations.test.ts`、`tests/recovery-proof.test.ts` |
| C02 工具前置策略 | 完成 | `tests/tool-authorization.test.ts`、`tests/acp-permission.test.ts`、`tests/tool-approval.test.ts`；宿主 CLI 自带权限 UI 属外部边界 |
| C03 未知结果核对/续接 | 完成 | `tests/native-operations.test.ts`、`tests/external-context.test.ts` |
| C04 租约与进程树证明 | 完成 | `tests/resource-lease.test.ts`、`tests/cleanup-proof.test.ts`、`tests/job-launcher.test.ts`；`npm run build`/preflight 自动构建 launcher，缺 dotnet 自动回退 taskkill+CIM（[JOB-LAUNCHER.md](JOB-LAUNCHER.md)） |

## D 批

| 波次 | 状态 | 证据 |
| --- | --- | --- |
| D01 项目映射/独立工作区 | 完成 | `tests/project-binding.test.ts`、`tests/workspaces.test.ts` |
| D02 集成队列/staging | 完成 | `tests/integration-queue.test.ts`、`tests/artifact-application.test.ts` |
| D03 执行/验收/依赖分离 | 完成 | `tests/acceptance.test.ts`、`tests/task-acceptance.test.ts`、`tests/task-contract.test.ts` |
| D04 用量去重/预算预留 | 完成 | `tests/usage-ledger.test.ts`、`tests/budget-reservation.test.ts`、`tests/budget-worker.test.ts` |

## E 批

| 波次 | 状态 | 证据 |
| --- | --- | --- |
| E01 UI/可观测性 | 完成 | 浏览器 E2E 45 项、`.state/browser-e2e/run-wj7Ax5` |
| E02 双真实 CLI 实验 | 完成 | [E02-REAL-EXPERIMENT.md](E02-REAL-EXPERIMENT.md)、[evidence/e02-real-dual-agent-report.json](evidence/e02-real-dual-agent-report.json) |
| E03 CI/release 证据 | 完成 | `.github/workflows/ci.yml`、preflight 8/8 `.state/preflight/run-kUH23W` |
| E04 文档与能力完成定义 | 完成 | [CAPABILITY-COMPLETION.md](CAPABILITY-COMPLETION.md)、本文件 |

## F 批（P2，按需）

| 波次 | 状态 | 说明 |
| --- | --- | --- |
| F01 EventStore/Transport 接口 | 完成 | `apps/server/src/ports/event-store.ts`、`agent-transport.ts`；Store/Service/Worker 与核心辅助模块经端口；`tests/event-store-transport-contract.test.ts` 文件库/内存库同契约、transport fixture 状态机 |
| F02 导出/导入/可靠外发 | 完成 | `tests/room-export.test.ts`、`tests/room-import.test.ts`、`tests/outbound.test.ts`、`tests/outbound-audit.test.ts` |
| F03 AgentScope Service 适配器 | fixture 完成（可选） | `apps/server/src/ports/agent-scope.ts` 映射 session/output/input/cancel/outcome；`tests/agent-scope-transport.test.ts` fixture 通过；真实 AgentScope 版本未锁定，能力保持 unverified，不宣称真实 Service 集成 |

## 外部边界（明示，不作为未完成核心项）

- 宿主 CLI 自带权限 UI：客户端行为，房间侧无法拦截；已通过 `interceptionGaps` 明示，并提供 external MCP 写工具 owner 审批桥。
- DeepSeek ACP / Claude 无运行中 steer 协议：Codex 已真实验证；ACP/Claude 仅支持下一轮投递。
- Job Object launcher 的 dotnet 构建已纳入 `npm run build` 与 preflight；缺 SDK 时警告并自动回退 taskkill+CIM（[JOB-LAUNCHER.md](JOB-LAUNCHER.md)）。
- MiniMax Code 以外部 MCP 接入（provider `minimax` 强制 external）；真实 MCP 注册需在 MiniMax Code 应用内执行一次（[MINIMAX-INTEGRATION.md](MINIMAX-INTEGRATION.md)）。

## 最终验证

- 单元/集成测试：428/428
- 发布前门禁：8/8（含 job-launcher 构建步骤；run-V7LSm4）
- 浏览器 E2E：45/45
- 生产冒烟：10/10
- 协作基线：PASS（`.state/collaboration-baseline/run-2026-10-21T01-43-40-148Z-7e231f3d`）
- 实时服务：http://127.0.0.1:4317，PID 26196，数据库 v16

结论：A–E 批核心闭环完成；F 批除 P2 可选项外完成；剩余均属外部边界或按需可选项。
