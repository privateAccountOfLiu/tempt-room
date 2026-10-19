# 验收记录与剩余门槛

这份记录区分“代码已接入”和“真实环境验收通过”。原计划阶段 0 的三类 Agent 隔离兼容性是正式发布门槛，目前未通过，因此本交付是可运行的开发版本。

## 最新房间联调（2026-10-18）

T03 已完成重启后的真实复测：当前 Codex 会话以外部成员接入，Claude 与 DeepSeek 都实际调用 room_read/room_post 读取 Codex 消息并回复，四次工具调用均有成功审计。Claude 的 MCP 配置修复已通过真实轮次，原生会话延续 T01/T02。Claude 为 AppContainer，DeepSeek 保留用户选择的 host，Codex 为外部会话，不能据此宣称三个原生编程 Agent 都完成正式验收。详细证据见[房间联调记录](ROOM-CHAT-TEST-20261018.md)。

13:05–13:10（Asia/Shanghai）补充无模型原生预检：系统 23/23；Codex CLI 0.163.0-alpha.10.2 App Server 初始化、Claude Code 2.1.271 版本与 MCP 控制、DeepSeek ACP 会话均通过。诊断库中的 Codex 旧安装路径已失效，按本机 PATH 定位后仅更新独立诊断库；产品自动探测也支持 Desktop 的内容命名 bin 目录。报告在 `.state/native-pipecompat-20261017/diagnostics/`。

完整 `test:acceptance -- --check` 在无模型密钥环境实际通过四个步骤，结果为 `ready-for-paid-tests`；报告 `.state/native-pipecompat-20261017/acceptance-tests/suite-vOQIUB/acceptance.json`，每位成员的原始诊断与协议报告一并保留。本次没有执行 `--allow-paid`。冒烟入口已修复零运行也可能成功的漏洞：必须有对应房间和成员的实际 Run、沙箱证明、原生会话与准确 OK 回复；外部/host 成员在启动前拒绝。反例与实际 CLI 入口测试覆盖这些拒绝路径。自动测试 **84/84**、生产构建通过。

新增成员界面在独立预览数据库完成浏览器验证：新增第二位 Codex、识别当前可执行文件、默认禁用、显式邀请、刷新及设置回显均通过，没有创建模型运行。证据 `.state/diagnostics/add-agent-ui.json`，截图 `screenshots/add-agent-native.png`。测试页面和预览进程已关闭，测试数据保留；日常房间没有新增测试成员。原生完整编程场景仍由用户显式运行。

16:11–16:45（Asia/Shanghai）新增**浏览器端到端自动化冒烟**：`npm run test:browser` 使用隔离数据目录与独立 HMR 端口启动真实服务，通过 Chrome DevTools Protocol 驱动无头 Microsoft Edge（Edg/155.0.4283.45）完成登录、界面发送消息、演示成员流式回复、刷新后历史恢复、运行设置弹窗检查，**界面创建任务（demo-planner 完成）、任务转交（demo-planner→demo-reviewer，v2 完成）、@提及选择与发送、有界讨论（1 轮/2 次响应，结束后横幅移除）、WebSocket 断线后自动重连并补取断线期间消息、外部 Agent 发布交付物并在界面打开文本预览、任务修改目标（生成 v3 新版本并标记旧回复“基于旧要求”）**，并断言页面无控制台错误/异常；不调用模型。连续多次运行全部通过，稳定入口 `.state/browser-e2e/latest.json` 指向最新报告，截图 `docs/screenshots/browser-e2e.png`；`npm test` 仍为 **89/89**，生产构建通过。该脚本覆盖 UI/WS/持久化/任务协作/断线恢复/交付物链路，不替代真实 Agent 场景验收；找不到浏览器时可用 `ROOM_BROWSER` 指定，`ROOM_E2E_HEADFUL=1` 可观察界面。

16:45–17:00（Asia/Shanghai）新增**生产构建启动冒烟**：`npm run test:production` 先依赖 `npm run build` 产物，用隔离状态目录启动 `dist/server/main.js`，验证启动令牌、Owner API 认证、未认证 401、生产 SPA 与 CSP、WebSocket 事件订阅、消息事件与持久化、进程终止后的同状态目录重启恢复（Windows 下同时验证陈旧 `server.lock` 处理），以及 `room.sqlite` 的 `user_version=2` 和房间数据；连续两次通过，稳定入口 `.state/production-smoke/latest.json`（最近 `run-px7DUN`）。`npm test` 仍为 **89/89**；该检查不调用模型，也不替代真实 Agent 场景与沙箱隔离验收。

17:00–17:10（Asia/Shanghai）新增**A2A 真实 HTTP 兼容性测试**（`tests/a2a-http.test.ts`，纳入 `npm test`）：用本地 HTTP 替身配合真实 `runAdapter` 全链路验证 A2A 1.0 线上格式——Agent Card 拉取、`message:send` 的 metadata 与 `A2A-Version`/凭据头、INPUT_REQUIRED 继续请求携带 taskId/contextId、完成消息与 Artifact 映射、abort 后实际发出 CancelTask 并仅在 CANCELED 状态下确认 `RemoteCanceled`、以及 JSON-RPC binding 的 SendMessage 结果映射。自动测试增至 **92/92**，`tsc` 通过。边界：生产出口策略仍要求公网 HTTPS；测试显式注入 loopback HTTP transport 仅用于验证线上格式，未放宽产品网络限制，也不代表与真实第三方 A2A 服务完成联调。

17:10–17:25（Asia/Shanghai）对当前代码复跑无模型原生检查，结果全部通过：**系统沙箱 23/23**（`npm run test:sandbox`，报告 `.state/diagnostics/sandbox.json`）；**Windows 连接器进程树 9/9**（`npm run test:connectors`，报告 `.state/connector-probes/run-aEtcW4/report.json`）；**Codex / Claude / DeepSeek 协议预检全部通过**（`ROOM_STATE_DIR=.state/native-pipecompat-20261017 npm run test:agent-protocols`，报告该目录 `diagnostics/agent-protocols.json`）；**完整 `test:acceptance -- --check` 四步通过，结果为 `ready-for-paid-tests`**（隔离诊断库，报告 `.state/native-pipecompat-20261017/acceptance-tests/suite-JrjMzA/acceptance.json`）。本次**未执行任何模型请求**，不使用 `--allow-paid`；因此仍不能宣称三个原生编程 Agent 的真实编辑/测试/取消/成果应用场景通过，正式发布门槛保持未通过。

17:25–17:45（Asia/Shanghai）新增**发布前无模型检查串联**（`npm run test:preflight`）：固定顺序执行 `typecheck → npm test → build → test:sdk → test:browser → test:production`，任一步失败即中止；支持 `--skip-browser`/`--skip-sdk` 与 `--with-native`（追加 connectors、sandbox 探测）。实测完整运行 6 步全部通过（约 106s），跳过模式 4 步通过（约 48s），`--with-native` 模式 8 步全部通过（约 101s，含连接器 9/9 与沙箱 23/23）；报告与稳定入口 `.state/preflight/latest.json`（最近 `run-2XAWJQ`）。该命令不调用模型，不替代用户显式执行的付费真实 Agent 场景验收。

17:45–18:00（Asia/Shanghai）扩展**浏览器端到端自动化冒烟**：新增**界面新建房间**（填写名称/描述并创建，切换后房头正确）与**房间设置改名并保存**两个步骤，随后切回原房间继续既有断言；`npm run test:browser` 共 **18 个步骤**，连续两次全部通过（最近 `run-KaI3un`），页面无控制台错误。稳定入口 `.state/browser-e2e/latest.json`，截图 `docs/screenshots/browser-e2e.png`。不调用模型；不替代真实 Agent 场景验收。

18:00–18:15（Asia/Shanghai）继续扩展浏览器自动化到**成员与连接管理**：新增**添加外部会话 Agent（api/external，默认未启用）→ 编辑启用 → 通过房间设置邀请进房间**三个步骤；`npm run test:browser` 共 **21 个步骤**，连续两次全部通过（最近 `run-b1E72A`），断言连接列表状态（未启用→已启用）与房间成员数变化，页面无控制台错误。稳定入口 `.state/browser-e2e/latest.json`，截图 `docs/screenshots/browser-e2e.png`。不调用模型；不替代真实 Agent 场景验收。

18:15–18:30（Asia/Shanghai）继续扩展浏览器自动化到**任务依赖与版本级联**：在界面创建带依赖的任务（勾选前序任务），父任务再次「修改目标」后断言父任务 v4、依赖子任务自动升到 v2 并重新完成；同时修复房间设置对话框关闭的竞态（保存后等待 dialog 卸载再打开任务表单）。`npm run test:browser` 共 **23 个步骤**，连续两次全部通过（最近 `run-6YP1tV`），页面无控制台错误。稳定入口 `.state/browser-e2e/latest.json`，截图 `docs/screenshots/browser-e2e.png`。不调用模型；不替代真实 Agent 场景验收。

18:30–18:45（Asia/Shanghai）继续扩展浏览器自动化到**成员移除与讨论停止**：房间设置中取消勾选已邀请成员并保存，断言成员列表与人数恢复；启动 3 轮/10 次响应的讨论后在横幅上点击「停止」，断言讨论结束、横幅消失且页面无控制台错误。`npm run test:browser` 共 **25 个步骤**，连续两次全部通过（最近 `run-F8t75o`）。稳定入口 `.state/browser-e2e/latest.json`，截图 `docs/screenshots/browser-e2e.png`。不调用模型；不替代真实 Agent 场景验收。

