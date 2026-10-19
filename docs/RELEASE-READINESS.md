# Tempt Room 发布就绪摘要

> 自动生成于 2026-10-19T04:17:10.815Z。仅汇总本机已有报告，不触发任何模型请求。

## 门禁结果

| 门禁 | 结果 | 说明 | 证据 |
| --- | --- | --- | --- |
| 预发布检查（preflight） | 通过 | typecheck→test→build→SDK→浏览器→生产：通过（9/9 步） | `.state/preflight/run-aOgBYg/report.json` |
| 浏览器端到端（browser-e2e） | 通过 | 真实无头 Edge/Chrome：通过（41/41 步） | `.state/browser-e2e/run-Te8FJk/report.json` |
| 生产构建启动（production-smoke） | 通过 | dist 产物 + 隔离数据目录：通过（10/10 步） | `.state/production-smoke/run-jMxGR1/report.json` |
| Windows 原生沙箱 | 通过 | 23/23 项通过 | `.state/diagnostics/sandbox.json` |
| 仓库密钥扫描 | 通过 | 源码/文档未发现疑似 API Key 或房间令牌（2026-10-19T04:13:35.412Z） | `.state/secret-scan/latest.json` |
| Claude 沙箱真实轮次（单项） | 通过 | paid-one-turn · AppContainer + 原生会话 + 回复通过 | `.state/claude-smoke/run-WWcVPe/report.json` |
| 沙箱真实 Agent 成果应用（Claude） | 通过 | 沙箱文件差异交付物已应用到原项目并校验内容 | `.state/sandbox-artifact-smoke/run-GMpmfD/report.json` |
| 沙箱两 Agent 任务接力（Claude + DeepSeek） | 通过 | Claude v1 完成并应用成果，交接 DeepSeek v2 完成，两条运行均带 AppContainer 证明 | `.state/sandbox-handoff-smoke/run-dTKJB6/report.json` |
| Codex 本机直连真实轮次（单项） | 通过 | paid-host-one-turn · ChatGPT 登录 + 房间 MCP + 回复通过 | `.state/codex-smoke/run-3kz2oE/report.json` |
| DeepSeek 本机直连真实轮次（单项） | 通过 | paid-host-one-turn · DSH + 房间 MCP + 回复通过 | `.state/deepseek-smoke/run-lCElSj/report.json` |
| 外部会话令牌（Claude Code / Codex） | 通过 | room_status 检查通过（2026-10-18T11:40:10.439Z） | `.state/external-mcp/2026-10-18T11-40-10-439Z.json` |
| 外部 Agent 自动值守运行器（假 CLI） | 通过 | @提及后启动 CLI 并以 Agent 身份回帖，无模型请求 | `.state/runner-smoke/run-jmSbG9/report.json` |
| 外部 Agent 自动值守真实模型（Claude CLI） | 通过 | @提及 → 启动真实 Claude CLI → 模型回复以 claude-code 身份回帖 | `.state/runner-real-smoke/run-W5JdqL/report.json` |
| 三 Agent host 协作真实轮次（账号登录） | 通过 | Claude/Codex/DeepSeek 同一房间均完成回复 | `.state/team-smoke/run-Xu8EIb/report.json` |
| 账号登录 host 任务编辑（单项） | 通过 | 真实模型修改项目文件并完成 task_complete | `.state/host-task-smoke/run-Y54Kwd/report.json` |
| 账号登录 host 命令/测试执行（单项） | 通过 | 真实运行 npm test 并保存输出后完成任务 | `.state/host-commands-smoke/run-yXrXVQ/report.json` |
| 账号登录 host 取消运行（单项） | 通过 | 长命令运行被取消并进入 canceled 终态 | `.state/host-cancel-smoke/run-5N1tWY/report.json` |
| 账号登录 host 任务接力（两 Agent） | 通过 | Claude v1 完成后交接 DeepSeek v2 并完成 | `.state/host-handoff-smoke/run-qhwnpd/report.json` |
| Windows 连接器进程树 | 通过 | 9/9 项通过 | `.state/connector-probes/run-zt8YpD/report.json` |
| 原生 Agent 协议预检 | 通过 | codex:通过 / claude:通过 / deepseek:通过 | `.state/native-pipecompat-20261017/diagnostics/agent-protocols.json` |
| 完整验收前置（--check） | 通过 | ready-for-paid-tests（4/4 步，agents=3） | `.state/native-pipecompat-20261017/acceptance-tests/suite-wdp7HI/acceptance.json` |
| 真实 Agent 场景（沙箱 + 显式密钥）（可选） | 可选，未执行 | 可选档：本机使用账号登录，已由单 Agent / 外部 MCP / 三 Agent host 门禁覆盖；如有 API Key 可运行 --allow-paid | `.state/native-pipecompat-20261017/acceptance-tests/suite-Y21n0G/acceptance.json` |

## 结论

- 当前自动汇总：**必需门禁全部通过（可选沙箱密钥档未执行）**。
- `test:preflight` 与上述报告均不调用模型；单 Agent 与三 Agent host 真实轮次使用账号登录，沙箱密钥档为可选最高门槛。

## 仍待完成 / 可选门槛

1. **沙箱 + 显式密钥档（可选最高门槛）**：现有 `test:acceptance` 完整场景要求 managed + sandbox + 显式凭据，仅适用于提供 Codex API Key 的环境；本机 Claude Code / Codex 使用账号登录，账号登录档已由单 Agent、外部 MCP、三 Agent host 协作门禁覆盖（见 `docs/ACCOUNT-LOGIN.md`）。如要额外保留沙箱最高门槛，提供 Codex `OPENAI_API_KEY` 后运行：
   ```powershell
   # 先关闭使用相同 .state 的服务
   npm run test:acceptance -- --allow-paid
   ```
2. **真实第三方 A2A 联调**：当前仅完成本地 HTTP 线上格式测试；生产出口策略要求公网 HTTPS，尚未与外部 A2A 服务对接。
3. **账号登录 host 档**：已完成三 Agent 同房间真实回复、单项冒烟与外部会话验证；后续可扩展到编辑/测试/取消/成果应用的完整场景脚本。

## 复现命令

```powershell
npm run test:preflight                 # 无模型发布检查（可加 --skip-browser / --skip-sdk）
npm run test:preflight -- --with-native  # 追加连接器与沙箱探测（Windows）
npm run test:browser                   # 真实浏览器端到端（不调用模型）
npm run test:production                # 生产构建启动冒烟（先 npm run build）
npm run test:acceptance -- --check     # 沙箱密钥档前置检查（不调用模型）
npm run test:acceptance -- --allow-paid # 沙箱密钥档真实场景（付费，需用户显式执行）
npm run test:team-host -- --allow-paid  # 账号登录档：三 Agent 同房间真实回复（付费）
npm run test:claude -- --check          # 各单 Agent 配置/协议检查（无模型）
npm run test:external-mcp               # 外部 Claude Code / Codex 令牌巡检（无模型）
```

## 证据说明

- 报告目录均位于 `.state/`（本机数据）；分享前请自行检查其中是否包含敏感路径或业务内容。
- 所有时间戳均来自对应报告文件的生成时间。
