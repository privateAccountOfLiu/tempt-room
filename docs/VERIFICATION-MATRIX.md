# 验证矩阵（2026-10-18）

本文件把 Scheme.md 的主要能力与当前可复现的验证方式、证据位置对应起来。所有命令都在项目根目录执行；无模型命令不会调用任何 Agent 模型。

## 一、无模型门禁

| 能力 | 结果 | 验证方式 | 证据 |
| --- | --- | --- | --- |
| 类型检查 / 单元测试 | PASS | `npx tsc --noEmit`、`npm test`（105/105，含备份/恢复、Claude/Codex/DSH 版本解析与浏览器命令） | 测试输出 |
| 仓库密钥扫描 | PASS（源码/文档无 API Key 或房间令牌） | `npm run check:secrets` | `.state/secret-scan/latest.json` |
| 预发布全链路 | PASS（9/9） | `npm run test:preflight -- --with-native` | `.state/preflight/run-eFkpLl/report.json` |
| 浏览器端到端（含会话恢复与原生端点字段） | PASS（31/31） | `npm run test:browser` | `.state/browser-e2e/run-LEGvlE/report.json`、`ui.png` |
| 生产构建 + 重启恢复 + Cookie 保持 | PASS（10/10） | `npm run test:production` | `.state/production-smoke/run-tix5Qe/report.json` |
| Windows 原生沙箱探测 | PASS（23/23） | `npm run test:sandbox` | `.state/diagnostics/sandbox.json` |
| 连接器进程树 | PASS（9/9） | `npm run test:connectors` | `.state/connector-probes/` |
| 原生 Agent 协议预检 | PASS（codex/claude/deepseek） | `npm run check:secrets   # 源码/文档密钥扫描
npm run report:readiness` 读取 | `.state/native-pipecompat-20261017/diagnostics/agent-protocols.json` |
| 外部会话令牌巡检（Claude Code / Codex） | PASS | `npm run test:external-mcp` | `.state/external-mcp/` |
| 外部 Agent 自动值守运行器（假 CLI） | PASS | `npm run test:runner` | `.state/runner-smoke/` |
| 发布就绪汇总 | 退出码 0 | `npm run report:readiness` | `docs/RELEASE-READINESS.md` |

## 二、账号登录真实模型验证（本机实际使用方式）

| 能力 | 结果 | 验证方式 | 证据 |
| --- | --- | --- | --- |
| Claude 沙箱单项真实轮次 | PASS | `npm run test:claude -- --allow-paid` | `.state/claude-smoke/run-WWcVPe/report.json` |
| Claude 沙箱任务文件差异 + 成果应用 | PASS | `npm run test:sandbox-artifact -- --allow-paid` | `.state/sandbox-artifact-smoke/` |
| 沙箱两 Agent 任务接力（Claude + DeepSeek） | PASS | `npm run test:sandbox-handoff -- --allow-paid` | `.state/sandbox-handoff-smoke/` |
| Codex host 单项真实轮次 | PASS | `npm run test:codex -- --allow-paid` | `.state/codex-smoke/run-3kz2oE/report.json` |
| DeepSeek host 单项真实轮次 | PASS | `npm run test:deepseek -- --allow-paid` | `.state/deepseek-smoke/run-lCElSj/report.json` |
| 三 Agent 同房间协作发言 | PASS | `npm run test:team-host -- --allow-paid` | `.state/team-smoke/run-Xu8EIb/report.json` |
| host 任务文件编辑 + task_complete | PASS | `npm run test:host-task -- --allow-paid` | `.state/host-task-smoke/run-Y54Kwd/report.json` |
| host 命令/测试执行 | PASS | `npm run test:host-commands -- --allow-paid` | `.state/host-commands-smoke/run-yXrXVQ/report.json` |
| host 运行取消 | PASS | `npm run test:host-cancel -- --allow-paid` | `.state/host-cancel-smoke/run-5N1tWY/report.json` |
| host 两 Agent 任务接力 | PASS | `npm run test:host-handoff -- --allow-paid` | `.state/host-handoff-smoke/run-qhwnpd/report.json` |
| 外部 Claude Code 实际房间发言 | PASS | 用户在 Claude Code 中调用 `mcp__room__room_post` | test2 消息记录（19:37:53） |
| 外部 Codex 实际 MCP 调用 | PASS | `codex exec` + 全局 room MCP | `.state/codex-exec-last.jsonl` |
| 外部 Agent 自动值守真实模型（Claude CLI） | PASS | `npm run test:runner-real -- --allow-paid` | `.state/runner-real-smoke/` |

## 三、可选“沙箱 + 显式 API 密钥”档

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 完整三 Agent 沙箱付费场景 | 可选未执行 | 需要 Codex `OPENAI_API_KEY`；本机 Claude/Codex 使用账号登录，策略不导入登录态到 AppContainer |
| 验收前置检查 | PASS（4/4） | `npm run test:acceptance -- --check` 已通过 |

## 四、已知限制与未覆盖项

- 账号登录状态不导入沙箱；如需要沙箱内使用 Claude/Codex 账号登录，需要单独的凭据策略评审。
- 真实第三方 A2A 服务联调尚未进行；本地 HTTP A2A 协议测试已覆盖。
- Codex/DSH Desktop 版本尚未做每次运行的强制二进制版本校验；正式发布前应人工固定安装版本。
- 系统代理/私有网络探测只覆盖本机已知路径，不代表所有 Windows 环境。
- 成果应用（artifact apply）属于沙箱快照路径；host 模式直接修改真实项目，不走“应用到原项目”流程。

## 五、快捷入口

```powershell
npm run dev            # 启动（已运行会提示当前地址）
npm run open           # 在浏览器打开当前运行实例
npm run report:readiness
npm run dev:open         # 启动并自动打开浏览器
npm run backup           # 升级前一致性备份（快照 + artifacts + manifest）
npm run restore -- --latest  # 恢复最新备份（需先停止服务）
npm run test:external-mcp
npm run room:refresh-claude -- --session-url "<启动地址>"  # 仅显式轮换令牌后需要
npm run room:refresh-codex  -- --session-url "<启动地址>"
```