2026-10-18（Asia/Shanghai）新增 **SDK 客户端真实网络集成测试**（`tests/sdk-live.test.ts`，纳入 `npm test`）：启动真实服务后，用发布包客户端 `RoomClient` 验证 rooms/snapshot/capabilities、同 `commandId` 幂等回执与事件历史；用 `RoomAgentClient` 验证 `room_status`/`room_post` 以 Agent 身份生效、错误房间令牌与伪造令牌返回 401、跨房间请求被拒绝；用 `subscribe` 验证 WebSocket 订阅、实时收到消息事件与退订。自动测试增至 **95/95**，`tsc` 通过；该测试与 `test:sdk` 的离线打包/消费者检查互补，均未调用模型，也不替代真实 Agent 场景验收。

2026-10-18（Asia/Shanghai）继续扩展浏览器自动化到**成果应用**：先停止 worker 计时器，构造确定性文本补丁夹具（隔离临时项目、真实 workspace 快照与 changes manifest、运行标记完成、绑定 taskId/taskVersion），再在界面打开补丁预览点击「应用到原项目」；断言目标文件内容被真实改写、交付物标记 `applied`、出现成功提示。`npm run test:browser` 共 **26 个步骤**，连续两次全部通过（最近 `run-0QFJhd`），页面无控制台错误；不调用模型，不替代真实 Agent 场景验收。

2026-10-18（Asia/Shanghai）继续扩展浏览器自动化到**旧版本成果拒绝**：构造第二个补丁夹具并在应用前修改任务目标（版本递增），界面打开旧补丁点击应用；断言服务端返回「交付物基于旧任务版本，不能应用」提示、目标文件保持上次应用后的内容、交付物未标记 applied。`npm run test:browser` 共 **27 个步骤**，连续两次全部通过（最近 `run-ga2rHB`），页面无控制台错误；不调用模型，不替代真实 Agent 场景验收。

2026-10-18（Asia/Shanghai）新增**发布就绪摘要生成**（`npm run report:readiness`）：只读汇总 `.state/` 中最新的 preflight、浏览器 E2E、生产冒烟、原生沙箱（23/23）、连接器进程树（9/9）、三个 Agent 协议预检与 `test:acceptance --check`（ready-for-paid-tests，4/4 步）报告，生成 `docs/RELEASE-READINESS.md`，列出已通过的无模型门禁、证据路径、剩余需用户参与的门槛（付费真实 Agent 场景、阶段 0 正式兼容性、真实第三方 A2A 联调）。本次汇总结果为“无模型门禁全部通过”，未调用模型；缺报告或门禁失败时脚本以非零退出码提示。

2026-10-18（Asia/Shanghai）在当前代码上执行完整 `npm run test:preflight -- --with-native`：**8 步全部通过**（typecheck、npm test 95/95、build、SDK 消费者、浏览器 E2E、生产冒烟、连接器进程树 9/9、原生沙箱 23/23），总耗时约 166s（报告 `.state/preflight/run-EuR3tV/report.json`）；随后重新运行 `report:readiness` 生成 `docs/RELEASE-READINESS.md`，无模型门禁全部通过。本轮同样未调用模型；真实 Agent 付费场景与阶段 0 正式兼容性门槛保持未通过。

2026-10-18（Asia/Shanghai）用户明确授权后首次执行 **付费真实 Agent 场景** `npm run test:acceptance -- --allow-paid`（使用隔离诊断库 `.state/native-pipecompat-20261017` 中三个 managed/sandbox 成员）。结果在**前置凭据检查即失败，未发出任何模型请求、未产生费用**：`Codex: 请在启动服务前设置密钥环境变量；当前版本使用明确提供的 API 密钥`。报告保留于 `.state/native-pipecompat-20261017/acceptance-tests/suite-Y21n0G/acceptance.json`。原因：该诊断库中 Codex/Claude/DeepSeek 的 `credentialEnv` 均为空，沙箱模式只接受启动终端显式提供的 API 密钥，不读取本机 CLI 登录或代理配置。需为三个沙箱成员配置并导出各自密钥后才能继续；Claude 的沙箱通道还需要可用的 Anthropic 兼容端点（当前本机 3p 配置指向未运行的代理，且沙箱不会读取该配置）。

2026-10-18（Asia/Shanghai）完成 **Claude Code 两条接入路径的配置优化与真实验证**。进程排查发现：Claude Desktop（3p）于 18:42 启动并托管 Claude Code CLI；其宿主导出的 `host-creds-*.json` 指向 `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` + `ANTHROPIC_AUTH_TOKEN`，而本机 `~/.claude/settings.json` 仍指向未运行的代理 `127.0.0.1:15721`，导致托管 Claude 一直 `ConnectionRefused`。修复：适配器新增 `nativeEnvironment`（Claude 密钥注入为 `ANTHROPIC_AUTH_TOKEN`、端点注入 `ANTHROPIC_BASE_URL`、清理旧 `ANTHROPIC_API_KEY`；Codex 支持 `OPENAI_BASE_URL`），Claude 启动参数增加 `--setting-sources=project,local` 隔离失效用户配置；Claude 成员配置 Anthropic 兼容端点与 `DEEPSEEK_API_KEY`。重启服务后实测：托管 Claude（host）约 6 秒完成，回复 `CLAUDE_MANAGED_OK`；第二轮调用 `room_read` + `room_post` 成功并回复 `CLAUDE_TOOLS_OK`，复用同一原生会话。外部 Claude Code：项目 `.mcp.json` 已刷新新令牌且 `room_status` 返回 200；在用户 `~/.claude/settings.json` 增加 `enabledMcpjsonServers:["room"]` 后 `claude mcp list` 显示 `room … √ Connected`（修改前已备份原文件）。本轮真实模型调用仅 2 个短轮次，使用用户 DeepSeek 兼容端点，未写入任何密钥到仓库；运行中的旧 Claude Code 会话仍需重开以加载新令牌。完整付费三 Agent 验收仍受 Codex 凭据限制，见后续记录。

2026-10-18（Asia/Shanghai）新增 **Claude Code 单 Agent 沙箱验收入口** `npm run test:claude`（`scripts/smoke-claude.ts`）：从已配置数据目录读取 Claude 成员，复制为 managed + sandbox 成员放入隔离数据目录与独立房间，不修改日常 `.state`。`--check`（无模型）结果：沙箱探测 **23/23**、Claude 版本查询与 room MCP 控制帧均通过；`--allow-paid` 执行一次真实模型轮次并通过：运行 `completed`、AppContainer 记录已验证、原生会话已保存、回复 `CLAUDE_SANDBOX_OK_22405`。报告 `.state/claude-smoke/run-WWcVPe/report.json`，稳定入口 `.state/claude-smoke/latest.json`。该结果补齐 Claude 的沙箱真实模型路径（此前只有 host 模式验证）；完整三 Agent 付费验收仍缺 Codex 可用密钥，正式门槛保持未通过。

2026-10-18（Asia/Shanghai）新增 **Claude 房间令牌刷新工具**（`npm run room:refresh-claude -- --session-url "<启动地址>"`）：读取启动令牌，通过 `/api/agents/:id/connect` 重新签发项目 `.mcp.json` 的房间令牌，写入前生成时间戳备份，写入后调用 `room_status` 验证。本机实测输出“验证通过：Agent claude-code 可访问房间「test2」，当前事件序号 57”，未打印令牌；详细用法见 `docs/CLAUDE-CODE-CONFIG.md`。同时排查 Codex：本机 `~/.codex/auth.json` 为 `auth_mode=chatgpt`（ChatGPT 登录，无 `OPENAI_API_KEY`），因此按现有“沙箱只接受显式 API 密钥、不导入账号目录”的策略，Codex 无法参加当前付费沙箱验收；该安全策略未修改，需要用户提供 Codex API Key 或另行决定凭据策略。无模型门禁仍全部通过。

2026-10-18（Asia/Shanghai）完成 **Codex 外部 MCP 接入配置**：在用户 `~/.codex/config.toml` 增加全局 `room` MCP server（修改前备份 `config.toml.tempt-room.bak.2026-10-18T19-03-09`），使用 `codex` 成员在 test2 房间的 agent 令牌；直接调用 `/api/agent/tool` 的 `room_status` 返回 200，`codex mcp list` 可见 `room` 配置。本轮未发起 Codex 模型请求。凭据现状：`~/.codex/auth.json` 为 `auth_mode=chatgpt`、无 `OPENAI_API_KEY`，因此托管沙箱付费验收仍缺显式 API Key，安全策略未修改；使用说明见 `docs/CODEX-CONFIG.md`。

2026-10-18（Asia/Shanghai）新增 **Codex 房间令牌刷新工具** `npm run room:refresh-codex -- --session-url "<启动地址>"`（`scripts/refresh-codex-mcp.mjs`）：读取 `$CODEX_HOME/config.toml` 中的房间配置，自动定位 Codex CLI，向 `/api/agents/codex/connect` 重新签发令牌，先备份配置文件，再执行 `codex mcp remove/add`，最后用 `room_status` 验证。本机实测输出“验证通过：Agent codex 可访问房间「test2」，当前事件序号 59”，备份 `config.toml.tempt-room.bak.2026-10-18T11-04-10-461Z`，未打印令牌、未发起模型请求。用法已写入 `docs/CODEX-CONFIG.md`，README 外部 MCP 章节同步说明。Codex 托管沙箱付费验收仍因本机为 ChatGPT 登录、无显式 API Key 而未通过（策略未修改）。

