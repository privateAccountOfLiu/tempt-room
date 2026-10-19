# 验证矩阵（2026-10-19）

本文件把 Scheme.md 与并行协作计划的主要能力对应到当前可复现的验证方式与证据位置。所有命令都在项目根目录执行；标注“无模型”的命令不会调用任何 Agent 模型。结果来自本机实际执行，未执行的可选项明确标注为未执行。

## 一、无模型与发布门禁

| 能力 | 结果 | 验证方式 | 证据 |
| --- | --- | --- | --- |
| 类型检查 / 单元测试 | PASS（224/224） | `npx tsc --noEmit`、`npm test` | 测试输出；含 replay/context/audit/budget/UI 测试 |
| 运行级 Token / 费用硬预算 | PASS | `npm test`（`tests/budget.test.ts`、`tests/budget-worker.test.ts`）；设置对话框浏览器 E2E | 测试输出 |
| 显式失败重试 `run.retry` | PASS | `npm test`（`tests/run-retry.test.ts`） | 测试输出 |
| 讨论 quorum / 缺席 / 迟到推进 | PASS | `npm test`（`tests/discussion-quorum.test.ts`） | 测试输出 |
| 房间/成员待处理运行上限 | PASS | `npm test`（`tests/queue-limits.test.ts`） | 测试输出 |
| EWMA 自适应超时 | PASS | `npm test`（`tests/adaptive-timeout.test.ts`） | 测试输出 |
| 最近服务公平排序 / aging | PASS | `npm test`（`tests/fair-scheduler.test.ts`） | 测试输出 |
| 消息来源信任级 / 注入标注 | PASS | `npm test`（`tests/trust.test.ts`） | 测试输出 |
| 房间累计预算入口熔断 | PASS | `npm test`（`tests/room-budget.test.ts`） | 测试输出 |
| 超时草稿降级 | PASS | `npm test`（`tests/partial-timeout.test.ts`） | 测试输出 |
| 失败分类与可解释建议 | PASS | `npm test`（`tests/failure.test.ts`） | 测试输出 |
| 上下文信任序列化 / 注入数据测试 | PASS | `npm test`（`tests/context-format.test.ts`） | 测试输出 |
| 20 Agent 公平性压力 | PASS | `npm test`（`tests/fairness-pressure.test.ts`） | 测试输出 |
| 随机 seq 故障注入重建 | PASS | `npm run test:faults` | 测试输出；CI 配置已包含 |
| Agent 权重 / 加权公平调度 | PASS | `npm test`（`tests/fair-scheduler.test.ts`） | 测试输出 |
| 双连接并发写入门禁 | PASS | `npm run test:concurrency` | 测试输出；CI 配置已包含 |
| 单成员每分钟运行配额 | PASS | `npm test`（`tests/rate-limit.test.ts`） | 测试输出 |
| 受限沙箱聊天自动重试 | PASS | `npm test`（`tests/auto-retry.test.ts`） | 测试输出 |
| 可配置工具结果上限 | PASS | `npm test`（`tests/tool-output-limit.test.ts`） | 测试输出 |
| 按 Agent 房间工具权限 | PASS | `npm test`（`tests/tool-policy.test.ts`） | 测试输出 |
| 可配置上下文消息窗口 | PASS | `npm test`（`tests/context-window.test.ts`） | 测试输出 |
| 移动端布局（390×844） | PASS | 浏览器 E2E `mobile-layout` | `.state/browser-e2e/`、`docs/screenshots/ui-mobile-20261019.png` |
| 快捷键帮助面板 | PASS | 浏览器 E2E `shortcut-help` | 上述浏览器报告 |
| 侧边栏房间搜索 | PASS | 浏览器 E2E `room-search` | 上述浏览器报告 |
| 移动端协作面板 | PASS | 浏览器 E2E `mobile-collaboration-panel` | `docs/screenshots/ui-mobile-panel-20261019.png` |
| 消息密度切换 | PASS | 浏览器 E2E `density-toggle` | 上述浏览器报告 |
| 讨论历史与只读详情 | PASS | 浏览器 E2E `discussion-history` | 上述浏览器报告 |
| 运行详情与工具操作可见性 | PASS | 浏览器 E2E `run-detail-modal` 步骤 | 上述浏览器报告 |
| 事件回放 / fencing / partial / 上下文契约 | PASS（63/63） | `npm run test:replay` | 测试输出 |
| 房间事件审计导出（NDJSON） | PASS | `npm test`（`tests/audit-export.test.ts`） | 测试输出 |
| 仓库密钥扫描 | PASS（0 finding） | `npm run check:secrets` | `.state/secret-scan/latest.json` |
| 预发布全链路 | PASS（9/9） | `npm run test:preflight -- --with-native` | `.state/preflight/run-2coocT/report.json` |
| 浏览器端到端 / URL 与标题恢复 / 草稿与对账 UI / 用量看板 | PASS（45/45） | `npm run test:browser` | `.state/browser-e2e/run-7p63FZ/report.json`、`docs/screenshots/ui-polish-20261019.png` |
| 房间用量看板（Token / 费用估值 / 未知用量） | PASS | 浏览器 E2E `usage-tab` 步骤 | 上述报告 |
| 生产构建 + 重启恢复 + Cookie 保持 | PASS（10/10） | `npm run test:production` | `.state/production-smoke/run-HxXLnR/report.json` |
| Windows 原生沙箱探测 | PASS（23/23） | `npm run test:sandbox` | `.state/diagnostics/sandbox.json` |
| 连接器进程树 | PASS（9/9） | `npm run test:connectors` | `.state/connector-probes/` |
| 原生 Agent 协议预检 | PASS（codex/claude/deepseek） | `npm run test:agent-protocols -- --check` | `.state/native-pipecompat-20261017/diagnostics/agent-protocols.json` |
| 外部 Agent 自动值守（假 CLI） | PASS | `npm run test:runner` | `.state/runner-smoke/` |
| 发布就绪汇总 | 退出码 0（可选沙箱密钥档未执行） | `npm run report:readiness` | `docs/RELEASE-READINESS.md` |
| Git 基线 | PASS | `git init -b main`、首个提交 `ced6da3` | 当前 `main` 分支 |
| CI 配置 | 已添加，未在远端执行 | `.github/workflows/ci.yml`（Windows runner） | 本地配置 |

