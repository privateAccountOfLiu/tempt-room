# 账号登录型 Agent（Claude Code / Codex）说明

本机实际使用情况：**Claude Code 与 Codex 依靠各自账号登录，不使用 API Key**。这不是异常配置，而是两个客户端的主流用法。本文记录 Tempt Room 对这类 Agent 的支持边界和已实测证据。

## 一、当前支持的三条路径

| 路径 | Claude Code | Codex | 说明 |
| --- | --- | --- | --- |
| 托管 · 本机直连（host） | 支持，已验证（含文件编辑、命令/测试执行） | 支持，已验证 | 以当前用户身份运行，使用各自登录/本机环境，可在房间内被 @ 点名并执行工具 |
| 外部 MCP 会话 | 支持，已验证 | 支持，已验证 | 用户自己的会话通过房间 MCP 参与讨论、认领任务、发布报告 |
| 托管 · 沙箱 | 需要显式 API Key/兼容端点凭据 | 需要显式 API Key | 账号登录状态**不会**自动导入 AppContainer；这是当前安全策略，尚未开放登录态导入 |

因此：
- **日常使用账号登录没有问题**：host 模式与外部 MCP 模式都已跑通真实模型轮次。
- 正式“沙箱 + 显式密钥”的完整付费验收，仅适用于提供 API Key 的环境；账号登录环境不应把“没有 Codex API Key”当成功能故障。
- 是否要把登录态导入隔离沙箱属于凭据策略变更，需要单独评审；本机未擅自实施。

## 二、已验证证据（2026-10-18）

1. **Claude Code 外部会话**：在 test2 通过 `mcp__room__room_post` 实际发言（19:37:53）。
2. **Codex 外部 CLI**：`codex exec` 通过全局 `room` MCP 实际调用 `room_status` + `room_post`，房间消息 19:39:42，exit 0。
3. **三 Agent 同房间 host 协作**：`npm run test:team-host -- --allow-paid` PASS——Claude / Codex / DeepSeek 在同一隔离房间各完成一次真实回复（报告 `.state/team-smoke/run-Xu8EIb/report.json`）。
4. **单项 host 冒烟**：`test:codex` PASS（`CODEX_HOST_OK_32921`）、`test:deepseek` PASS（`DEEPSEEK_HOST_OK_20932`）；Claude host 在房间内完成 `CLAUDE_MANAGED_OK` 与 `CLAUDE_TOOLS_OK`。
5. **外部令牌巡检**：`npm run test:external-mcp` 对 Claude 项目 `.mcp.json` 与 Codex `config.toml` 均 PASS。
6. **账号登录 host 任务编辑**：`npm run test:host-task -- --allow-paid` PASS——Claude 在本机直连模式下真实修改隔离 fixture 项目的 `answer.txt` 为 `HOST_TASK_OK`，任务状态 `completed`、运行 host 模式、原生会话 `273ff56e`（报告 `.state/host-task-smoke/run-Y54Kwd/report.json`）。
7. **账号登录 host 命令/测试执行**：`npm run test:host-commands -- --allow-paid` PASS——Claude 真实运行 `npm test`，输出包含 `HOST_TESTS_PASS` 并写入 `test-output.txt`，任务 `completed`、运行 host 模式、原生会话 `44907de0`（报告 `.state/host-commands-smoke/run-yXrXVQ/report.json`）。
8. **账号登录 host 取消运行**：`npm run test:host-cancel -- --allow-paid` PASS——长命令运行中从房间发起 `run.cancel`，运行与任务均进入 `canceled`，取消延迟约 0.8 秒，host 模式（报告 `.state/host-cancel-smoke/run-5N1tWY/report.json`）。
9. **账号登录 host 两 Agent 任务接力**：`npm run test:host-handoff -- --allow-paid` PASS——任务由 Claude v1 完成，交接给 DeepSeek 后以 v2 再次完成；任务 `completed`、负责人 `smoke-deepseek-handoff`、两条 host 运行均 `completed`、`answer.txt` 保持 `HANDOFF_STEP1`（报告 `.state/host-handoff-smoke/run-qhwnpd/report.json`）。

## 三、host 模式注意事项

- 以当前 Windows 用户身份运行，拥有完整本机权限，只应对可信 Agent 开启。
- Claude host 使用 Desktop 3p 下发的兼容端点 + `DEEPSEEK_API_KEY`（实现见 `docs/CLAUDE-CODE-CONFIG.md`）。
- Codex host 直接使用 `~/.codex` 的 ChatGPT 登录；如访问 `chatgpt.com` 需要代理，设置 host 专用 `ROOM_CODEX_PROXY`（不会注入沙箱）。
- 启动会话令牌持久化在数据目录：正常服务重启不会轮换房间 Agent 令牌，浏览器与外部会话都能继续使用；只有显式轮换（`ROOM_ROTATE_SESSION=1` 或删除 `.state/owner-session.token`）后才需要刷新 `.mcp.json` / `config.toml`。

## 四、验收口径（已实施）

发布就绪摘要已按账号登录现实分层：

- **必需门禁（账号登录档）**：单 Agent 冒烟（Claude 沙箱、Codex host、DeepSeek host）、外部会话令牌巡检、三 Agent host 同房间真实协作、**host 任务编辑**、**host 命令/测试执行**、**host 取消运行**、**host 两 Agent 任务接力**、preflight/浏览器/生产/沙箱/协议预检。全部通过时 `npm run report:readiness` 退出码为 0，结论为“必需门禁全部通过（可选沙箱密钥档未执行）”。
- **可选最高门槛（沙箱 + 显式密钥档）**：现有 `test:acceptance -- --allow-paid`，要求三位成员为 managed + sandbox + 显式凭据；提供 Codex API Key 后可执行，报告通过时作为额外证据展示，不阻塞账号登录档的发布结论。

后续可扩展项：把 `test:team-host` / `test:host-task` / `test:host-commands` / `test:host-cancel` 扩展到多 Agent 任务接力与成果应用等完整协作场景；是否开放登录态导入沙箱仍属于凭据策略变更，需单独评审。
