# Codex 接入配置说明

本机 Codex 当前有两种可用形态：**Codex Desktop / ChatGPT 应用内的 Codex** 与 **Codex CLI 0.163.0-alpha.10.2**。Tempt Room 对 Codex 支持托管原生沙箱、本机直连、外部 MCP 会话和已有线程 attach；本文记录 2026-10-18 的配置状态与限制。

如果要让 Room 调度**当前已有的桌面会话**，请另见 [原生线程 attach 配置、实现与验证](CODEX-THREAD-BINDING.md)。附着适配器、界面、队列/轮次映射、取消、状态核对和独立真实 CLI 协议验证已实现；当前桌面后端的共享控制入口仍未接通，不能把能够读取历史当成已经附加活动会话。

## 一、当前凭据状态

- `~/.codex/auth.json`：`auth_mode = "chatgpt"`，`OPENAI_API_KEY = null`，只有 ChatGPT OAuth token（`id_token`/`access_token`/`refresh_token`）。
- 因此按当前安全策略（原生沙箱只接受**显式 API 密钥**，不导入用户账号目录），**Codex 无法参加需要托管沙箱的付费验收**；这不是连接器问题。
- 若要完成三 Agent 付费验收，需要用户提供可用的 `OPENAI_API_KEY`（或明确决定允许将 ChatGPT 凭据导入隔离沙箱，这属于策略变更，尚未实施）。
- Codex Desktop / `codex.exe app-server` 正在运行，使用 ChatGPT 登录；Tempt Room 的外部 MCP 方式可以把已启动的 Codex 会话接入房间，不需要 API 密钥。

## 二、外部 MCP 接入（已配置）

已在本机 `~/.codex/config.toml` 增加全局 MCP server `room`（修改前备份为 `config.toml.tempt-room.bak.<时间戳>`）：

```toml
[mcp_servers.room]
command = "C:\\Program Files\\nodejs\\node.exe"
args = ["D:\\DevelopProjects\\web\\ThisIsATemptProtocol\\scripts\\room-agent-mcp.mjs"]

[mcp_servers.room.env]
ROOM_URL = "http://127.0.0.1:4317"
ROOM_AGENT_TOKEN = "<codex 成员的房间令牌>"
ROOM_ROOM_ID = "<房间编号>"
```

`codex mcp list` 应能看到 `room`；`codex mcp get room` 可查看配置（输出含令牌，不要把输出贴到公开渠道）。令牌只对 `codex` 这一个 Agent 和对应房间有效；启动密钥持久化后，正常重启不再轮换令牌。

### 轮换令牌后刷新

正常重启不需要执行本节；只有显式轮换启动密钥（`ROOM_ROTATE_SESSION=1`）或更换数据目录后才需要刷新。

- 图形方式：Tempt Room UI「Agent 连接」→ 选择 `codex` → 「安装到客户端配置」选 `Codex config.toml`
- 命令行方式（会先备份 `config.toml`、调用 `codex mcp remove/add`，再验证新令牌）：
  ```powershell
  npm run room:refresh-codex -- --session-url "http://127.0.0.1:4317/#session=<新启动令牌>"
  ```
  默认 Agent 为 `codex`；可用 `--agent`/`--room`/`--codex`/`--no-check` 覆盖。启动令牌只在本机使用，不要提交到仓库。
- 备用手工命令（需要当前启动令牌）：
  ```powershell
  $session = '<新启动地址中的 64 位令牌>'
  $reply = Invoke-RestMethod -Headers @{Authorization="Bearer $session";'room-protocol-version'='0.1'} `
    "http://127.0.0.1:4317/api/agents/codex/connect?roomId=<房间编号>"
  codex mcp remove room
  codex mcp add room --env "ROOM_URL=http://127.0.0.1:4317" --env "ROOM_AGENT_TOKEN=$($reply.token)" --env "ROOM_ROOM_ID=<房间编号>" `
    -- "C:\Program Files\nodejs\node.exe" "D:\DevelopProjects\web\ThisIsATemptProtocol\scripts\room-agent-mcp.mjs"
  ```
- 更新后需要新开 Codex 会话（正在运行的会话不会热加载 MCP 配置）。

## 三、托管 Codex 本机直连（host，已验证）

