# 真实 Agent 场景验收

此入口为用户显式在本机执行。普通 `npm test` 不会进入付费模型场景；此前已授权的房间联调另见 ROOM-CHAT-TEST-20261018.md。

## 前置条件

1. 完成 TypeScript、生产构建及 C# 宿主构建；先通过 `npm run test:sandbox`。默认兼容模块已在本机通过 Node 管道和 Git 检查；其他机器仍以本机探测为准，不能去掉门禁继续。
2. 在应用中配置并启用 Codex、Claude、DeepSeek 各一位托管沙箱成员，包括真实程序路径、所选模型和密钥变量名。外部会话及本机直连成员会在任何探测或模型调用前被拒绝；可用「添加 Agent」创建同类的独立验收成员，保留原房间成员的接入方式。在运行验收的终端中提供对应环境变量，勿把密钥写入文档或聊天。
3. 正常关闭使用同一 `.state` 的应用。可通过 `ROOM_STATE_DIR` 指定配置来源；存在 `server.lock` 时脚本会拒绝运行。

先运行无模型前置检查：

```powershell
npm run test:acceptance -- --check
```

该模式检查系统沙箱与三个成员的隔离启动。Codex 只初始化 App Server；DeepSeek 做 ACP initialize/session-new/模型选项/close；Claude 查询版本并通过 CLI initialize/mcp_status 检查 room MCP 挂载。不会发送 prompt，也不要求模型密钥；这些协议检查不能证明真实模型轮次、编辑或取消通过。

检查通过后，由用户显式执行：

```powershell
npm run test:acceptance -- --allow-paid
# 存在多个同类成员时可明确选择：
npm run test:acceptance -- --allow-paid --agents=<Codex成员ID>,<Claude成员ID>,<DeepSeek成员ID>
```

完整场景约 15 个 Agent 请求，内部模型轮次和工具调用可能增加费用，不保证固定价格。没有 `--allow-paid` 或 `--check` 时脚本退出，不发送模型请求。出现人工输入请求时停止场景，不代替用户回答。

## 单次原生模型冒烟

`npm run test:agents -- --allow-paid` 同样需要这三位已启用的托管沙箱成员，支持 `--agents=id1,id2,id3`。每位使用独立测试房间，必须确实创建一次 Run、收到已验证的 AppContainer 描述与原生会话标识，并由对应成员在对应房间回复准确的 `OK`。零运行、等待输入、超时、未知执行状态或旧版本/串房间回复均失败。结果保留于 `smoke-tests/run-*/smoke.json`，失败不删除工作区。此冒烟不等于完整验收。

## 场景与成果应用范围

- 每位成员连续两次独立聊天，确认原生会话 ID 稳定以及回复进入对应房间。
- 在脚本新建的 Git 测试项目中实现 `greet.cjs`，保留测试与配置，通过实际群聊 IPC 使用 `room_read` 和 `artifact_publish`。
- 由独立 AppContainer 再执行行为检查、npm test 和 Git 命令；宿主只比较结果，不直接执行 Agent 生成的代码。
- 只允许一份已检查的 `greet.cjs` 文本变更，并应用到脚本自己创建的测试项目。任何测试、配置、额外文件或删除均拒绝。
- 每位成员执行长命令，检查取消确认和工作区保留。
- 开发与审查成员协作：普通用户发言不打断任务；修改目标后旧运行停止、旧 MCP 发言标记过期；开发 v2，审查收到绑定 v2 的依赖交付物，再应用已验证成果。

脚本不会把这些文件应用到原始业务项目；读取原配置时数据库只读，实际场景使用全新数据库。默认创建的演示成员可能存在于测试库中，三个真实成员沿用用户选择的配置。

## 报告与限制

所有测试数据保留在配置来源目录的 `acceptance-tests/suite-*/`。`acceptance.json` 每步更新，另保留每位成员的诊断及协议原始报告，记录成员、配置模型与版本、结果和脱敏错误；工作区、差异、数据库和交付物一并保留。取消或失败不自动删除。分享报告前应自行核对业务内容；脚本不会导出实际密钥值。

`ready-for-paid-tests` 只表示无模型前置检查通过；`passed-real-agent-scenarios` 只表示本脚本场景通过。完整 v1 仍需要真实 Agent 参与时的浏览器端操作验收、全部原生隔离检查、所固定版本的升级兼容性核对。浏览器 UI/WS/持久化链路已有无模型自动化冒烟（`npm run test:browser`，使用确定性演示成员），但它不覆盖真实 Agent 场景，也不能替代本节验收。未通过的场景不能用无沙箱运行替代。
