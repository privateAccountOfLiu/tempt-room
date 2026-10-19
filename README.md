# Tempt Room

Windows 本地多 Agent 群协作软件。React 界面、Fastify 应用服务、SQLite 事件日志、.NET AppContainer 执行宿主和 Room Protocol 0.1 客户端。

## 当前可用范围

已实现多个房间、成员配置、提及路由、流式回复、引用和附件、数据库队列、可调整的有界讨论、任务提议确认、任务转交/接力（`task.handoff`）与开放认领（`task.claim`）、依赖交付物传递与目标版本、决策接受、独立项目快照、差异审查与冲突检查后应用、HTTP/WebSocket 历史恢复。群聊消息按 GitHub 风格 Markdown（含表格、列表、代码块、链接）与 KaTeX 数学公式渲染，兼容 `$...$`、`$$...$$`、`\(...\)`、`\[...\]` 分隔符；未启用原始 HTML。运行设置可调整并发、内存、进程数和超时，提供方未返回的用量显示未知。随附两个明确标记的确定性演示成员，无须模型密钥。

Codex App Server、Claude Code stream-json、DeepSeek Harness ACP、自建 Chat Completions API 和 A2A 1.0 适配器已经接线。**账号登录环境下的真实 Agent 路径已实测通过**：Claude 沙箱单项真实轮次、Codex/DeepSeek 本机直连单项真实轮次、Claude/Codex 外部 MCP 真实发言、三 Agent 同房间 host 协作均已验证；`npm run check:secrets       # 扫描源码/文档中的疑似密钥（排除 .state、node_modules 与本地 MCP 配置）
npm run report:readiness` 的必需门禁全部通过。严格 AppContainer 三 Agent 完整场景（编辑、测试、取消、成果应用）属于可选“沙箱 + 显式 API 密钥”门槛，本机账号登录环境暂无该密钥，详见 [账号登录型 Agent 说明](docs/ACCOUNT-LOGIN.md)。本机最新原生探测 23/23 通过；DeepSeek Harness Desktop 0.2.0-rc.2 已在隔离沙箱内完成真实模型轮次、连续会话复用与群聊 MCP 验证，并支持按 Agent 可选的「本机直连」执行模式（沙箱仍是默认，不会自动降级）。参见 [验证矩阵](docs/VERIFICATION-MATRIX.md)、[v0.1 发布说明](docs/RELEASE-NOTES.md)、[验收与已知限制](docs/ACCEPTANCE.md) 和 [DeepSeek 反馈处理](docs/DEEPSEEK-FEEDBACK-RESPONSE.md)。

## 启动

在项目根目录的 PowerShell 中运行，需要 Windows、Node.js 24+、.NET 10 SDK；Git 为 Git 项目快照提供基线。

```powershell
npm ci
npm run build:sandbox
npm run dev
```

打开终端显示的 `http://127.0.0.1:4317/#session=...`。启动凭据交换成 HttpOnly、SameSite=Strict Cookie 后，地址栏移除凭据。不要分享启动地址。服务固定监听 loopback，不支持局域网开放。会话令牌会保存在数据目录并在重启后复用，浏览器 Cookie 默认保持 30 天，因此正常重启不需要重新打开；需要轮换时设置 `ROOM_ROTATE_SESSION=1` 后启动，或删除 `.state/owner-session.token`。如果浏览器清除了登录状态，重连页支持直接粘贴启动地址或 64 位启动令牌恢复。服务已在运行时重复执行 `npm run dev` 会直接提示当前运行地址并正常退出，不再报“状态目录正在使用”的锁冲突。也可以执行 `npm run open` 在默认浏览器直接打开当前运行实例（读取锁文件与持久化令牌，不重启服务）。希望启动后自动打开浏览器时使用 `npm run dev:open`（等价于设置 `ROOM_OPEN_BROWSER=1` 后运行 `npm run dev`；服务已在运行时也会打开当前实例）。

默认数据目录为项目内 `.state`，可通过 `ROOM_STATE_DIR` 指定绝对路径；`ROOM_PORT` 可调整端口。同一数据目录只启动一个服务，启动器用进程锁防止重复打开。升级前可执行 `npm run backup` 生成一致快照（保留最近 5 份）；恢复时先停止服务，再执行 `npm run restore -- --latest`（或 `--backup <目录>`）。

生产构建与运行：

```powershell
npm run build
npm start
```

构建界面和服务器不会自动编译 C#；首次运行前仍需 `npm run build:sandbox`。请从项目根目录启动，以便定位宿主和桥接脚本。

## 首次体验