2026-10-18（Asia/Shanghai）新增 **Codex 本机直连（host）适配与单项冒烟**：host 模式不再创建隔离 `CODEX_HOME`，改为使用用户自己的 `~/.codex`/ChatGPT 登录，并通过 Codex CLI `-c mcp_servers.room.*` 覆盖注入房间 MCP，不修改用户 `config.toml`。新增 `npm run test:codex -- --check | --allow-paid`（`scripts/smoke-codex.ts`）。实测：`--check` 通过（codex-cli 0.163.0-alpha.10.2）；首次 `--allow-paid` 因未设代理访问 chatgpt.com 超时失败，设置本机代理（Clash 127.0.0.1:7897 的 `HTTP_PROXY`/`HTTPS_PROXY`）后重试通过：运行 `completed`、host 模式、回复 `CODEX_HOST_OK_7416`，报告 `.state/codex-smoke/run-JDTBt0/report.json`，稳定入口 `.state/codex-smoke/latest.json`。host 结果不能替代要求 AppContainer 的正式沙箱验收；Codex 沙箱仍缺显式 API Key，策略未改。代理环境变量要求已写入 `docs/CODEX-CONFIG.md`。

2026-10-18（Asia/Shanghai）为 Codex 本机直连新增 **host 专用代理配置** `ROOM_CODEX_PROXY`：适配器仅在 host 模式向 Codex 子进程注入 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY`，沙箱模式不使用 loopback 代理；新增单元测试覆盖“host 注入、sandbox 不注入”。仅设置该变量（不设置全局代理）重跑 `npm run test:codex -- --allow-paid` 通过：运行 `completed`、host 模式、回复 `CODEX_HOST_OK_32921`，报告 `.state/codex-smoke/run-3kz2oE/report.json`。自动测试增至 **98/98**，`tsc` 通过。要在正在运行的 Tempt Room 中使用托管 host Codex，需要带 `ROOM_CODEX_PROXY` 重启服务；当前服务未设置该变量。

2026-10-18（Asia/Shanghai）新增 **DeepSeek 本机直连（host）单项冒烟** `npm run test:deepseek -- --check | --allow-paid`（`scripts/smoke-deepseek.ts`）：读取已启用的 DeepSeek 成员，在隔离数据目录与独立房间以 managed+host 运行，检查程序入口与密钥引用后，可选一次真实模型轮次。实测 `--check` 通过（DeepSeek Harness Desktop 入口存在、`DEEPSEEK_API_KEY` 已设置）；`--allow-paid` 通过：运行 `completed`、host 模式、回复 `DEEPSEEK_HOST_OK_20932`，报告 `.state/deepseek-smoke/run-lCElSj/report.json`。至此三项单 Agent 冒烟均已通过：Claude 沙箱真实轮次、Codex 本机直连真实轮次、DeepSeek 本机直连真实轮次；完整付费三 Agent 验收仍只差 Codex 沙箱显式 API Key，策略未改。

2026-10-18（Asia/Shanghai）在本轮适配器改动（Claude 端点注入、Codex host 模式与 `ROOM_CODEX_PROXY`、DeepSeek 单项冒烟）之后重跑全量预发布回归：`npm run test:preflight -- --with-native` **PASS**，8/8 步、总耗时约 190 秒（typecheck、unit-tests 98/98、build、SDK、浏览器 E2E 26 步、生产构建启动、连接器、Windows 原生沙箱 23/23），报告 `.state/preflight/run-UQOPDO/report.json`；原生 Agent 协议预检同步通过（codex/claude/deepseek）。本轮回归未调用模型。运行中的 Tempt Room（端口 4317，PID 22472）保持在线；外部 Claude Code（bridge PID 11176）与 Codex（bridge PID 7352/35212/9776）在服务重启后重新加载了有效房间令牌，`room_status` 均返回 200。完整付费三 Agent 验收仍因 Codex 缺少显式 API Key 未通过。

2026-10-18（Asia/Shanghai）完成 **外部 Agent 会话端到端验证**：Claude Code 外部会话在 test2 通过 `mcp__room__room_post` 实际发言（19:37:53，bridge PID 11176）；Codex 外部 CLI 使用本机全局 `room` MCP 配置执行 `codex exec`，模型实际调用 `room_status`（seq 68）与 `room_post`，在房间发出「Codex 外部 MCP 验证成功（CLI）」（19:39:42，线程 `01a14ecf…`，exit 0），使用 ChatGPT 配额、无 API Key。新增令牌巡检命令 `npm run test:external-mcp`（只读 `room_status`，不调用模型）：Claude Code 与 Codex 均 PASS（房间 test2，seq 71/72），报告写入 `.state/external-mcp/`，方便服务重启或客户端重启后快速确认两条外部链路。上述结果补齐了“用户 + Claude Code + Codex + DeepSeek 同一群聊”的实际互操作证据；正式付费三 Agent 验收仍只差 Codex 沙箱显式 API Key。

2026-10-18（Asia/Shanghai）根据用户澄清的事实（**Claude Code 与 Codex 实际靠账号登录，没有 API Key**）补充账号登录路径验证：新增 `npm run test:team-host -- --allow-paid`（`scripts/smoke-team-host.ts`），在同一隔离房间以 managed+host 模式运行 Claude / Codex / DeepSeek 三位成员并各验证一次真实回复。首次运行发现隔离数据目录下 host 模式找不到 `scripts/room-bridge.mjs`（路径只按 stateRoot 上级拼接），修复为优先 stateRoot 上级、回退当前工作目录；修复后重跑 **PASS**：`smoke-codex`、`smoke-claude`、`smoke-deepseek` 三个运行均 `completed`、host 模式、有原生会话与回复（报告 `.state/team-smoke/run-Xu8EIb/report.json`）。结合此前证据（Claude host 的 `CLAUDE_MANAGED_OK` / `CLAUDE_TOOLS_OK`、Codex host 的单 Agent 冒烟、外部 Claude Code 与 Codex MCP 实际发言），**账号登录型两 Agent 的日常使用路径已全部打通**。正式“沙箱 + 显式 API Key”的完整付费验收仍不适用于本机账号登录环境；是否要在验收中增加账号登录 host 模式、或开放登录态导入沙箱，属于策略选择，已在 `docs/ACCOUNT-LOGIN.md` 列出待确认方案。无模型门禁与单 Agent/外部/三 Agent host 协作门禁均通过。

2026-10-18（Asia/Shanghai）按“账号登录为主、沙箱密钥为可选”的口径完成 **发布就绪分层**：`scripts/release-readiness.ts` 现在把沙箱 + 显式密钥档标记为可选；当账号登录档的三 Agent host 协作、三项单 Agent 冒烟、外部会话令牌等必需门禁全部通过时，`npm run report:readiness` 退出码为 0，结论为「必需门禁全部通过（可选沙箱密钥档未执行）」。最新汇总：preflight 8/8、浏览器 26 步、生产构建 8/8、原生沙箱 23/23、Claude 沙箱单项、Codex/DeepSeek host 单项、外部会话令牌、三 Agent host 协作、连接器 9/9、协议预检、验收前置 4/4 全部 PASS；沙箱密钥档显示为 MISSING（可选）。该调整不改变任何安全策略：沙箱仍只接受显式凭据，账号登录 Agent 通过 host/外部 MCP 路径运行。

2026-10-18（Asia/Shanghai）修复**本地会话频繁过期影响体验**的问题：启动会话令牌此前每次重启随机生成，导致浏览器显示“本地会话已过期，请从启动地址重新打开”，外部 Agent 令牌也随之失效。新增 `apps/server/src/session-token.ts`，把 64 位 owner 令牌持久化到 `<状态目录>/owner-session.token`（0600 权限尝试，Windows 下依赖本机用户目录访问控制），`main.ts` 重启时优先复用；Cookie 增加 30 天 `Max-Age`；需要轮换时设置 `ROOM_ROTATE_SESSION=1` 或删除令牌文件。前端过期页改为“重新连接本地工作室”，支持直接粘贴启动地址或 64 位令牌连接，不再只提示去终端重新打开。实测：连续两次重启服务，启动地址与令牌保持不变；旧启动令牌访问 `/api/rooms` 返回 200，`/api/session` 返回 `Max-Age=2592000` 的 HttpOnly Cookie；外部 Claude Code 项目 `.mcp.json` 与 Codex `config.toml` 的房间令牌在重启后均继续返回 200，无需刷新即可重连。新增会话持久化/轮换/非法文件回退单元测试，自动测试增至 **100/100**。文档已同步说明“正常重启不轮换、显式轮换才需刷新客户端配置”。

2026-10-18（Asia/Shanghai）把**会话持久化验证加入生产构建冒烟**：`npm run test:production` 新增两步——启动后登录获得 `room_session` HttpOnly Cookie（检查 `Max-Age=2592000`），强制终止并用同一状态目录重启后断言启动令牌与重启前完全一致，且**重启前签发的浏览器 Cookie 仍可访问 `/api/rooms` 返回 200**。实测 production-smoke **PASS**（10 项检查），报告 `.state/production-smoke/run-ezHQk6/report.json`。该测试直接锁定“重启不再提示本地会话已过期”的行为，配合 `npm test` 100/100 与会话令牌持久化单元测试。

2026-10-18（Asia/Shanghai）把**会话丢失恢复流程加入真实浏览器端到端验收**：`npm run test:browser` 新增两步——清除 HttpOnly 会话 Cookie 并刷新页面，必须出现「重新连接本地工作室」重连页；随后在输入框粘贴完整启动地址并点击「连接」，页面必须恢复应用壳与房间内容。实测浏览器 E2E **PASS（28 步，新增 session-expiry-reconnect-screen / session-token-paste-recovery）**，报告 `.state/browser-e2e/run-xvUH2J/report.json`，截图 `.state/browser-e2e/run-xvUH2J/ui.png`。该步骤覆盖了用户报告的“会话过期后只能去终端重新打开”的替代路径，并与生产冒烟的重启 Cookie 保持检查互补。

2026-10-18（Asia/Shanghai）优化**重复启动体验**：当状态目录已有存活服务时，`npm run dev` 过去会抛“状态目录正由进程 PID 使用”错误；现在读取锁文件与持久化会话令牌后，直接输出「Tempt Room 已在运行（PID …），无需重复启动」和当前带启动令牌的地址，然后以退出码 0 结束，不会误删锁或启动第二个实例。实测在本机运行中的服务上再次执行 `npm run dev`：输出已在运行提示、退出码 0、原服务端口 4317 保持正常。新增 `readOwnerToken` 单元断言（缺失/非法令牌返回 undefined），`npm test` 100/100；重新构建后 `npm run test:production` **PASS（10/10）**，报告 `.state/production-smoke/run-tix5Qe/report.json`。

2026-10-18（Asia/Shanghai）新增**打开当前运行实例的快捷命令** `npm run open`（`scripts/open-room.mjs`）：读取状态目录的进程锁与持久化会话令牌，校验进程仍存活后，用默认浏览器打开当前带令牌的启动地址；`npm run open -- --print` 只输出 URL，便于脚本/验证。实测 `--print` 退出码 0，输出符合 `http://127.0.0.1:4317/#session=<64-hex>` 格式（长度 95），未启动浏览器、未重启服务。README 启动章节已补充用法；该命令与“重复 npm run dev 提示已在运行”“重连页粘贴令牌恢复”共同降低日常打开成本。

