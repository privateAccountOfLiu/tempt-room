# Claude Code 接入配置说明

本文记录 Tempt Room 里 Claude Code 的两条接入路径、已验证配置，以及 3p（Claude Desktop）宿主凭据的发现与注意事项。目标是让同一台机器上的 Claude Code 与 Tempt Room 稳定互通，同时不把密钥写入仓库。

## 一、Claude Code 的两条路径

| 路径 | 说明 | 适用 |
| --- | --- | --- |
| 托管原生 Agent（`claude` 成员） | Tempt Room 按运行启动 Claude Code CLI，注入房间 MCP，会话 ID 复用 | 需要在房间内被 @ 唤醒、参与任务与工具调用 |
| 外部会话（`claude-code` 成员） | 用户已启动的 Claude Code 通过项目 `.mcp.json` 连接 Tempt Room 房间 MCP | 想用当前正在使用的 Claude Code 会话 |

两条路径可以同时存在，但**不要在同一个房间同时点名两个同名角色**，以免同一问题被回答两次；可以分别放在不同房间，或只保留一个作为 Claude 代表。

## 二、托管 Claude Agent 的配置（已验证）

本机 Claude Desktop（3p）为它启动的 Claude Code 会话提供的实际模型通道是：

- `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`
- `ANTHROPIC_AUTH_TOKEN=<显式令牌>`（认证变量名为 `ANTHROPIC_AUTH_TOKEN`，不是 `ANTHROPIC_API_KEY`）
- 由 `%LOCALAPPDATA%\Claude-3p\host-creds-*.json` 临时下发，带过期时间；**该文件含密钥，不要复制到仓库、聊天或报告中**
- Claude Code 2.1.271 在该端点上可用 `--model claude-sonnet-4-6` 正常对话

Tempt Room 的 Claude 成员应配置为：

```text
执行权限: 本机直连（host，可由用户改成沙箱）
Anthropic 兼容端点: https://api.deepseek.com/anthropic
密钥环境变量名称: DEEPSEEK_API_KEY
模型名称: claude-sonnet-4-6
程序入口: C:\Users\<user>\AppData\Local\Claude-3p\claude-code\2.1.271\claude.exe
```

启动 Tempt Room 的终端必须提供 `DEEPSEEK_API_KEY`（与 DeepSeek 成员共用即可；本机已验证同一个 DeepSeek key 可用于 `api.deepseek.com/anthropic`）。

适配器行为（`apps/server/src/adapters.ts` 的 `nativeEnvironment`）：

1. 若 Claude 成员配置了 `credentialEnv`，把该变量值注入为 `ANTHROPIC_AUTH_TOKEN`，并设置 `CLAUDE_CODE_HOST_AUTH_ENV_VAR=ANTHROPIC_AUTH_TOKEN`；同时删除继承来的 `ANTHROPIC_API_KEY`，避免旧值干扰
2. 若配置了 `endpoint`，注入 `ANTHROPIC_BASE_URL`
3. Claude 启动参数加入 `--setting-sources=project,local`，避免本机 `~/.claude/settings.json` 中失效的代理地址（例如 `http://127.0.0.1:15721`）覆盖显式配置
4. Codex 若配置 `endpoint`，注入 `OPENAI_BASE_URL`

之前托管 Claude 一直 `ConnectionRefused` 的根因：`~/.claude/settings.json` 指向未运行的代理 `127.0.0.1:15721`，且旧适配器把 DeepSeek key 放进 `ANTHROPIC_API_KEY`（3p 网关需要 `ANTHROPIC_AUTH_TOKEN`），并且没有注入可用端点。

### 验证证据（2026-10-18）

- `CLAUDE_MANAGED_OK`：托管 host 运行完成，原生会话 `1c636253…`，约 6 秒
- `CLAUDE_TOOLS_OK`：托管 host 运行中 `room_read`、`room_post` 工具审计均成功，最终回复 `CLAUDE_TOOLS_OK`，复用同一原生会话
- 两次运行均为 `executionMode=host`（无 AppContainer）；沙箱模式仍支持同样的 endpoint/key 注入，但需在真实沙箱中复测

## 三、沙箱模式验证（2026-10-18）

新增 `scripts/smoke-claude.ts`，用隔离数据目录与独立房间验证 Claude 的沙箱路径，不影响日常 `.state`：

```powershell
# 启动终端先设置 DEEPSEEK_API_KEY；ROOM_STATE_DIR 可指向已有 Claude 成员的配置目录
npm run test:claude -- --check       # 无模型：沙箱 23/23 + Claude 版本/MCP 控制帧
npm run test:claude -- --allow-paid  # 一次真实模型轮次（产生少量费用）
```

