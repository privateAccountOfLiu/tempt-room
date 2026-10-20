# Tempt Room 能力完成定义（E04）

更新：2026-10-20（第 108 轮后）
协议版本：Room Protocol 0.1
数据库：schema v16

本文件是计划 E04 的能力完成定义：只有同时满足「实现 + 自动化验证 + 运行证据」才标为完成；缺少任一条件标为部分完成；依赖外部授权或原生能力的明确标为未完成，不用演示覆盖真实能力。

## 完成

| 能力 | 实现 | 自动化证据 | 运行证据 |
| --- | --- | --- | --- |
| 事件日志 / 回放 / 投影重建 | `store.ts`、`event-projections.ts` | replay + replay-fixture 测试、preflight replay | 每日 DB v9→v16 迁移 |
| 幂等命令与确定性 ID | `service.ts`、`store.ts` | unit-test 全量 399 项 | `/api/commands` 在线可用 |
| 房间 / 成员 / 消息 | `service.ts`、`app.ts`、UI | browser E2E 45 项 | 本地房间在线 |
| 协作会话 / 下一轮输入 | `sessions.ts`、`worker.ts` | session/inbox 测试 | `room_inbox` + `session_inbox` |
| 订阅 / 批量输入 | `inbox.ts`、`input-delivery.ts` | subscription/input 测试 | `/api/rooms/:id/subscriptions` |
| 能力矩阵（demo） | `adapter-capabilities.ts` | capability-evidence 测试 | 能力 API + UI 面板 |
| 工具授权（managed / external / ACP） | `tool-authorization.ts`、`acp.ts` | tool-authorization 4 项 + acp-permission 2 项 | warn/enforce 设置与审计事件 |
| MCP 外部工具桥接 | `worker.agentTool` | 外部工具授权桥接测试 | 插件 MCP `session_inbox/session_ack` |
| 项目绑定 / 独立工作区 | `workspaces.ts`、`worker.ts` | project-binding 4 项 | 绑定 API 与 UI |
| 资源租约（project/session/port/db） | `resource-manager.ts` | resource-lease 6 项 | `/api/rooms/:id/resource-leases` |
| 资源租约 TTL / 隔离恢复 | `resource-manager.ts`、`worker.tick` | resource-lease TTL 测试 | 运行设置「隔离租约自动解除」 |
| AppContainer 清理证明 | `worker.ts` sandbox.exit 处理 | cleanup-proof 测试 | jobEmpty 持久化到 Run.cleanupProof |
| 远程/演示 Adapter 清理证明 | `worker.finish` | cleanup-proof 测试 | demo/api/a2a no-local 证据 |
| 讨论轮次 / 窗口 / 迟到结果 | `discussions.ts`、`discussion-windows.ts` | discussion-* 测试 | rounds API + UI 截止时间 |
| 上下文分段与预算 | `context-segments.ts` | context-segments 测试 | `/api/runs/:id/context-segments` |
| 外部读取版本证据（file/db/network） | `worker.ts`、`adapters.ts`、`room-import.ts` | external-reads + api-output + project-binding 测试 | Run 详情「外部读取证据」 |
| 用量 / 预算 / 指标 | `usage.ts`、`metrics.ts` | usage/metrics 测试 | `/api/metrics` + UI 图表 |
| 追踪树 / 诊断 | `app.ts`、UI | browser E2E | `/api/rooms/:id/traces/:traceId` |
| 集成 apply / journal 恢复 | `worker.ts` | integration 测试 | integrate 命令与 UI |
| 验收闸门 | `service.ts`、`worker.ts` | acceptance 测试 | 任务验收 UI |
| 单房间导出（脱敏 / artifact 内容 / 完整性哈希） | `app.ts`、`export-redaction.ts` | room-export + export-redaction 测试 | 在线 export 200 / 64 hex |
| 单房间导入（ID remap / artifact 往返） | `room-import.ts`、`app.ts`、UI | room-import 3 项 | 在线 invalid 400 |
| CI 发布前门禁 | `scripts/preflight.ts`、CI workflow | 7 步 preflight | 最近报告 `.state/preflight/run-94LQPp/report.json` |

## 部分完成

| 能力 | 已有 | 缺口 |
| --- | --- | --- |
| 真实 CLI 能力验证 | 能力状态机、指纹失效、缺口原因 | 真实 codex/claude/deepseek 会话尚未在授权环境跑通 |
| 宿主权限拦截 | ACP `session/request_permission` 已按策略允许/拒绝；MCP 写入走工具授权 | 原生 CLI 自带权限 UI 不可拦截；已在 `interceptionGaps` 明示 |
| 进程树清理 | AppContainer jobEmpty；remote/demo no-local；incomplete 证明隔离 | native host 真实进程树采集需要 Job Object / 原生 helper |
| 外部读取证据 | file/db/network 自动采集 + owner 显式命令 | artifact 内容不做秘密扫描；网络证据依赖响应头 |
| 房间导出/导入 | 事件、artifact、脱敏、ID remap | 导入的 seq/throughSeq 引用按原顺序近似；不含导入后的敏感字段重扫 |
| 真实 steer | attach 消息桥接、取消/输入投递 | 没有运行中向原生 CLI 注入 steer 的真实通道 |
| 多 Agent 真实辩论 | 讨论轮次、窗口、迟到结果、配额 | 真实模型双 Agent 实验未授权运行 |

## 未完成 / 需要授权

| 能力 | 原因 | 下一步 |
| --- | --- | --- |
| E02 真实模型双 Agent 实验 | 需要显式成本与运行授权 | 授权后按实验脚本执行并保存报告 |
| F02 可靠外发 | 需要持久化 outbox、重试、SSRF 边界 | 设计 durable outbound 后再实现 |
| native host 清理证明 | 需要 Windows Job Object 或原生 helper | 原生 helper 获取 job 进程计数 |

## 验证基线

- 单元/集成测试：399/399
- 浏览器 E2E：45/45
- 发布前门禁：7/7
- 生产冒烟：10/10
- 协作基线：PASS
- 实时服务：http://127.0.0.1:4317（PID 记录在 `docs/NEXT-AGENT-PROGRESS.md`）

## 结论

核心房间协议、协作、资源、导入导出、证据链与 UI 已完成自动化与运行验证。真实模型实验、native 进程树证明、可靠外发属于明确的外部/原生依赖，未用演示结果冒充完成。