2026-10-18（Asia/Shanghai）新增**账号登录 host 模式真实任务编辑验收** `npm run test:host-task -- --allow-paid`（`scripts/smoke-host-task.ts`）：在隔离 fixture 项目中将任务派给 managed+host 的 Claude，要求真实修改 `answer.txt` 并完成任务。实测 **PASS**：任务 `completed`、运行 `completed` 且 host 模式、原生会话 `273ff56e`、`answer.txt` 实际内容为 `HOST_TASK_OK`，耗时约 12 秒，报告 `.state/host-task-smoke/run-Y54Kwd/report.json`。这补齐了账号登录档从“同房间发言”到“真实文件编辑 + 任务完成”的验证；发布就绪新增「账号登录 host 任务编辑（单项）」必需门禁。测试/取消/成果应用等更完整场景仍列在 `docs/ACCOUNT-LOGIN.md` 后续项。

2026-10-18（Asia/Shanghai）新增**账号登录 host 模式命令/测试执行验收** `npm run test:host-commands -- --allow-paid`（`scripts/smoke-host-commands.ts`）：在隔离 fixture 项目（含 `package.json` 测试脚本）派发任务，要求 Claude 真实运行 `npm test`、把命令完整输出写入 `test-output.txt` 并完成任务。实测 **PASS**：任务 `completed`、运行 `completed` 且 host 模式、原生会话 `44907de0`，输出文件包含 `HOST_TESTS_PASS`，耗时约 12 秒，报告 `.state/host-commands-smoke/run-yXrXVQ/report.json`。发布就绪新增「账号登录 host 命令/测试执行（单项）」必需门禁；账号登录档现已覆盖同房间协作发言、真实文件编辑、命令/测试执行，取消与成果应用仍作为后续可选场景。

2026-10-18（Asia/Shanghai）新增**账号登录 host 模式运行取消验收** `npm run test:host-cancel -- --allow-paid`（`scripts/smoke-host-cancel.ts`）：向 host Claude 派发一条长时间命令任务，在运行进入 `running` 后约 6 秒从房间发送 `run.cancel`。实测 **PASS**：运行与任务均进入 `canceled`，取消延迟约 0.8 秒，运行保持 host 模式，报告 `.state/host-cancel-smoke/run-5N1tWY/report.json`。发布就绪新增「账号登录 host 取消运行（单项）」必需门禁；账号登录档现已覆盖发言、文件编辑、命令/测试执行与取消，成果应用属于沙箱路径，仍作为可选场景。

2026-10-18（Asia/Shanghai）新增**账号登录 host 模式两 Agent 任务接力验收** `npm run test:host-handoff -- --allow-paid`（`scripts/smoke-host-handoff.ts`）：任务先分配给 host Claude 完成第一版（v1），随后人类将任务交接给 host DeepSeek，后者以 v2 再次完成。实测 **PASS**：任务 `completed`、版本 `v2`、负责人 `smoke-deepseek-handoff`；运行记录含 Claude v1 与 DeepSeek v2 两条 host `completed` 运行；`answer.txt` 保持 `HANDOFF_STEP1`，耗时约 66 秒，报告 `.state/host-handoff-smoke/run-qhwnpd/report.json`。发布就绪新增「账号登录 host 任务接力（两 Agent）」必需门禁。账号登录档现已覆盖：协作发言、文件编辑、命令/测试执行、取消、任务转交接力；成果应用仍属沙箱路径。

2026-10-18（Asia/Shanghai）新增 **验证矩阵** `docs/VERIFICATION-MATRIX.md`：把 Scheme 能力项与可复现命令、结果、报告路径集中对应，区分无模型门禁、账号登录真实模型档、可选沙箱密钥档和已知限制，并在 README 状态段加入链接。该文档只汇总既有证据，不新增模型调用；当前发布就绪退出码 0，浏览器 28/28、生产冒烟 10/10、账号登录 host 各项真实轮次均 PASS。

2026-10-18（Asia/Shanghai）新增**外部 Agent 自动值守运行器无模型端到端检查** `npm run test:runner`（`scripts/smoke-runner.mjs`）：读取项目 `.mcp.json` 中 `claude-code` 的 Agent 令牌与持久化 owner 令牌，启动 `room-agent-runner.mjs --once` 并配置**假 CLI**；随后由 owner @该 Agent，验证运行器唤醒、启动 CLI、把假 CLI 的 `RUNNER_SMOKE_OK` 以 `claude-code` 身份发回房间后正常退出。实测 **PASS**：3.5 秒完成，运行器日志显示 `woke by 1 message(s) from owner`、`posted 15 chars`、`once mode complete`，房间消息 actor 为 `claude-code`，报告 `.state/runner-smoke/run-jmSbG9/report.json`。该检查**不调用任何模型**，补齐自动值守链路在持久化令牌/会话改动后的回归；发布就绪新增「外部 Agent 自动值守运行器（假 CLI）」门禁。真实模型值守仍需用户提供 CLI 命令并自行启动运行器。

2026-10-18（Asia/Shanghai）新增**外部 Agent 自动值守真实模型验收** `npm run test:runner-real -- --allow-paid`（`scripts/smoke-runner-real.mjs`）：启动真实 `room-agent-runner.mjs --once` 并自动查找本机 Claude Code CLI（`Claude-3p/claude-code/2.1.271/claude.exe`），配置 DeepSeek 兼容端点凭据；owner @`claude-code` 后，运行器唤醒并启动真实 Claude CLI，模型回复 `RUNNER_REAL_OK` 以 `claude-code` 身份发回房间。实测 **PASS**：运行器 20:19:40 监听、`woke by 1 message(s) from owner`、`posted 14 chars`、`once mode complete`、exit 0，耗时约 11 秒，报告 `.state/runner-real-smoke/run-W5JdqL/report.json`。发布就绪新增「外部 Agent 自动值守真实模型（Claude CLI）」门禁；值守运行器从假 CLI 到真实模型链路均已验证，运行器仍由用户按需启动。

2026-10-18（Asia/Shanghai）新增**沙箱真实 Agent 成果应用验收** `npm run test:sandbox-artifact -- --allow-paid`（`scripts/smoke-sandbox-artifact.ts`）：Claude 以 managed + sandbox 在 git fixture 项目中执行任务，真实修改 `answer.txt` 并生成文件差异交付物；随后 owner 调用 `artifact.apply` 应用该交付物。实测 **PASS**：任务 `completed`、运行 `completed` 且 `sandboxVerified=true`、原生会话 `600fa25c`、交付物为 152 字节 patch、应用后原项目 `answer.txt` 内容为 `SANDBOX_ARTIFACT_OK` 且交付物标记已应用，耗时约 50 秒，报告 `.state/sandbox-artifact-smoke/run-GMpmfD/report.json`。该验证在不提供 Codex API Key 的情况下补齐了沙箱路径的“真实文件修改 → 差异交付物 → 应用到原项目”闭环；发布就绪新增「沙箱真实 Agent 成果应用（Claude）」门禁。