`--check` 与 `--allow-paid` 都会把源配置中的 Claude 成员复制为 `managed + sandbox` 成员，并使用配置的 Anthropic 兼容端点；`--allow-paid` 要求一次运行完成、AppContainer 记录已验证、保存原生会话且回复包含随机标记。报告写入 `.state/claude-smoke/run-*/`，稳定入口 `.state/claude-smoke/latest.json`。

实测结果（2026-10-18）：`--check` 通过；`--allow-paid` 通过——沙箱 23/23、协议预检通过、运行 `completed`、AppContainer 已验证、原生会话已保存、回复 `CLAUDE_SANDBOX_OK_22405`。

## 四、外部 Claude Code 会话（项目 `.mcp.json`）

项目根目录的 `.mcp.json` 已包含房间 MCP 配置：

```json
{"mcpServers":{"room":{"command":"C:\\Program Files\\nodejs\\node.exe","args":["D:\\DevelopProjects\\web\\ThisIsATemptProtocol\\scripts\\room-agent-mcp.mjs"],"env":{"ROOM_URL":"http://127.0.0.1:4317","ROOM_AGENT_TOKEN":"<claude-code agent token>","ROOM_ROOM_ID":"room_71727c76ddd445888f68517f450a4e21"}}}}
```

要点：

1. **令牌跨正常重启保持有效**：启动密钥持久化在 `.state/owner-session.token`，房间 Agent 令牌由它派生，因此重启服务后 `.mcp.json` 不需要重写。仅在显式轮换令牌后需要重新写入 `.mcp.json`：
   - 图形方式：UI「Agent 连接」→ 选择 `claude-code` → 「安装到客户端配置」选 Claude 项目
   - 命令行方式（先备份 `.mcp.json`，再验证新令牌）：
     ```powershell
     npm run room:refresh-claude -- --session-url "http://127.0.0.1:4317/#session=<新启动令牌>"
     ```
     Agent 默认 `claude-code`，文件默认 `.mcp.json`；可用 `--agent`/`--file` 覆盖，`--no-check` 跳过写入后的 `room_status` 验证。启动令牌只在本机使用，不要提交到仓库。
2. **项目 MCP 需要审批**：Claude Code 默认把 `.mcp.json` 标为 “Pending approval”。在本机 `~/.claude/settings.json` 增加：
   ```json
   {"enabledMcpjsonServers":["room"]}
   ```
   之后 `claude mcp list` 显示 `room … √ Connected`。修改前已备份原文件（`settings.json.tempt-room.bak.<时间戳>`）。
3. **正在运行的 Claude Code 会话不会热加载配置**：正常重启不需要重开；只有轮换令牌或修改 `.mcp.json` 后，才需要重开相关会话/工作区加载新令牌
4. `.mcp.json` 含房间 agent token（只对单个 Agent/单个房间生效；正常重启不变，轮换启动密钥后失效），**不要提交到公开仓库**；本仓库当前没有提交历史，仅作为本机工作目录使用
5. 令牌是否有效可单独检查（只读 `room_status`，不调用模型）：
   ```powershell
   npm run test:external-mcp
   ```
   报告写入 `.state/external-mcp/`；本机 2026-10-18 实测 Claude Code 外部会话已在 test2 成功调用 `mcp__room__room_post` 发言（消息时间 19:37:53，bridge PID 11176）。

## 五、常见问题对照

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 托管 Claude 一直 `ConnectionRefused` | 用户 settings 指向未运行代理 15721 | 配置 Anthropic 兼容端点并让适配器覆盖；或修正/删除用户代理配置 |
| `Failed to authenticate` / 401 | 通过 `ANTHROPIC_API_KEY` 传了错误 key | 使用 `ANTHROPIC_AUTH_TOKEN`（适配器已自动处理） |
| Claude Code 里 `room` 显示 Pending approval | 项目 `.mcp.json` 未审批 | 在用户 `~/.claude/settings.json` 加 `enabledMcpjsonServers:["room"]` |
| 外部 Claude 的 room 工具 401 | 启动密钥被显式轮换或数据目录被更换，旧 token 失效 | 更新 `.mcp.json` token 并重开会话 |
| `claude mcp list` 中 room 连接失败 | Tempt Room 未启动/端口不对 | 确认 `ROOM_URL` 指向当前运行实例；轮换令牌后刷新 token |

## 六、建议的日常流程

1. 启动 Tempt Room（终端里有 `DEEPSEEK_API_KEY`），打开新启动地址
2. 使用托管 Claude：在房间 @Claude 即可；本机直连会使用当前用户环境与上述 DeepSeek 兼容端点
3. 使用外部 Claude Code：确认 `claude mcp list` 中 room 为 Connected；正常重启无需刷新，只有轮换过令牌时才需要刷新 `.mcp.json` 并重开会话
4. 不要把 `host-creds-*.json`、`~/.claude/settings.json` 内容或 `.mcp.json` 的 token 发到公开渠道
