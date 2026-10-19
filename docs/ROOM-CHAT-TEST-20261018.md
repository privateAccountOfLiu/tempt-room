# 真实房间对话联调（2026-10-18）

用户明确授权在已有房间中与 DeepSeek、Claude Code 对话测试。本轮通过浏览器向「项目工作室」发送 T01/T02 公开消息，没有创建代码任务。运行、消息与工具审计证据保存在 `.state/diagnostics/room-chat-20261018.json`。

## 实际结果

- T01：同时点名两位成员，要求识别编号并记住接力词。两次运行均 completed，各有一条最终回复，成员身份正确。DeepSeek 的 `room_read` 有成功审计；Claude 声称读取但没有调用记录，因此该项不判通过。
- T02：要求实际调用 `room_post` 再单独确认。DeepSeek 发出包含上一轮接力词的消息，有成功工具审计；Claude 明确回复「当前会话未提供 room_post 工具」。两位的原生会话 ID 与 T01 一致。
- DeepSeek 当前使用 **host 本机直连**；Claude 使用 **AppContainer 沙箱**。DeepSeek 本轮证明聊天与工具可用，不证明隔离执行通过。
- 历史 input 超时与进程树退出未知记录仍保留，本轮没有改写它们。

## 修复与验证

Claude 启动配置误把 ACP 的 `env: [{name,value}]` 写入 CLI MCP 配置。已按 [Claude 官方格式](https://code.claude.com/docs/en/agent-sdk/mcp#pass-credentials-via-environment-variables)改成字符串映射，覆盖 sandbox 与 host 两条路径。

模型请求前现在通过 CLI 控制帧 `initialize` / `mcp_status` 确认 room 服务连接；失败即结束运行。`system/init` 再检查实际状态，避免把模型能答话等同于工具接通。控制帧依据[官方 SDK 实现](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py)。

2026-10-18 12:18（Asia/Shanghai），独立 `.state/native-pipecompat-20261017` 目录内真实 **Claude Code 2.1.271** 通过隔离版本查询与 MCP 控制检查。未发送模型 prompt、未复制凭据。报告为该目录 `diagnostics/agent-protocols.json`。这证明修复后 CLI 能挂载工具；真实模型调用仍需服务载入新代码后复测。

另修复：同次运行的最终回复若与之前 room_post 正文完全相同（仅忽略首尾空白），不重复持久化；不同正文、不同运行仍保留。上下文明确本轮用户请求可构成对应范围的授权，避免把「决策 0 条」当作没有任何授权。界面在房间包含 host 成员时明确显示本机直连。

自动测试 **69/69** 通过，包括配置、控制帧、缺失服务拒绝与重复投递回归测试。本轮不替代三类编程 Agent 的编辑、测试、取消和成果应用正式验收。

## T03：重启与当前 Codex 会话接入

用户随后明确要求自行重启并把当前 Codex 接入。2026-10-18 12:49（Asia/Shanghai）完成旧进程 18960 → 新进程 30508 的交接。旧服务在内存中把原环境传给新进程，未把模型密钥读出或写到文件；只临时使用 loopback 调试连接，旧进程退出后 9229 已关闭。服务继续仅监听 127.0.0.1:4317，浏览器会话也已重新认证。

Codex 成员启用 `connectionMode: external`，通过 `RoomAgentClient` 以仅限「项目工作室」的 Agent 令牌读写房间，没有另外启动 Codex 模型实例或修改全局 CLI 配置。接入发言 `msg_9e0c0ea5afe342158cdc197d5cdb1321` 包含标记 `T03-CODEX-731`。当前会话空闲时，房间 @ 不会自动唤醒它。

接着启动一轮、两次响应的明确工具测试，两位托管成员均 completed，原生会话 ID 延续 T01/T02：

- DeepSeek：`run_b556800a5a3f4588a889f2fb882e5241`，`room_read` 与 `room_post` 均有成功审计，公开问候消息为 `msg_9b523d49ac1a41f19518179ddb0dfbc0`。
- Claude：`run_94ecc33baa3d4ab086276c0281cc9307`，`room_read` 与 `room_post` 均有成功审计，公开问候消息为 `msg_96bc3224a47949ad802857d9441c0b3d`。运行记录包含验证成功的 AppContainer 描述。本项覆盖并纠正 T02 中的工具缺失结果。
- Codex 随后实际读取两位回复，并以自身 Agent 身份发布确认 `msg_619b118c00724086939382f956203211`，完成三方读写闭环。

审计证据位于 `.state/diagnostics/T03-result.json`，截图为 `docs/screenshots/room-chat-T03.png`。DeepSeek 的收尾文字误把历史 T02 Claude 结果称为本轮结果；未采用该断言，以上结论依据本轮运行与四次工具审计。

本次代码检查：`npm test` **81/81**；生产构建成功。Windows 无模型连接器进程测试复跑 **9/9**，最新报告 `.state/connector-probes/run-FU678y/report.json`。一次先前复跑因子进程 `fetch failed` 全部失败，报告 `run-oPFroi` 保留；新增连通性预检查后复跑成功，具体瞬时原因未确定。没有将失败记录改写为成功。

Claude 本轮为沙箱执行，DeepSeek 仍保留用户选择的 host 模式；Codex 为当前外部会话。本次证明三方群聊与工具可用，不代替三个编程 Agent 的原生隔离、文件编辑、测试、取消及成果应用正式验收。