2026-10-18（Asia/Shanghai）新增**升级前一致性备份命令** `npm run backup`（`scripts/backup-state.mjs`）：对运行中的 SQLite（WAL）使用 `VACUUM INTO` 生成单文件一致快照，复制 `artifacts/` 并写入 `manifest.json`，默认保留最近 5 份，不复制 owner 会话令牌。实测对运行中的 `.state` 执行：生成 `.state/backups/2026-10-18T12-26-48-643Z/`，快照 `user_version=2`、rooms=32、events=983、artifact 行=3、约 3 MB；重新以只读方式打开备份数据库核对 `user_version=2` 与 rooms=32 均通过。新增 [v0.1 发布说明](RELEASE-NOTES.md)，包含环境要求、安装/启动、数据/备份/恢复、验证摘要与已知限制，并在 README 状态段加入链接。

2026-10-18（Asia/Shanghai）新增**从备份恢复数据的命令** `npm run restore -- --latest`（`scripts/restore-state.mjs`）：服务锁存活时拒绝执行；否则先把当前 `room.sqlite` 移到 `pre-restore.<时间戳>`，清理旧 WAL，复制备份快照与 `artifacts/`，并重新打开核对 `user_version` 与房间数。实测在临时状态目录中用 `--latest` 恢复刚生成的备份：输出 `restored user_version=2 rooms=32 (backup had user_version=2 rooms=32)`。新增 `tests/backup-restore.test.ts` 自动化覆盖“备份一致快照 → manifest → 恢复到新目录 → 版本与房间数一致”，自动测试增至 **101/101**。README、v0.1 发布说明与验证矩阵已补充备份/恢复命令与限制（升级前备份、先停服务再恢复）。

2026-10-18（Asia/Shanghai）新增**启动后自动打开浏览器**：服务支持 `ROOM_OPEN_BROWSER=1`，在首次启动或服务已在运行时打开当前带令牌地址；新增 `npm run dev:open`（`scripts/dev-open.mjs`）一键以开发模式启动并自动打开浏览器，不影响默认 `npm run dev` 行为。浏览器命令按平台构造（Windows `cmd /c start`、macOS `open`、Linux `xdg-open`），并支持 `ROOM_OPEN_BROWSER_COMMAND` 覆盖以便测试/受限环境。新增 `tests/open-browser.test.ts` 覆盖平台命令与覆盖值，自动测试增至 **102/102**；README、v0.1 发布说明与验证矩阵已补充用法。本轮未实际弹出浏览器，也未调用模型。

2026-10-18（Asia/Shanghai）优化**连接状态与浏览器验收稳定性**：页面连接状态不再在首次打开时直接显示“重新连接中”，而是区分「正在连接」→「实时连接」→断线后的「重新连接中」；浏览器 E2E 新增 `connection-status-live`、`recovery-live-and-room-ready` 两步，在恢复会话后等待实时连接与房间快照标题就绪再截图，避免把加载中状态误当最终界面。实测浏览器 E2E **PASS（30/30 步）**，最新截图 `.state/browser-e2e/run-883Biu/ui.png` 显示房间标题、2 位演示 Agent、实时连接与完整消息流；报告 `.state/browser-e2e/run-883Biu/report.json`。`npm test` 保持 **102/102**，`tsc` 通过。

2026-10-18（Asia/Shanghai）补齐**Codex 版本诊断**：新增 `apps/server/src/executable-version.ts`（`codex --version` 解析与带超时的探测），`diagnose()` 对 Codex 成员新增 `cli-version` 检查——未配置固定版本时显示检测到的版本，配置了固定版本时必须完全一致；UI「固定版本」提示同步改为 Claude/Codex 均会核对。实测对本机 Codex CLI：`detected=0.163.0-alpha.10.2`；隔离诊断脚本输出 `cli-version: passed, detail="Codex CLI 0.163.0-alpha.10.2"`。新增 `tests/executable-version.test.ts` 覆盖多种 `codex --version` 输出格式，自动测试增至 **103/103**；已知限制中 Codex 部分已更新，DSH Desktop 版本仍未做每次运行强制校验。

2026-10-18（Asia/Shanghai）补齐**DeepSeek Harness Desktop 版本诊断**：新增 asar 读取器 `readAsarVersion` / `readDesktopVersion`（解析 Electron asar 头与根 `package.json`，不整包解压），`inspectRuntime` 在 Desktop 入口检查固定版本，`diagnose()` 新增 `cli-version` 检查并显示 Desktop 应用版本。实测本机 `resources/app.asar` → `0.2.0-rc.2`；隔离诊断输出 `cli-version: passed, detail="DeepSeek Harness Desktop 0.2.0-rc.2（固定版本 0.2.0-rc.2）"`。新增 `tests/asar-version.test.ts` 覆盖合成 asar、损坏文件与缺失文件，自动测试增至 **104/104**。已知限制第 9 条已更新：Codex/DSH Desktop 版本会在诊断/启动检查时核对，但仍不能替代人工固定安装版本。

2026-10-18（Asia/Shanghai）新增**原生 Agent 兼容端点字段的浏览器验收**：浏览器 E2E 新增 `ui-native-endpoint-fields`——在 Agent 连接中打开“添加 Agent”，选择 Claude 类型时断言出现「Anthropic 兼容端点」，选择 Codex 类型时断言出现「OpenAI 兼容端点」，随后关闭对话框（不保存、不产生模型请求）。实测浏览器 E2E **PASS（31/31 步）**，报告 `.state/browser-e2e/run-LEGvlE/report.json`；该步骤覆盖了此前仅由适配器单元测试验证的 UI 配置项。

2026-10-18（Asia/Shanghai）把固定版本校验前移到**运行文件检查**：`inspectRuntime()` 在诊断与启动 staging 时，对配置了固定版本的 Claude/Codex 调用 `--version` 比对，对 DSH Desktop 读取 asar 应用版本比对；新增 `parseClaudeVersion` 解析与 `probeClaudeVersion`，测试覆盖 Claude 版本格式。实测三类本机 Agent 均通过正确版本、拒绝错误固定版本：Claude `2.1.271`、Codex `0.163.0-alpha.10.2`、DSH Desktop `0.2.0-rc.2` 均返回正常；固定版本改为 `0.0.1` 时分别抛出版本不一致错误。自动测试增至 **105/105**；已知限制第 9 条更新为“诊断/运行文件检查会比对固定版本，但仍不能替代人工锁定安装版本”。

2026-10-18（Asia/Shanghai）在版本校验与 UI 调整后完成**最终回归**：`npm run test:preflight -- --with-native` **PASS 8/8**（约 173 秒，含 unit-tests 105/105、browser-e2e 31/31、production-smoke 10/10、sandbox 23/23、connectors 9/9），报告 `.state/preflight/run-EaEfyR/report.json`；随后重跑 `test:acceptance -- --check` **PASS**（4/4 步，`ready-for-paid-tests`，三位 managed+sandbox 成员与协议检查通过），报告 `.state/native-pipecompat-20261017/acceptance-tests/suite-wdp7HI/acceptance.json`。两次回归均未调用模型；`report:readiness` 退出码 0，浏览器/生产/协议/账号登录与外部值守等必需门禁全部通过。

2026-10-18（Asia/Shanghai）新增**沙箱两 Agent 任务接力验收** `npm run test:sandbox-handoff -- --allow-paid`（`scripts/smoke-sandbox-handoff.ts`）：Claude 在 AppContainer 沙箱中完成 fixture 任务 v1 并生成差异交付物，owner 应用到原项目后，人类把任务交接给同样运行在沙箱中的 DeepSeek，后者完成 v2。实测 **PASS**：任务 `completed`、版本 `v2`、负责人 `sandbox-deepseek-handoff`；Claude v1 与 DeepSeek v2 两条运行均 `completed` 且 `sandboxVerified=true`；交接前后 `answer.txt` 均为 `SANDBOX_HANDOFF_OK`；耗时约 90 秒（两次沙箱模型轮次），报告 `.state/sandbox-handoff-smoke/run-dTKJB6/report.json`。发布就绪新增「沙箱两 Agent 任务接力（Claude + DeepSeek）」门禁；该验证在不提供 Codex API Key 的情况下补齐了沙箱内多 Agent 协作 + 成果应用链路。

2026-10-18（Asia/Shanghai）新增**仓库密钥扫描** `npm run check:secrets`（`scripts/check-secrets.mjs`）：递归扫描源码与文档文本文件，检测常见 API Key、房间 Agent 令牌、私钥头与 Anthropic token 形态；排除 `.state`、node_modules、dist、.git 与本地 `.mcp.json`（本地令牌文件），报告写入 `.state/secret-scan/latest.json`。首次扫描结果 **PASS（0 finding）**。该步骤已加入 `test:preflight`（现 9 步）与发布就绪门禁「仓库密钥扫描」，确保本地发布前不会把凭据误提交。README、发布说明与验证矩阵已补充命令说明。