## 二、账号登录真实模型验证（本机实际使用方式）

| 能力 | 结果 | 验证方式 | 证据 |
| --- | --- | --- | --- |
| Claude 沙箱单项真实轮次 | PASS | `npm run test:claude -- --allow-paid` | `.state/claude-smoke/run-WWcVPe/report.json` |
| Claude 沙箱任务文件差异 + 成果应用 | PASS | `npm run test:sandbox-artifact -- --allow-paid` | `.state/sandbox-artifact-smoke/` |
| 沙箱两 Agent 任务接力（Claude + DeepSeek） | PASS | `npm run test:sandbox-handoff -- --allow-paid` | `.state/sandbox-handoff-smoke/` |
| Codex host 单项真实轮次 | PASS | `npm run test:codex -- --allow-paid` | `.state/codex-smoke/run-3kz2oE/report.json` |
| DeepSeek host 单项真实轮次 | PASS | `npm run test:deepseek -- --allow-paid` | `.state/deepseek-smoke/run-lCElSj/report.json` |
| 三 Agent 同房间协作发言 | PASS | `npm run test:team-host -- --allow-paid` | `.state/team-smoke/run-Xu8EIb/report.json` |
| host 任务文件编辑 + `task_complete` | PASS | `npm run test:host-task -- --allow-paid` | `.state/host-task-smoke/run-Y54Kwd/report.json` |
| host 命令/测试执行 | PASS | `npm run test:host-commands -- --allow-paid` | `.state/host-commands-smoke/run-yXrXVQ/report.json` |
| host 运行取消 | PASS | `npm run test:host-cancel -- --allow-paid` | `.state/host-cancel-smoke/run-5N1tWY/report.json` |
| host 两 Agent 任务接力 | PASS | `npm run test:host-handoff -- --allow-paid` | `.state/host-handoff-smoke/run-qhwnpd/report.json` |
| 外部 Claude Code 实际房间发言 | PASS | 用户在 Claude Code 中调用 `mcp__room__room_post` | test2 消息记录（19:37:53） |
| 外部 Codex 实际 MCP 调用 | PASS | `codex exec` + 全局 room MCP | `.state/codex-exec-last.jsonl` |
| 外部 Agent 自动值守真实模型（Claude CLI） | PASS | `npm run test:runner-real -- --allow-paid` | `.state/runner-real-smoke/` |
| 三 Agent 讨论并交付 Plan | PASS | 房间「Agent 并行与实时协作研讨」两轮讨论 + DeepSeek 综合；7 条 Agent 消息、7181 字计划与附件 | `docs/AGENT-PARALLEL-COLLABORATION-PLAN.md`、房间 `room_046d0d633a45437686f338c84c2c508b` |

## 三、可选“沙箱 + 显式 API 密钥”档

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 完整三 Agent 沙箱付费场景 | 可选未执行 | 需要 Codex `OPENAI_API_KEY`；本机 Claude/Codex 使用账号登录，策略不导入登录态到 AppContainer |
| 验收前置检查 | PASS（4/4） | `npm run test:acceptance -- --check` 已通过 |

## 四、已知限制与未覆盖项

- 账号登录状态不导入沙箱；如需沙箱内使用 Claude/Codex 账号登录，需要单独的凭据策略评审。
- 真实第三方 A2A HTTPS 服务联调尚未进行；本地 HTTP A2A 协议测试已覆盖。
- GitHub Actions 仅完成配置，未在远端实际执行；本地 preflight 已通过。
- 计划剩余项：适配器内部命令副作用的操作账本、状态不明运行的安全自动重入队；P1 的公平仲裁/WFQ、EWMA/quorum、预算熔断、来源信任级与工具前策略校验。
- 系统代理/私有网络探测只覆盖本机已知路径，不代表所有 Windows 环境。
- 成果应用（artifact apply）属于沙箱快照路径；host 模式直接修改真实项目，不走“应用到原项目”流程。

## 五、快捷入口

```powershell
npm run dev                         # 启动（已运行会提示当前地址）
npm run open                        # 在浏览器打开当前运行实例
npm run typecheck
npm test                            # 224 项单元/契约测试
npm run test:replay                 # 事件/回放/fencing/partial/上下文契约
npm run test:browser                # 无模型浏览器 E2E（36 步）
npm run test:preflight -- --with-native
npm run check:secrets               # 源码/文档密钥扫描
npm run report:readiness
npm run backup                      # 升级前一致性备份（快照 + artifacts + manifest）
npm run restore -- --latest         # 恢复最新备份（需先停止服务）
npm run test:external-mcp
npm run room:refresh-claude -- --session-url "<启动地址>"  # 仅显式轮换令牌后需要
npm run room:refresh-codex  -- --session-url "<启动地址>"
```