1. 在「项目工作室」中点 `＠`，选择演示规划员并发送消息。普通消息不触发运行。
2. 用「开启讨论」指定目标、参与者、轮次、响应次数和时间上限。默认 3 轮、最多 9 次响应、10 分钟；同一轮共享持久化上下文快照。
3. 创建任务时可填写项目绝对路径。演示成员仅演示流程，不编辑文件。
4. 在任务卡片上修改目标会生成新版本，取消旧运行，并标记旧结果；已确认的依赖下游任务也会生成新版本，未确认的提议保留待确认状态。停止受理和停止确认是不同状态。
5. 原生 Agent 修改产生的交付物在「交付物」中查看。点击应用前检查完整差异；原文件与基线不一致会整体拒绝应用。
6. 在「运行设置」调整默认资源；资源与超时在运行入队时保存，后续设置变更不改写已入队运行。并发限制用于下一次调度，同一成员会话仍串行。

## 真实 Agent 配置

在「Agent 连接」中填写程序、模型、密钥环境变量名，然后「保存并诊断」。软件只保存变量名，密钥需要在启动服务的 PowerShell 中设置。界面和群聊均不返回密钥。

```powershell
# 使用你自己的密钥，在当前启动终端中设置：
$env:OPENAI_API_KEY = '<your-key>'
$env:ANTHROPIC_API_KEY = '<your-key>'
$env:DEEPSEEK_API_KEY = '<your-key>'
npm run dev
```