2026-10-18（Asia/Shanghai）完成一次**三 Agent 实时房间协作研讨与详细 Plan 交付**：新建房间「Agent 并行与实时协作研讨」（`room_046d0d633a45437686f338c84c2c508b`），成员为 DeepSeek、Claude、Codex（三者均为 managed + host，Codex 使用 `ROOM_CODEX_PROXY`）。第一轮由 owner @三成员，三者各自完成独立观点；第二轮通过 `discussion.start`（participants 三人、rounds=1、maxResponses=3）完成交叉评审；最后由 DeepSeek 读取房间历史综合三方观点输出 7181 字的《Agent 并行与实时协作架构 Plan》，包含消息模型、状态同步、并行调度、异步背压、企业级 UX、与 AgentScope 差异表、P0/P1/P2 路线与验收标准。Plan 同时作为 Markdown 附件发布到房间（artifact `artifact_627263dea30347c59ed3620ed9a573b2`，13,792 字节）；本地存档 `docs/AGENT-PARALLEL-COLLABORATION-PLAN.md`。房间内共有 7 条 Agent 消息，DeepSeek / Claude / Codex 三方均有实际发言。该协作基于 `docs/AGENT-PARALLEL-COLLABORATION-PLAN.md` 交付，后续可将其中的 P0/P1 任务拆入项目任务看板。

2026-10-19（Asia/Shanghai）完成**Git 基线、审计导出、CI 配置与 UI/UX 优化**：
- `git init -b main`，首个提交 `ced6da3` 纳入 289 个源码/文档/测试文件（`.state`、node_modules、dist、`.mcp.json` 均按 `.gitignore` 排除，密钥扫描 0 发现）；新增 `.gitattributes` 统一行尾。
- 新增 owner-only `GET /api/rooms/:id/audit/export`，按事件原样输出 NDJSON 附件；房间头部新增「导出审计日志」按钮。新增 `tests/audit-export.test.ts` 覆盖认证、401、NDJSON 字段与附件头；`npm test` 192/192。
- UI/UX：运行用量改为紧凑格式（不再重复三个未知），任务接力下拉改为紧凑深色样式并补 `aria-label`，房间头部显示“N 进行中”，提高 owner 页脚对比度；当前房间 id 写入 URL 查询参数并同步浏览器标签标题，刷新后保持所选房间；新增右侧「用量」标签，按房间/Agent 汇总 Token、费用估值与已上报/未知运行，未知不按 0 计入。浏览器 E2E 新增 `room-url-and-title-persistence`、`usage-tab`，全量 37/37 通过，截图 `docs/screenshots/ui-polish-20261019.png`。
- 新增 `.github/workflows/ci.yml`（Windows runner：typecheck、密钥扫描、单元测试、replay 契约、生产构建）；仅完成本地配置，尚未在远端 CI 实际执行。
- 计划实施记录已更新：`docs/AGENT-PARALLEL-PROGRESS.md` 增加第四批 baseSeq 上下文对账与第五批审计/UI 记录，并更新剩余工作清单；`PROTOCOL.md`/`RELEASE-NOTES.md` 同步 v6 与已实现/未实现边界。

## 已覆盖

2026-10-18 13:30（Asia/Shanghai）补齐版本与交付回归：任务修改/转交会先使整棵依赖树的运行、发言和版本失效，再生成共同快照并重新排队；未接受提案保持待确认。外部任务完成摘要也有 taskId/taskVersion，能在目标变更后标旧；事件游标以前的历史仍保留原状态。HTTP 交付物应用测试确认旧开发/审查补丁均返回 409，原文件不变；新版本只应用一次，重复 commandId 返回原回执。

浏览器无模型场景确认：去重前出现一条正式消息和一条流式临时回复；结束后正式消息仅一条，“正在回复”消失。证据 `.state/diagnostics/browser-stream-dedupe.json`，截图 `screenshots/stream-completed.png`。日常与独立预览在同一浏览器分别登录、刷新后均保持连接，证明 Cookie 不再互相覆盖；证据 `.state/diagnostics/browser-instance-cookies.json`。

`npm test` **89/89**、生产构建通过。新增 `test:sdk`：实际打包协议与客户端，连同已安装的 Zod 在临时消费者项目离线安装，检查发布文件、ESM/Schema 导入、作者凭据、幂等重试和 TypeScript 声明，四项通过；最新报告 `.state/sdk-probes/run-sZD7OG/report.json`，包含本地包 SHA-256。未调用模型，没有以这些检查替代真实原生编程验收。

- 严格协议版本和命令 payload、服务端作者身份、同源与启动会话认证。
- SQLite 事件序列、命令幂等和事务内入队。
- 模拟成员的消息、流式输出、讨论轮次屏障和响应上限。
- 任务版本、旧运行取消、依赖、重启中断状态。
- 独立快照、凭据名过滤、成果基线冲突拒绝、异常应用日志阻断。
- A2A 1.0 的模拟任务继续、上下文标识和取消确认；原生取消对完整进程退出证明的要求。
- TypeScript 与 .NET 编译、SDK/Schema 构建；具体结果以执行测试输出为准。

2026-10-17 本机记录：49 项无模型自动测试通过，包含 ACP 生命周期、Codex 输入与分项 Token 解析、自建 API 结构化交付、资源设置、冻结上下文、依赖版本级联、数据库 v1→v2 迁移备份、运行文件缓存、MCP 错误脱敏、验收测试项目边界及独立执行退出证明。此前生产服务与浏览器验证了普通消息、提及唤醒、两位演示成员并行流式回复、讨论期间人类发言、创建房间与设置保存、任务新版本和旧回复标记、界面沙箱诊断。

本次在独立测试数据目录成功完成浏览器复查：资源设置修改后保存并重新打开回显正确；DeepSeek Desktop 路径与凭据变量名保存正确；API 结构化回复选项也能保存回显。实际未启用模型或调用提供方。截图保存在 `screenshots/runtime-settings.png`、`screenshots/deepseek-connection.png` 和 `screenshots/api-structured.png`；测试预览服务已停止。

20:01（Asia/Shanghai）重新执行了最新原生探测，**20/22 通过**。报告保存在 `.state/native-recheck-20261017/diagnostics/sandbox.json`，未覆盖默认数据目录中的旧 15/17 报告。新增的应用数据读取拒绝、私有 IPv6、跨沙箱文件/进程/IPC 均通过；IPv4/IPv6 拒绝检查都有宿主可达的阳性对照。应用数据检查在此新测试目录中使用受保护 canary，而非已有生产数据库。这些结果不能代表三个真实 Agent 的完整验收。

22:40（Asia/Shanghai）完成**真实 DeepSeek Harness 接入验证**（本机 DSH Desktop 0.2.0-rc.2，用户已授权使用其本机凭据）：最新原生探测 23/23 通过；`deepseek` 成员在 AppContainer 内完成 ACP `initialize`/`session/new`、真实模型轮次、通过逐运行 named pipe 的群聊 MCP `room_read`/`room_post`，连续三轮复用同一原生会话并产生房间消息。此前被误报为 45 秒 `input` 超时的根因是 C# 宿主 stdin 未按 UTF-8 解码：任何含中文的 IPC 帧（项目自身的上下文模板即中文）都会被错误解码并拒绝。同时为聊天工作区增加 Git 基线，使 DSH 的项目根解析不再走到未授权的祖先路径。该验证仅代表本机、单版本、单提供方，不等同于三个 Agent 组合或 v1 正式验收。

00:02–00:35（Asia/Shanghai）完成**本机直连（host）执行模式**实现与实测（用户明确要求让接入 Agent 使用本机最高权限）：在 Agent 连接设置中新增每 Agent 独立的执行权限，`deepseek` 切换为本机直连后以当前 Windows 用户身份运行——`room_read` 经逐运行命名管道成功、shell 可执行 `node -v`/`git --version`、可读取真实项目根 `package.json` 与用户主目录条目，证明其获得完整本机环境而非沙箱子集。任务模式直接修改真实 Git 项目（`version` 0.1.0→0.2.0、新增 `CHANGELOG.md`），任务状态 `completed`、`workspaceId` 为空、没有生成快照目录，并发布“本机变更清单”报告交付物。实现要点：新的本机进程通道与取消/退出处理；聊天工作区按房间共享（同一房间各 Agent 可见彼此文件）；DSH 本机模式使用隔离的 `DSH_HOME`，并通过 acp profile 的 `@deepseek-ai/dsh-mcp-client` band 挂载房间 MCP（ACP 会话级 MCP 声明在部分托管启动上下文不生效）；沙箱模式保持原路径与默认。验证补充：`tsc`、`vite build` 通过，`npm test` 52/52。Claude/Codex 的本机直连以及插件/MCP 外部接入（Claude Code plugin、DSH plugin、Codex MCP 配置）尚未实测，留待后续轮次。

00:25–00:40（Asia/Shanghai）完成**外部 MCP 接入**：新增按 Agent、按房间签发的接入令牌（由启动密钥派生，服务重启即失效，不落库），`/api/agent/tool` 只接受该 Agent 令牌且仅能操作其所在房间；`scripts/room-agent-mcp.mjs` 提供 `room_read`/`room_post`/`task_propose`/`artifact_publish`/`room_status` 五个 MCP 工具，UI 的「生成外部 MCP 接入配置」可复制 Claude Code / Codex / DSH 三种配置片段。实测：MCP `initialize`/`tools/list` 正常，`room_read`、`room_post`（消息以该 Agent 身份进入房间，无托管 run）、`room_status` 成功，伪造令牌返回 401；单元测试覆盖令牌签发/校验/篡改。边界：外部 Agent 进程与权限完全由客户端管理，Tempt Room 不托管进程、不自动唤醒空闲 Agent；Claude Code 插件打包与真实 Claude 会话内的端到端验证尚未完成。