托管 Codex 有两条执行权限：

- **沙箱隔离**：隔离 `CODEX_HOME` + 显式 API Key；当前正式验收使用这条路径，需要 `OPENAI_API_KEY`
- **本机直连**：以当前用户身份运行，直接使用用户自己的 `~/.codex` 与 ChatGPT 登录，不复制账号目录；Tempt Room 通过 Codex CLI 的 `-c` 覆盖参数注入房间 MCP，不改写用户 `config.toml`

本机直连验证入口：

```powershell
npm run test:codex -- --check       # 检查 codex.exe 版本与 CODEX_HOME 选择，不调用模型
npm run test:codex -- --allow-paid  # 一次真实模型轮次（使用 ChatGPT 配额）
```

注意：本机访问 `https://chatgpt.com` 若需要代理，**推荐只对 Codex host 生效的环境变量**（Tempt Room 适配器已支持，host 专用，不注入沙箱）：

```powershell
$env:ROOM_CODEX_PROXY = 'http://127.0.0.1:7897'
npm run dev
```

也可以使用通用的 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`，但它会影响所有本机直连 Agent。未设置代理时实测会报 `https://chatgpt.com/backend-api/... request timed out` / `Transport channel closed`；设置 `ROOM_CODEX_PROXY` 后同一冒烟命令通过（环境变量只传入 Codex 子进程，沙箱模式不会使用 loopback 代理）。

报告写入 `.state/codex-smoke/run-*/`，稳定入口 `.state/codex-smoke/latest.json`。

## 四、使用方式与限制

- Codex 外部会话通过房间 MCP 提供 `room_read` / `room_post` / `room_status` / `room_wait` / 任务提案/认领/完成/租约 等工具；Tempt Room **不会自动唤醒**外部 Codex 会话，仍由用户或 Codex 自身调度。
- 托管 Codex 沙箱模式需要显式 API Key 才能通过凭据诊断与正式付费验收；本机尚无该密钥。
- 本机直连已验证一次真实模型轮次（回复 `CODEX_HOST_OK_7416`），但正式验收要求沙箱，host 结果不能替代；host 模式把本机完整权限交给 Codex，只应对可信 Agent 开启。
- 不要把 `~/.codex/auth.json` 或含令牌的 `config.toml` 复制进仓库；`.mcp.json` 与 `.claude/` 已加入 `.gitignore`，Codex 配置位于用户目录不在仓库内。

## 五、验证记录

- 2026-10-18：为 `codex` 成员签发房间令牌，直接调用 `/api/agent/tool` 的 `room_status` 返回 200（房间 test2，事件序号 58）；`codex mcp add room` 成功，`codex mcp list` 显示 `room` 配置。
- 2026-10-18：`npm run test:codex -- --check` 通过（codex-cli 0.163.0-alpha.10.2，使用用户默认 `~/.codex`）；`--allow-paid` 首次未设代理失败（chatgpt.com 超时），设置本机代理后通过：运行 `completed`、host 模式、回复 `CODEX_HOST_OK_7416`（报告 `.state/codex-smoke/run-JDTBt0/report.json`）。
- 2026-10-18：新增 `ROOM_CODEX_PROXY` 适配器支持（仅注入 host 模式，沙箱不使用），仅设置该变量重跑 `--allow-paid` 再次通过：回复 `CODEX_HOST_OK_32921`（报告 `.state/codex-smoke/run-3kz2oE/report.json`）。对应单元测试覆盖 host 注入与 sandbox 不注入。
- 2026-10-18：**外部 Codex CLI 端到端验证**：使用本机全局 `room` MCP 配置执行 `codex exec`，模型实际调用 `room_status`（房间 test2，seq 68）和 `room_post`，在房间发出「Codex 外部 MCP 验证成功（CLI）」（消息时间 19:39:42）；会话线程 `01a14ecf…`，exit 0。本次使用 ChatGPT 配额、未使用 API Key。
- 令牌巡检命令：`npm run test:external-mcp`（Claude Code 项目 `.mcp.json` + Codex `config.toml`，只读 `room_status`），报告写入 `.state/external-mcp/`。
- 没有修改 ChatGPT 登录状态，也没有把其凭据写入 Tempt Room 或仓库。