- **Codex**：选择真正的 `codex.exe`，使用 `app-server --stdio`；托管沙箱需显式 API 密钥引用（例如 `OPENAI_API_KEY`），不导入桌面或 CLI 账号目录；本机 ChatGPT 登录可用于**本机直连**（host）模式（已验证，需要时在启动终端设置代理）或外部 MCP 会话（`codex mcp add room …`），见 [Codex 接入配置](docs/CODEX-CONFIG.md)。
- **Claude Code**：选择官方原生 `claude.exe`。可使用官方 Anthropic API（密钥引用 `ANTHROPIC_API_KEY`），也可填写 **Anthropic 兼容端点**（如本机 Claude Desktop 3p 使用的 `https://api.deepseek.com/anthropic`）：此时适配器会把配置的密钥注入为 `ANTHROPIC_AUTH_TOKEN`、设置 `ANTHROPIC_BASE_URL`，并用 `--setting-sources=project,local` 隔离本机 `~/.claude/settings.json` 中可能失效的代理配置；模型如 `claude-sonnet-4-6` 可直接使用。通过外层隔离检查后才使用 `bypassPermissions`。不实现网页 OAuth 登录，也不读取用户完整 Claude 配置。本机已用 DeepSeek 兼容端点完成托管 Claude（本机直连）真实模型轮次与 `room_read`/`room_post` 验证；详细配置与排障见 [Claude Code 接入配置](docs/CLAUDE-CODE-CONFIG.md)。
- **DeepSeek Harness Desktop**：选择安装目录中的 `DeepSeek Harness.exe`，例如 `D:\Program Files\Deepseek Harness\DeepSeek Harness.exe`。自动识别 `ELECTRON_RUN_AS_NODE=1`、asar CLI 入口和 ACP profile；不要求存在 `dsh.exe` 或 PATH 命令。自动复制顶层运行文件、完整 `resources/app.asar` 与 `app.asar.unpacked`，不复制用户配置或 `resources/runtime`。此裁剪针对 ACP 编程接入，Office 功能未验收。模型留空使用默认值；填写时按 ACP 广告的选项名称或完整值匹配。本机已用 Desktop 0.2.0-rc.2 完成隔离内的 ACP 会话、真实模型轮次、`room_read`/`room_post` 与连续会话复用验证。
- **DeepSeek npm 发行包**：选择官方 `@deepseek-ai/dsh` 包 `package.json` 声明的 JS 入口（通常为 `lib/bin.js`），同时指定含全部依赖的专用安装目录。由隔离 Node 运行，不执行 npm 的 `.cmd` 包装器。填写固定版本时会核对包版本。
- **自建 API**：填写公网 HTTPS 的 Chat Completions 基址（通常以 `/v1` 结束）、模型名、密钥变量名。默认流式文本讨论；可选「结构化回复与文本交付物」，要求端点支持 `response_format: {type: "json_object"}`。应用对完整对象再做校验，格式错误、拒绝或截断会失败，不把原始 JSON 片段当成完成回复。此适配器不提供代码执行工具。JSON 模式本身不保证符合业务 Schema，参见 [官方说明](https://developers.openai.com/api/docs/guides/structured-outputs#json-mode)。
- **A2A**：填写公网 HTTPS 的 Agent Card 地址或服务基址，支持声明 A2A `1.0` 的 `HTTP+JSON`、`JSONRPC` 接口。可配置 Bearer 密钥引用；接口必须与 Card 同源。支持任务轮询、补充输入和取消确认，不宣称兼容旧版 0.3。
- **自动探测**：连接设置里的「自动探测本机程序」只读扫描常见安装位置（各盘符的 Program Files 与用户程序目录，以及 Claude Code 的版本目录），找到后填入程序入口；不会执行任何程序。
- **执行权限（每个本地 Agent 单独设置）**：「沙箱隔离」保持 AppContainer，只授予工作区、隔离 home 和裁剪运行文件；「本机直连」不复制运行文件、不建项目快照，Agent 以当前 Windows 用户身份直接运行，可读写本机文件、访问 localhost、使用已安装工具链和自身登录状态，并直接修改真实项目目录。本机直连的聊天工作区按房间共享（同一房间的 Agent 能看到彼此文件），每次聊天运行后自动生成一个 Git 提交作为交接检查点（`room.git.checkpoint` 事件）；本机直连任务直接使用真实项目目录，完成后发布「本机变更清单」（Git 状态与 `git diff --stat`），不再有“应用交付物”步骤。同一真实项目目录的多个本机直连任务会被串行化，避免并发写坏文件。**本机直连绕过沙箱，只应对可信 Agent 开启。** 当前已验证 DeepSeek Harness Desktop；Claude/Codex 的本机直连尚未实测。

原生程序及 Node/MCP 桥被复制到管理目录，以只读权限授权给沙箱（本机直连不复制）。若配置 runtimeDirectory，应选专用程序目录，避免选择用户主目录或包含凭据的目录。运行文件按全部内容生成指纹，在临时目录完整复制、核对内容后原子发布；最多 30,000 文件/2 GiB。聊天会话使用固定工作区；任务在沙箱模式下从独立快照开始，本机直连模式下直接使用真实项目目录。模型由用户选择，失败不会自动切换提供方。

Codex 的 `request_user_input` 可进入房间的「补充输入」流程，敏感输入请求会拒绝进入公共群聊。Codex Token 事件目前标注为“最近模型请求”，不把会话累计或最后一次请求伪装成整轮费用；未返回费用时显示未知。原生接口实测仍受沙箱门槛限制。

「隔离启动检查 · 无模型请求」只对沙箱模式可用，检查程序与协议启动，不发送模型 prompt，也不导入用户凭据。沙箱未通过时仍然拒绝启动。本机直连模式请用「保存并诊断」确认程序入口。Claude 先查询版本，再通过控制帧 initialize/mcp_status 检查 room MCP 确已连接；这不代表真实模型轮次、编辑和取消已通过验收。

「Agent 连接」中的「添加 Agent」可建立多个同类成员，分别保存模型、职责及托管/外部接入方式。新成员默认禁用；保存后在「房间设置」邀请，确认配置后再启用。这样可以保留当前外部会话，同时另设原生沙箱成员进行验收。

Claude Code 外部会话使用项目根目录 `.mcp.json` 连接房间 MCP。首次使用需要在用户 `~/.claude/settings.json` 中把该服务器加入 `enabledMcpjsonServers`（例如 `["room"]`），`claude mcp list` 会显示 `room … √ Connected`。房间 Agent 令牌由持久化的启动密钥派生，正常重启后仍然有效，不需要重开 Claude Code 会话。仅在轮换令牌（`ROOM_ROTATE_SESSION=1`）后需要重新写入 `.mcp.json` 的 `ROOM_AGENT_TOKEN`：可用 UI「Agent 连接」→「安装到客户端配置」，或执行 `npm run room:refresh-claude -- --session-url "<新启动地址>"`（自动备份并验证新令牌）。详细步骤见 [Claude Code 接入配置](docs/CLAUDE-CODE-CONFIG.md)。

## 外部 MCP 接入（Claude Code / DSH / Codex）

除了由 Tempt Room 托管 Agent，也可以在**你自己的 Agent 环境里**（Claude Code、DSH、Codex 等）把它接入一个房间：Agent 使用自己的权限、工作目录、登录状态和本机工具，Tempt Room 只提供房间读写、任务提案和报告发布。打开某个 Agent 的连接设置，将「接入方式」改为「外部会话 / MCP」并保存，再点「生成外部 MCP 接入配置」，即得到该 Agent 在该房间的专用令牌和三种客户端的配置片段：

- **Claude Code**：把 `mcpServers` 保存为 `room-mcp.json`，运行 `claude --mcp-config room-mcp.json`；或直接使用内置插件目录 [plugins/tempt-room-claude](plugins/tempt-room-claude)，先设置 `ROOM_URL` / `ROOM_AGENT_TOKEN` / `ROOM_ROOM_ID`，再运行 `claude --plugin-dir <该目录>`。插件自带 `/room-status`、`/room-read`、`/room-post` 命令和 room MCP 服务。
- **Codex**：把生成的 `[mcp_servers.room]` 片段写入 `~/.codex/config.toml`，或直接执行 `codex mcp add room --env ROOM_URL=... --env ROOM_AGENT_TOKEN=... --env ROOM_ROOM_ID=... -- node scripts/room-agent-mcp.mjs`；`codex mcp list` 可查看配置。本机当前已用这种方式把 `codex` 成员接入外部 MCP（ChatGPT 登录可用；托管沙箱验收仍需显式 API Key）。正常重启后令牌仍然有效；仅在轮换令牌后执行 `npm run room:refresh-codex -- --session-url "<新启动地址>"` 刷新，详见 [Codex 接入配置](docs/CODEX-CONFIG.md)。
- **DSH**：把生成的 `@deepseek-ai/dsh-mcp-client` band 写入 acp profile 的 `cordis.patch.yml`。

连接器脚本是 `scripts/room-agent-mcp.mjs`，提供 `room_read`、`room_post`、`task_propose`、`task_claim`、`task_complete`、`task_heartbeat`、`artifact_publish`、`room_status`、`room_wait` 九个工具。`room_wait` 会等待最多 25 秒的新消息（带 `afterSeq` 与 `timeoutMs`），便于外部 Agent 在循环中等待房间动态；它不是后台唤醒，Agent 进程仍需由你或它自己的调度器启动。外部 Agent 认领开放任务时**不会**触发 Tempt Room 托管运行，而是由它自己执行并用 `task_complete` 结束任务。令牌只代表该 Agent、只能访问该房间，正常重启不失效（显式轮换启动密钥后失效）；外部 Agent 的进程不由 Tempt Room 托管，也**不会自动唤醒空闲 Agent**——它仍由你或它自己的调度器驱动。这是比“托管启动”更轻的接入方式，适合你本来就在用的 Claude Code / DSH。

### 一键安装到客户端配置

连接设置里可以把 room MCP 配置直接安装到客户端自己的用户配置（可选、可卸载）：

- **Claude Code**：执行 `claude mcp add room --scope user …`；`claude mcp list` 可看到 `room … √ Connected`。卸载执行 `claude mcp remove room --scope user`。
- **Claude 项目级**：把 room 写入指定项目目录的 `.mcp.json`（保留其他 MCP 服务与自定义字段，先备份；JSON 不合法时拒绝写入）。卸载只移除本工具写入的条目。
- **Codex**：写入 `~/.codex/config.toml` 的 `[mcp_servers.room]`（保留其他 MCP 配置，写入前生成时间戳备份）。
- **DSH**：写入 acp profile 的 `cordis.patch.yml`（写入前备份；若该 patch 已有自定义内容会拒绝自动改写，提示手动合并）。卸载后恢复为空的 patch 层。

安装/卸载前可以先点「预览变更」查看当前内容与安装后内容（不会写入文件，也不会执行 Claude CLI）；Claude 用户级配置由官方 CLI 管理，所以预览只显示将执行的命令、不回显令牌。所有会改文件的步骤都会留下 `.tempt-room.bak.<时间戳>` 备份。建议只对可信 Agent 安装。

### 自动值守（可选）

如果希望外部 Agent 被 @ 时自动运行，可以使用 [scripts/room-agent-runner.mjs](scripts/room-agent-runner.mjs)：它用该 Agent 的令牌长轮询房间，在收到点名消息时启动你配置的本机 CLI（如 `claude.exe -p "{prompt}"`），并把 CLI 输出作为该 Agent 的消息发回房间。

```powershell
$env:ROOM_URL = 'http://127.0.0.1:4317'
$env:ROOM_AGENT_TOKEN = '<连接设置中生成的令牌>'
$env:ROOM_ROOM_ID = '<房间 id>'
$env:ROOM_AGENT_COMMAND = 'C:\path\to\claude.exe'
$env:ROOM_AGENT_ARGS = '["-p","{prompt}"]'   # 也可不含 {prompt}，通过 ROOM_AGENT_PROMPT 环境变量传入
$env:ROOM_AGENT_RESUME_ARGS = '["--resume","{session}"]'   # 可选：复用上一次 Claude 会话
$env:ROOM_AGENT_SESSION_FILE = "$PWD\.state\agent-session.json"
node scripts\room-agent-runner.mjs
```

运行器本身可以用**假 CLI**做无模型端到端检查：`npm run test:runner`（读取项目 `.mcp.json` 的 Agent 令牌与当前 owner 令牌，@ 指定 Agent，验证运行器启动假 CLI 并以 Agent 身份回帖；不调用任何模型）。报告写入 `.state/runner-smoke/`。

真实模型值守可用 `npm run test:runner-real -- --allow-paid` 验证：自动查找本机 Claude Code CLI，@ 外部 Agent 后启动真实 CLI，并把模型回复以该 Agent 身份发回房间；需要 `DEEPSEEK_API_KEY`，每次会产生一次模型费用。报告写入 `.state/runner-real-smoke/`。

- 默认只响应人类的 @；`ROOM_WAKE_ON=message` 可改为任意人类新消息触发。Agent 的普通发言不会自动触发 CLI。
- **会话复用（降成本）**：给 CLI 配 `ROOM_AGENT_RESUME_ARGS`（如 `["--resume","{session}"]`）和 `ROOM_AGENT_SESSION_FILE` 后，运行器会从 CLI 的 stream-json 输出中记住 `session_id`，下次唤醒追加 resume 参数并复用同一会话；输出会被解析成最终答复正文再发回房间。删除会话文件即可重新开始。
- **常驻进程模式（可选）**：设置 `ROOM_AGENT_MODE=persistent` 后运行器只启动一次 CLI，并用 Claude 风格的 `--input-format stream-json` 把每次唤醒的 prompt 写入其 stdin，复用同一进程与会话（进程退出后下次唤醒自动带 resume 重启）。oneshot 模式则是每次唤醒新进程。
- **自动认领开放任务（可选）**：设置 `ROOM_CLAIM_OPEN=1` 后，运行器会轮询房间里 `open=true` 的任务；认领（外部认领不触发托管运行）→ 用任务标题作为 prompt 启动 CLI → 调 `task_complete` 一次性发布摘要并标记完成（失败则标记 failed）。执行期间运行器按租约（运行设置中的「外部任务租约」，默认 10 分钟）自动发 `task_heartbeat` 续租；运行器退出导致租约过期后，任务会被回收为开放任务以便重新认领。任务卡片会显示外部租约时间，owner 也可以直接点「回收」立即把任务放回开放池。这是外部 Agent 自主接活的最小闭环。
- 每次唤醒仍会产生模型费用；超时/失败只写运行器日志，不会伪造回复。
- 运行器需要由你启动和看护（终端、计划任务等）；它不是 Windows 服务，也不在 Tempt Room 进程内。
- 连接设置的「生成外部 MCP 接入配置」已包含这段自动值守示例；点「写入管理目录」会把 Claude MCP 配置、Codex 配置片段、DSH patch、`run-runner.ps1` 与说明一次性写到 `.state/connectors/<agent>_<room>/`。

外部工具写请求必须携带 `commandId`；网络超时后重试原命令。`task_complete` 和 `task_heartbeat` 必须携带本次认领返回的版本（`task_claim` 的 Receipt 中 `result.version`），且租约仍有效。续租失败会终止运行器拥有的 CLI 进程树；错误或未完成输出不会当作成功答案发布。

当前会话也可使用 `RoomAgentClient` 或 `scripts/room-session.ts <session.json> <工具名> [参数JSON]` 直接读写房间。使用房间专用令牌，不向 Agent 提供人类启动令牌。外部成员被 @ 时记录 `agent.wake.requested`，不创建托管进程；当前自动轮次只支持托管成员。

## 测试

```powershell
npm test                 # 无模型额度消耗的协议、服务、适配器、工作区与 HTTP/WS 测试（含 A2A HTTP 帧与 SDK 客户端真实网络集成）
npm run typecheck
npm run test:connectors  # Windows 本机 MCP/运行器进程集成；使用模拟 CLI，不调用模型
npm run test:sdk         # 本地打包、离线安装、真实包导入和 TypeScript 声明验证
npm run test:browser     # 无头 Edge/Chrome 真浏览器端到端：登录、发消息、演示成员流式回复、刷新恢复、运行设置；不调用模型
npm run build
npm run test:production  # 生产构建启动冒烟：SPA/CSP、认证、WebSocket、持久化、退出重启与数据库版本；不调用模型
npm run test:preflight   # 发布前无模型检查串联：typecheck→test→build→SDK→浏览器 E2E→生产冒烟
npm run report:readiness # 汇总本机最新报告，生成 docs/RELEASE-READINESS.md
npm run build:sandbox
npm run test:sandbox     # 真正的 Windows 隔离检查；失败时退出码为 1
npm run test:agent-protocols -- --agent=deepseek  # 沙箱通过后，无模型请求的 ACP 检查
```

浏览器的无模型流式回归场景可用 `npm run test:browser-fixture` 启动（默认端口 4318）；其专用控制接口只存在于该测试入口，实际产品不注册。多个数据目录的实例使用独立 Cookie，不会互相替换浏览器登录。

`npm run test:browser` 是自动化端到端冒烟：用隔离的数据目录和独立 HMR 端口启动真实服务，通过 Chrome DevTools Protocol 驱动无头 Edge/Chrome 完成登录、界面发送消息、演示成员流式回复、刷新后历史恢复、运行设置弹窗、**任务创建与转交（demo-planner→demo-reviewer，含版本递增与完成态）**、**@提及选择与发送**、**有界讨论（轮次/响应上限、结束后横幅移除）**、**WebSocket 断线后自动重连并补取断线期间消息**、**外部 Agent 发布交付物并在界面查看预览**、**任务修改目标（v3 新版本、旧回复标记“基于旧要求”）**、**界面新建房间与房间设置改名**、**添加外部会话 Agent、启用并邀请进房间、移除成员**、**带依赖的任务创建与父任务再次改版后的依赖升级（子任务 v2 重跑完成）**、**讨论中途停止**、**打开补丁预览并应用到原项目（真实文件写入、标记已应用）**、**任务改版后旧交付物应用被拒绝且文件不变**，并断言页面无控制台错误；不调用任何模型。报告与截图写入 `.state/browser-e2e/run-*/`（稳定入口 `.state/browser-e2e/latest.json`，最新截图另存 `docs/screenshots/browser-e2e.png`）。找不到浏览器时可用 `ROOM_BROWSER=<可执行文件>` 指定；`ROOM_E2E_HEADFUL=1` 可观察界面。它覆盖 UI/WS/持久化/任务协作/断线恢复/交付物/成果应用与版本拒绝/房间与成员管理/依赖版本链路，但不替代真实 Agent 场景验收。

`npm run test:production` 对**生产构建产物**做本机启动冒烟：用隔离状态目录启动 `dist/server/main.js`，检查静态 SPA 与 CSP、未认证请求 401、Owner API 认证、WebSocket 事件流、消息持久化、退出后的重启恢复与 `room.sqlite` 的 `user_version=5`。Windows 上外部终止不会触发 Node 信号处理器，因此脚本验证“终止后重新启动可恢复”（含陈旧锁处理），而 POSIX 上验证优雅退出。报告写入 `.state/production-smoke/latest.json`；不调用模型。

`npm run test:preflight` 按固定顺序串联发布前无模型检查：`typecheck → npm test → build → test:sdk → test:browser → test:production`，任一失败即中止并写入 `.state/preflight/latest.json`；可用 `--skip-browser` / `--skip-sdk` 跳过慢检查，`--with-native` 追加 `test:connectors` 与 `test:sandbox`（原生检查依赖 Windows 环境）。它不替代用户显式运行的付费真实 Agent 场景验收。

`npm test` 除协议/服务/适配器测试外，还包含 `tests/sdk-live.test.ts`：启动真实服务后用发布包客户端走 HTTP 与 WebSocket（幂等 commandId、Agent 房间令牌、跨房间拒绝、订阅与退订），与 `test:sdk` 的离线打包/消费者检查互补。

`npm run report:readiness` 读取 `.state/` 下最新的 preflight、浏览器 E2E、生产冒烟、沙箱、连接器、Agent 协议预检、单 Agent 真实轮次、外部会话令牌、三 Agent host 协作与 `test:acceptance --check` 报告，生成 `docs/RELEASE-READINESS.md` 汇总表与剩余门槛说明；只读报告，不调用模型。账号登录环境下沙箱密钥档自动标为可选，必需门禁缺失或失败时以非零退出码提示。

沙箱报告写入 `.state/diagnostics/sandbox.json`。不要将检查失败改成成功，也不要通过去掉隔离来启用宽松工具模式。[沙箱说明](docs/SANDBOX.md)列出了实现边界与验证缺口。

默认兼容方案为 MSVC 构建的 N-API 模块、受限 realpath 层、Git reftable 和固定源码哈希的 DSH 持久化层，详见[原生兼容实现](docs/NATIVE-COMPATIBILITY.md)。`npm run build:sandbox` 会构建模块，本机已通过 23 项探测。另可用 `ROOM_SANDBOX_NODE` / `ROOM_SANDBOX_GIT` 指定工具链输入；不会替换宿主安装或跳过实际探测。

另保留固定源码和 libuv 补丁的[完整 Node 构建入口](docs/RUNTIME-BUILD.md)，作为可选替代方案。该路线因缺少 Clang 尚未完成二进制构建，不影响默认 MSVC 兼容模块的构建与验证。

真实模型测试会产生费用，必须显式运行：

```powershell
# 先关闭使用相同 .state 的服务，并完成密钥和程序配置。
npm run test:agents -- --allow-paid
```

该脚本要求三位启用的托管沙箱成员，每位建立独立房间并验证实际 Run、沙箱证明、原生会话和准确 OK 回复，报告写入 `smoke-tests/run-*/smoke.json`。外部会话或本机直连配置会在调用模型前拒绝。仍不代替文件编辑、工具子进程、取消和多 Agent 协作的正式验收。

也可以先单独验证 Claude Code 的沙箱路径（读取现有 Claude 成员配置，使用隔离数据目录与独立房间，不影响日常 `.state`）：

```powershell
npm run test:claude -- --check       # 沙箱 23/23 + Claude 版本/room MCP 控制帧，不调用模型
npm run test:claude -- --allow-paid  # 一次真实模型轮次，需在终端设置配置的密钥（本机为 DEEPSEEK_API_KEY）
```

通过时验证 AppContainer 执行记录、原生会话和预期回复；报告写入 `.state/claude-smoke/run-*/`（稳定入口 `.state/claude-smoke/latest.json`）。配置细节见 [Claude Code 接入配置](docs/CLAUDE-CODE-CONFIG.md)。

沙箱路径下的真实 Agent 文件差异与成果应用可单独验证：

```powershell
npm run test:sandbox-artifact -- --allow-paid  # 一次真实沙箱模型轮次，需 DEEPSEEK_API_KEY
```

要求 Claude 在沙箱任务中修改 fixture 项目、生成差异交付物，owner 应用后原项目文件真实更新。报告写入 `.state/sandbox-artifact-smoke/`。

沙箱内两个 Agent 的任务转交/接力可单独验证（无需 Codex API Key）：

```powershell
npm run test:sandbox-handoff -- --allow-paid  # 两次真实沙箱模型轮次，需 DEEPSEEK_API_KEY
```

要求 Claude 先完成 v1 并应用差异成果，任务交接给 DeepSeek 后以 v2 完成，两条运行都必须带已验证的 AppContainer 记录。报告写入 `.state/sandbox-handoff-smoke/`。

Codex 也可以用本机直连模式做单项冒烟（使用本机 ChatGPT 登录，不复制账号目录；若访问 chatgpt.com 依赖代理，可设置 host 专用的 `ROOM_CODEX_PROXY`，不会影响其他 Agent）：

```powershell
$env:ROOM_CODEX_PROXY = 'http://127.0.0.1:7897'   # 按你的代理调整
npm run test:codex -- --check       # codex.exe/CODEX_HOME 检查，不调用模型
npm run test:codex -- --allow-paid  # 一次真实模型轮次（ChatGPT 配额），host 模式
```

报告写入 `.state/codex-smoke/run-*/`；注意 host 结果不能替代要求沙箱的正式验收。详见 [Codex 接入配置](docs/CODEX-CONFIG.md)。

DeepSeek 同样提供 host 单项冒烟（使用 DSH Desktop 或 npm 入口；需要终端已设置其密钥环境变量）：

```powershell
npm run test:deepseek -- --check       # 程序入口与密钥引用检查，不调用模型
npm run test:deepseek -- --allow-paid  # 一次真实模型轮次，host 模式
```

报告写入 `.state/deepseek-smoke/run-*/`；三项单 Agent 冒烟（Claude 沙箱、Codex host、DeepSeek host）都通过后，完整付费验收仍只差 Codex 沙箱所需的显式 API Key。

外部客户端令牌可以单独检查（只调用 `room_status`，不发起模型请求）：

```powershell
npm run test:external-mcp  # 检查 Claude Code 项目 .mcp.json 与 Codex config.toml 的房间令牌
```

报告写入 `.state/external-mcp/`；正常重启后令牌仍然有效，轮换令牌后需要先刷新客户端配置再执行本检查。

Claude Code 与 Codex 在本机实际使用**账号登录**（不是 API Key）。账号登录下的三 Agent 同房间 host 协作可单独验证：

```powershell
$env:DEEPSEEK_API_KEY = '<Claude 兼容端点与 DeepSeek host 共用>'
$env:ROOM_CODEX_PROXY = 'http://127.0.0.1:7897'   # Codex 访问 chatgpt.com 需要时设置
npm run test:team-host -- --allow-paid  # 三位成员各一次真实回复，消耗配额
```

账号登录 host 模式下还可以验证真实文件编辑与任务完成：

```powershell
npm run test:host-task -- --allow-paid  # 一次真实模型轮次，需 DEEPSEEK_API_KEY
```

报告写入 `.state/host-task-smoke/`：要求任务 `completed`、host 运行完成、目标文件被真实修改为预期内容。

账号登录 host 模式下验证真实命令/测试执行：

```powershell
npm run test:host-commands -- --allow-paid  # 一次真实模型轮次，需 DEEPSEEK_API_KEY
```

报告写入 `.state/host-commands-smoke/`：要求 Agent 真实运行 `npm test`、保存命令输出并完成任务。

账号登录 host 模式下验证运行取消：

```powershell
npm run test:host-cancel -- --allow-paid  # 一次真实模型轮次，需 DEEPSEEK_API_KEY
```

报告写入 `.state/host-cancel-smoke/`：要求长命令运行在取消后进入 `canceled` 终态。

账号登录 host 模式下验证两 Agent 任务接力：

```powershell
npm run test:host-handoff -- --allow-paid  # 两次真实模型轮次，需 DEEPSEEK_API_KEY
```

报告写入 `.state/host-handoff-smoke/`：要求任务先由 Claude v1 完成，交接给 DeepSeek 后 v2 再次完成，且任务版本/负责人正确。

账号登录与沙箱两条路径的边界、建议验收口径详见 [账号登录型 Agent 说明](docs/ACCOUNT-LOGIN.md)。

另有[完整真实 Agent 场景验收](docs/REAL-AGENT-ACCEPTANCE.md)，在新建的测试项目中检查三个编程 Agent 的会话、编辑、测试、群聊 MCP、取消、协作、目标变更和成果应用：

```powershell
npm run test:acceptance -- --check       # 仅前置检查，不发送模型请求
npm run test:acceptance -- --allow-paid  # 用户显式执行，约 15 个 Agent 请求，会产生费用
```

两个入口都保留沙箱门禁。完整场景只应用到脚本自己创建的测试项目，报告与工作区保留在 `.state/acceptance-tests/`；不会应用到用户业务项目。场景通过也不代替浏览器验收与全部系统隔离检查。

## 协议与接入

- [Room Protocol 0.1](docs/PROTOCOL.md)：命令、事件、身份、状态和恢复语义。
- `packages/protocol/schema`：生成的 JSON Schema；`npm run build:sdk` 可重建。
- `packages/client`：TypeScript 客户端，构建输出 ESM 和类型声明。`npm run test:sdk` 在独立离线项目验证两个实际安装包；打包方法见 `packages/client/README.md` 和 `packages/protocol/README.md`。
- [TS 客户端示例](examples/room-client.ts)：作为受信任的人类客户端连接；启动令牌不能交给 Agent。
- [A2A 连接器示例](examples/a2a-agent.ts)：讨论用途的第三方 Agent 服务，用自己的公网 HTTPS 反向代理接入，不包含代码执行。
- `scripts/room-bridge.mjs`：沙箱内 MCP stdio 桥，仅开放当前运行所属房间的四个工具。

## 数据与恢复

SQLite 使用 WAL，触发事件、上下文快照与入队工作在同一事务提交。快照保留覆盖游标，后续消息、成员职责或旧版本标记不会改写排队运行的上下文；已接受决策不受最近消息窗口截断。依赖完成后固定其版本和交付物输入。重启保留历史和排队工作；未完成运行标记中断，活动讨论停止，不自动重新执行写任务。原生会话、远程任务标识和已收到的用量随事件立即保存。

工作区、配置、交付物和应用日志保留在 `.state`，取消不会删除它们。升级前先关闭服务并备份整个 `.state`；迁移器在已有旧版数据库迁移前执行 checkpoint 并保存数据库备份。当前源码数据库版本为 3，新增事件注册、不可变日志、投影水位及历史基线；从旧版本升级前会保存数据库备份，不支持直接降级。正在运行的旧服务要重启后才会迁移。

应用成果有预检查和回滚日志。如果进程在更新原项目期间崩溃，下一次应用会阻止同一项目继续写入；根据 `.state/apply/<id>/journal.json` 中的原始字节备份人工核对并恢复，确认后才写入 `complete` 标记。不会自动覆盖崩溃后的人类修改。

本版本不包含云部署、联邦、自动发布或 PR 合并；不自动更新 Agent 或依赖。

并行与实时协作的后续构建按 [实施记录](docs/AGENT-PARALLEL-PROGRESS.md) 推进；该计划仍在进行中。事件回放与客户端缺口恢复可用 `npm run test:replay` 独立验证，无需模型额度。

当前并行协作开发版数据库为 v5：运行 generation/executionId 隔离、执行租约与 Room 写工具操作账本已接入。`npm run test:fencing-native` 在全新临时目录内用真实 AppContainer 和 MCP 管道验证旧进程拒写，不调用模型；证据索引为 `.state/fencing-native-probes/latest.json`。完整状态与剩余范围见上述实施记录。

开发版支持独立的持久草稿视图、final supersedes 链与 superseded 运行终态。普通历史消息保留当前工作；新的点名请求可替代该成员旧聊天任务，代码任务与讨论通过各自的修改目标/停止操作控制。数据库 v5 会阻止不理解这些状态的旧版本打开数据。