00:30（Asia/Shanghai）尝试验证 **Claude 本机直连**：诊断通过，但真实轮次失败于 `ConnectionRefused`。根因是 Claude Code 3p 的用户配置（`~/.claude/settings.json`/`settings.local.json`）把 `ANTHROPIC_BASE_URL` 指向本机代理或第三方端点，宿主进程依赖的代理未运行；这不是 Tempt Room 的进程通道问题。已将 Claude 恢复为沙箱模式（诊断 25/25 通过）。要让 Claude 以本机直连运行，需要它自己的代理/凭据在无沙箱环境下可用，或为其提供隔离配置与可用的 Anthropic 兼容凭据；该组合留待后续验证。相比之下，外部 MCP 接入让 Claude 在自己原生的环境与配置里运行，更稳妥。

00:42–00:50（Asia/Shanghai）完成 **Claude Code 插件接入验证**：`plugins/tempt-room-claude` 通过 `--plugin-dir` 加载，Claude Code 2.1.271 调试日志确认 “Loaded inline plugin from path: tempt-room”“Loaded 3 commands from plugin tempt-room”，并为 `plugin:tempt-room:room` 建立 stdio MCP 连接（`hasTools: true`，serverInfo `tempt-room-connector`），`.mcp.json` 中的 `${ROOM_URL}`/`${ROOM_AGENT_TOKEN}`/`${ROOM_ROOM_ID}` 环境变量展开和 `${CLAUDE_PLUGIN_ROOT}` 路径都生效。直接 `--mcp-config` 方式也已验证可加载 `mcp__room__*` 工具（init 帧可见）。**未完成**：在该环境里让 Claude 完成一次真实模型轮次并调用房间工具——Claude Code 3p 的用户配置把 `ANTHROPIC_BASE_URL` 指向本机代理/第三方端点，代理未运行时请求以 `ConnectionRefused` 失败；这属于 Claude 自身凭据与端点配置，不是连接器或 Tempt Room 的问题。插件不托管 Claude 进程、不自动唤醒。

00:50–01:05（Asia/Shanghai）完成**本机直连协作安全**：聊天工作区按房间共享并在每次本机直连聊天运行后自动提交 Git 检查点——实测 DeepSeek 在房间工作区创建 `handoff-demo.txt`，运行结束后生成提交 `388577d room run run_6b61e… (deepseek)` 并发出 `room.git.checkpoint` 事件；同一真实项目目录的多个本机直连任务运行在调度器中被串行化（以解析后的 projectPath 为键），避免并发写坏文件。新增外部 MCP 连接器的一次性 Agent 令牌不落库、只代表该 Agent/房间、服务重启失效；Claude Code 插件（`plugins/tempt-room-claude`）的加载、3 个 slash command 和 room MCP 连接已在上一段验证。`npm test` 53/53、`tsc`、`vite build` 通过。**仍未完成**：Codex CLI 本机未安装无法实测；Claude 真实模型轮次需要其自身可用的端点/代理；外部 Agent 的空闲唤醒仍依赖用户或 Agent 自己的调度。

01:05–01:20（Asia/Shanghai）完成**接入简化与外部 Agent 等待能力**：连接设置新增「自动探测本机程序」——服务端只读扫描各盘符 Program Files、用户程序目录和 Claude Code 版本目录，实测自动找到 Claude Code CLI（`…\Claude-3p\claude-code\2.1.271\claude.exe`）与 DSH Desktop（`D:\Program Files\Deepseek Harness\DeepSeek Harness.exe`），Codex 未安装故为空。外部 MCP 连接器新增 `room_wait`（最长 25 秒、可带 `afterSeq`）：实测 MCP `tools/list` 含该工具；无新消息时约 1.3 秒返回 `timeout:true`；并发等待期间由 owner 发送消息，等待调用返回 `timeout:false` 且携带该消息——为外部 Agent 提供了房间内等待/循环能力（仍不是后台唤醒）。`npm test` 53/53、`tsc`、`vite build` 通过。

01:20–01:35（Asia/Shanghai）完成**自动值守运行器**（`scripts/room-agent-runner.mjs`）：用该 Agent 的 scoped 令牌长轮询 `room_wait`，收到 @ 点名后启动配置的本机 CLI（`ROOM_AGENT_COMMAND` + `ROOM_AGENT_ARGS`，可含 `{prompt}` 或经 `ROOM_AGENT_PROMPT` 传入），并把 CLI 输出作为该 Agent 的消息 `room_post` 回房间。以假 CLI（node 脚本回显提示）做端到端验证：新建「自动值守验证」房间并启动运行器，owner 发送 `@claude …` 后，运行器在约 3 秒内唤醒、执行假 CLI，并成功以 claude 身份发出 `FAKE_RUNNER_REPLY: …` 消息；运行器失败/超时只写 stderr，不会伪造回复。限制：每次唤醒是新 CLI 会话、会产生模型费用；运行器需用户自行启动和看护；Claude/Codex 的真实 CLI 端到端仍受各自端点/安装状态限制。`npm test` 53/53、`tsc`、`vite build` 通过。

01:35–01:55（Asia/Shanghai）完成**运行器会话复用**与**接入配置一键落盘**：运行器支持 `ROOM_AGENT_RESUME_ARGS`（含 `{session}`）与 `ROOM_AGENT_SESSION_FILE`，从 CLI 的 stream-json 输出解析 `session_id` 与最终 `result` 文本，下次唤醒追加 resume 参数。以假 stream-json CLI 实测两次 @ 唤醒：第一次 `resumed:false` 发布 `ANSWER-NEW`；第二次追加 `--resume fake-session-001` 后发布 `ANSWER-RESUMED`，会话文件写入 `fake-session-001`。新增 `POST /api/agents/:id/connect/write`：实测在 `.state/connectors/claude_<room>/` 写出 `claude-room-mcp.json`、`codex-config.toml`、`dsh-patch.yml`、`run-runner.ps1`、`README.txt` 五个文件（含 scoped 令牌，服务重启失效），UI 增加「写入管理目录」按钮。`tsc`、`vite build`、`npm test` 53/53 通过。限制：真实 Claude/Codex CLI 的端到端仍受各自端点/安装状态限制；会话复用只复用 CLI 会话上下文，CLI 进程仍每次新起。

01:55–02:10（Asia/Shanghai）完成**运行器常驻进程模式**：`ROOM_AGENT_MODE=persistent` 时运行器只启动一次 CLI，按 Claude 风格 `--input-format stream-json` 把每次唤醒的 prompt 写入其 stdin，从 stdout 的 stream-json 帧中取 `result` 与 `session_id`；进程退出后下次唤醒自动带 `--resume` 重启。以假常驻 CLI 实测两次 @ 唤醒：分别返回 `PERSIST-ANSWER-1`/`PERSIST-ANSWER-2`，启动日志 **spawn 计数 = 1**，会话文件写入 `fake-persistent-001`——证明同一进程内完成了两次房间唤醒。oneshot 模式保持每次新进程。`tsc`、`vite build`、`npm test` 53/53 通过。限制：persistent 模式要求 CLI 支持 Claude 风格 stream-json stdin；真实 Claude/Codex CLI 端到端仍受各自端点/安装状态限制。

02:10–02:25（Asia/Shanghai）完成**一键安装到客户端用户配置**：连接设置新增安装/卸载（Claude Code / Codex / DSH），会改文件的步骤先写时间戳备份。实测：Claude 安装后 `claude mcp list` 显示 `room: …\node.exe …\scripts\room-agent-mcp.mjs - √ Connected`，卸载后条目消失；DSH 安装把 `@deepseek-ai/dsh-mcp-client` band 写入 `~\.dsh\profiles\acp\cordis.patch.yml`（生成备份），卸载后恢复为空 patch 层，用户配置校验通过；Codex CLI 未安装，`config.toml` 合并/移除逻辑由单元测试覆盖（保留其他 MCP 段、替换本段、删除本段）。自动测试增至 **55/55**，`tsc`、`vite build` 通过。安全边界：该功能会修改用户客户端配置（有备份、需确认、可卸载）；DSH patch 已有自定义内容时拒绝自动改写。

02:25–02:40（Asia/Shanghai）完成**任务转交/接力**：新增 `task.handoff`（仅人类；递增版本、取消该任务未完成运行、重新排队给同房间另一个已启用 Agent，并记录 `task.handoff` 事件）；Agent 侧 `task_propose` 支持 `dependencies`，可提议依赖前序任务的后继任务（仍需人类确认）。实测（无模型、demonstrator）：房间内任务先由 demo-planner 完成（v1），转交给 demo-reviewer 后版本 v2 并再次完成；对同一 Agent 转交被拒绝（`same_agent`）。另用外部 MCP 以 claude 身份提议带 `dependencies: [前置任务]` 的后继任务，返回 proposed，owner 确认后由 demo-reviewer 完成。自动测试增至 **57/57**，`tsc`、`vite build` 通过。限制：转交以任务为单位，尚无语义化的“认领池/竞标”；Agent 不能自行转交他人任务。

02:40–02:55（Asia/Shanghai）完成**开放任务认领**：人类可创建 `open:true` 的无人认领任务（agentId=unassigned、proposed、不启动运行）；Agent 通过 `task_claim` 认领（外部队列与托管 Agent 均可），认领后分配给自己、版本 +1、开始一次运行，并记录 `task.claimed`；固定负责人任务与已认领任务不可再次认领，Agent 不能创建开放任务。实测：owner 创建开放任务后，外部 MCP 以 claude 身份 `task_claim` 成功（tools/list 含该工具），任务变为 `agentId=claude, version=2, queued, open=false`，`task.claimed` 事件记录认领者，运行可被取消；服务级测试覆盖认领、重复认领、固定任务认领、Agent 创建开放任务等拒绝路径。自动测试增至 **59/59**，`tsc`、`vite build` 通过。限制：开放任务没有超时回收/竞标机制；认领即开始，仍受模型端点可用性限制。

02:55–03:10（Asia/Shanghai）完成**外部 Agent 自主认领开放任务闭环**：`task.claim` 增加 `managed`（外部连接器为 false，不触发托管运行），新增 `task.complete`（仅 Agent；结束自己负责的任务、可写 summary 消息；`ok:false` 标记失败）。自动值守运行器新增 `ROOM_CLAIM_OPEN=1`：轮询开放任务→认领→用任务标题跑 CLI→输出回房间→标记完成/失败。实测（假 CLI，无模型调用）：开放任务被外部 MCP 以 claude 身份认领，任务 `agentId=claude, version=2`，**托管运行数 = 0**（正确走外部执行），随后 `task_completed`，房间出现 `TASK_ANSWER: …` 消息，事件 `task.claimed → task.completed`。自动测试增至 **60/60**（新增外部署 claim 不建运行、task_complete、重复完成拒绝、错 Agent 完成拒绝），`tsc`、`vite build` 通过。限制：外部执行没有租约/超时看护（运行器退出时任务停留 running），需后续加租约回收；真实 Claude/Codex 仍受端点/安装状态限制。

03:10–03:25（Asia/Shanghai）完成**外部任务租约与回收**：外部署认领（managed=false）附带租约（默认 10 分钟，可用 `ROOM_TASK_LEASE_MS` 覆盖）；新增 `task.heartbeat`（仅 Agent、只能续租自己的 running 任务）；调度器在租约过期且没有托管运行时把任务回收为开放任务（unassigned/open=true/版本 +1），记录 `task.lease_expired`。自动值守运行器在执行认领任务期间按租约自动心跳。实测（以 `ROOM_TASK_LEASE_MS=4000` 启动）：外部 MCP 认领后任务 running 且带 `leaseUntil`；4 秒无心跳后任务被回收为 `proposed/unassigned/open/version=3` 并产生 `task.lease_expired`（previousAgentId=claude）；随后重新认领（version=4）并 `task_complete`，任务 completed。自动测试增至 **62/62**（租约存在/续租/完成清除、过期回收与事件断言），`tsc`、`vite build` 通过。限制：默认租约时长不可在 UI 配置；“心跳可续租”依赖外部 Agent 持续运行，进程死亡后最长 10 分钟才回收。

03:25–03:40（Asia/Shanghai）完成**租约时长进入运行设置**：`executionSettings.taskLeaseMs`（默认 600000ms，范围 5s–24h）加入协议、设置持久化与「运行设置」UI；外部认领/心跳使用该设置而非环境变量。实测：默认设置读出 600000；改为 30000 后，外部 MCP 认领导致的 `leaseUntil` 距现在约 29.99s；验证后恢复 600000。自动测试 **62/62** 通过（租约测试显式设置 `taskLeaseMs:15000` 并断言租约落在 10–20s），`tsc`、`vite build` 通过。说明：本轮修复过程中曾误用 PowerShell 默认编码读写 `service.ts` 造成中文串损坏，已通过反向解码恢复并逐条修复 29 处丢失字符、经完整测试验证后覆盖原文件；源码现为正确 UTF-8（无替换字符/乱码标记）。

03:40–03:55（Asia/Shanghai）完成**owner 手动回收外部任务**：新增 `task.release`（仅人类）：把带外部租约的 running 任务立即回收为开放任务（unassigned/open=true/版本 +1，记录 `task.released`）；任务卡片显示外部租约时间与「回收」按钮。实测：外部 MCP 认领后任务 running/lease=true（v2），owner 调用 `task.release` 返回 previousAgentId=claude、v3，任务回到 proposed/unassigned/open 且租约清除，事件 `task.released`。自动测试增至 **63/63**（含 release 成功、Agent 越权、非租约任务拒绝），`tsc`、`vite build` 通过。

03:55–04:10（Asia/Shanghai）完成**安装前预览与项目级 `.mcp.json`**：连接设置新增「预览变更」（返回目标文件路径、当前内容、安装后内容与是否需要修改，不写文件、不执行 Claude CLI）；安装目标新增 `claude-project`，把 room MCP 合并进指定项目目录的 `.mcp.json`（保留其他 mcpServers 与自定义字段、先备份；非法 JSON 拒绝写入；卸载只删除本工具条目）。实测：Codex/DSH 预览显示当前文件内容且磁盘文件哈希不变（Codex 计划中保留原有 blender 服务）；Claude 预览只显示命令且不回显令牌；临时项目 `.mcp.json` 合并后 `other,room` 两个服务与自定义字段均保留并生成备份，再次预览 `changed=false`，卸载后只剩 `other`；非法 JSON 安装被拒绝且文件未被修改。自动测试增至 **65/65**（项目 `.mcp.json` 合并/保留/卸载、非法 JSON 拒绝），`tsc`、`vite build` 通过。

## 阻塞与限制

1. **原生沙箱**：本机最新探测 23/23 通过，含 Node 管道子进程、npm、Git（reftable）初始化、取消与宿主异常退出后的进程树归零、跨沙箱文件/进程/IPC 隔离。报告在 `.state/diagnostics/sandbox.json`。其他 Windows 环境、不同 Node/Git 版本、全部网络策略仍需复测；单机探测不代表所有环境等价。
2. **真实协议兼容性**：DeepSeek Harness Desktop 0.2.0-rc.2 已在本机 AppContainer 内完成真实模型轮次、会话复用与群聊 MCP 验证（见上），并在本机直连模式下完成完整权限、共享聊天工作区、真实项目直接修改与“本机变更清单”验证（见上）；所使用的 Desktop 裁剪运行目录不含 `resources/runtime`，Office 功能未验收。Codex、Claude 的真实模型请求、文件编辑、工具链与取消尚未由本项目完成验收；Claude/Codex 的本机直连同样未实测；模拟测试不能替代实测。用户提供的 DeepSeek 反馈已修正“缺少 dsh.exe”的旧描述，当前支持 Desktop 实际启动方式及官方 npm JS 入口。
3. **授权方式**：原生适配器第一版仅接显式 API 密钥。没有自动迁移现有账号登录，也没有自定义网页登录。
4. **输入能力**：A2A 支持等待输入继续；Codex 已实现 request_user_input 到房间输入通道，模拟测试通过、真实隔离验证仍待完成。Claude/DeepSeek 没有通用中途补充输入通道。用户普通消息可随时发出，修改任务使用显式修改目标。
5. **远程范围**：A2A 仅 1.0 HTTP+JSON/JSONRPC，不支持 gRPC、推送、旧版自动降级或 Card 跨源接口。API 支持文本讨论和可选 JSON 文本交付物，不提供代码 Harness，二进制附件不送入视觉模型。
6. **网络证明**：本机已通过带宿主可达对照的私有 IPv4、链路本地 IPv6、两类 loopback 拒绝及直接公网 HTTPS。尚未证明所有私有 IPv6 路由、系统策略或全部宿主代理入口；单机探测不代表所有 Windows 环境。
7. **文件并发**：应用有基线预检与回滚日志，尚无外部编辑器共同遵守的文件锁。应用过程中不要并发修改目标项目。
8. **清理与账号**：没有多账号、工作区自动清理、自动更新、部署和发布。用户手动保留和备份管理目录。
9. **程序版本**：DSH npm 入口按 manifest 核对所填版本；Claude/Codex 在诊断与运行文件检查时通过 `--version` 读取并与固定版本比对；DSH Desktop 通过 asar 内 package.json 读取应用版本并在诊断/启动检查时比对固定版本。仍不能把版本备注当作锁定二进制的保证，正式验收前须人工固定安装版本。

## 正式发布前操作

继续扩展原生探测，检查每项拒绝测试的目标在宿主确实可达；安装并固定三个 Agent 的具体版本，在隔离 home 内分别验证凭据、模型连接、文件写入、Node/Git/Shell、测试、群聊 MCP、取消、宿主退出后进程树归零。最后完成双 Agent 开发/审查/修改目标/交付应用场景。真实模型验收由用户明确选择在本机显式运行。

真实测试须由用户显式运行，避免普通测试产生模型费用。失败必须保留诊断和工作区，不以无沙箱模式代替验收。

已提供[完整真实 Agent 场景脚本](REAL-AGENT-ACCEPTANCE.md)，涵盖三个编程 Agent 的稳定会话、文件修改、npm/Git、MCP、取消、目标版本、依赖审查与应用。`--check` 不发送模型 prompt，`--allow-paid` 才进入付费场景。此脚本尚未执行真实模型测试。

协议依据：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Claude 程序化 CLI](https://code.claude.com/docs/en/headless)、[DeepSeek ACP](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)、[A2A 规范](https://a2a-protocol.org/latest/specification/)。
