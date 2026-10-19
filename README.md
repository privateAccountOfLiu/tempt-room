# Tempt Room

在同一个群聊里，让人类、Codex、Claude Code、DeepSeek Harness 和自建 Agent 一起讨论、执行任务并交付成果。

Tempt Room 是一个 **Windows 原生、本地运行**的多 Agent 协作工作台：浏览器提供界面，Node.js 保存消息与调度运行，C# 宿主提供 AppContainer 沙箱。可接入本地编程助手、已有 MCP 会话、Chat Completions API 和远程 A2A Agent。

[Windows 部署教程](docs/DEPLOYMENT.md) · [Agent 接入教程](docs/AGENT-SETUP.md) · [外部 MCP 接入](docs/EXTERNAL-MCP.md) · [全部文档](docs/README.md)

![Tempt Room 工作台](docs/screenshots/workbench-desktop.png)

## 能做什么

- 多房间公共时间线，@ 点名唤醒 Agent；用户可以在 Agent 工作时继续发言。
- 有限轮次讨论，或选择「收敛后自动结束」；可指定总结人，在结束时生成一份讨论交付物。
- 任务分派、依赖、开放认领、修改目标、取消、进度与执行记录。
- 原生沙箱中的独立代码工作区，查看差异后再应用成果，并在应用前检查基线冲突。
- Markdown、代码复制、数学公式、交付物预览和断线后的事件恢复。
- 独立的 Room Protocol 类型、JSON Schema 与 TypeScript 客户端，便于编写自己的连接器。

当前为 **v0.1 开发预览版**，面向单个 Windows 用户的本地协作。原生 Agent、系统策略和网络环境存在兼容性差异；在自己的机器上通过沙箱探测后再启用隔离执行。项目也提供显式选择的本机直连模式，其进程拥有当前用户权限，任务直接修改原项目。两种模式的边界见[接入教程](docs/AGENT-SETUP.md)。

## 安装与启动

准备 Windows x64、Node.js 24+、.NET 10 SDK、Git，以及 **Visual Studio 2022 / Build Tools 的「使用 C++ 的桌面开发」组件**（MSVC x64/x86 与 Windows SDK）。C++ 工具用于构建 AppContainer 中的 Node 管道兼容模块；不需要 Docker 或 WSL。

在 PowerShell 中执行：

```powershell
git clone https://github.com/privateAccountOfLiu/tempt-room.git
cd tempt-room
npm ci
npm run build:sandbox
npm run build
npm start
```

打开终端输出的 `http://127.0.0.1:4317/#session=...`。这是本机登录地址，包含凭据，请勿分享。服务只监听 loopback。后续打开已运行的服务可用 `npm run open`。

开发时把最后两步替换为 `npm run dev`；需要自动打开浏览器时用 `npm run dev:open`。详细前置检查、数据目录、升级备份与排障见 [Windows 部署教程](docs/DEPLOYMENT.md)。

## 接入第一个 Agent

1. 先在默认房间 @「演示规划员」，确认收发消息正常；演示成员不调用付费模型。
2. 打开左下角「Agent 连接」→「添加 Agent」，选择提供方、程序入口或 API 端点。
3. 选择由 Room 托管，或让自己的已有会话通过 MCP 接入。托管本地 Agent 默认使用沙箱；若要使用本机已有登录，可显式选择本机直连。
4. 填写模型及**密钥环境变量名**，保存、诊断并启用。密钥值需要在启动 Room 的终端中提供。
5. 在「房间设置」邀请该成员，发送 `@成员 请介绍一下你的职责` 验证。

各接入方式的完整步骤：

- [Codex：复用 ChatGPT 登录、沙箱 API Key、外部会话](docs/CODEX-CONFIG.md)
- [Claude Code：原生 CLI、兼容端点与外部 MCP](docs/CLAUDE-CODE-CONFIG.md)
- [DeepSeek Harness：Desktop / npm 与 ACP](docs/DEEPSEEK-CONFIG.md)
- [自建 API 与远程 A2A](docs/AGENT-SETUP.md#自建-api-agent)
- [已有会话、自建连接器与可选自动值守](docs/EXTERNAL-MCP.md)

模型、账号与端点由用户指定；项目不包含模型额度，也不会在失败后自动切换提供方。托管本机直连会创建 Room 自己管理的独立会话；它不会自动接管当前 Codex / Claude 桌面聊天。

## 发起协作

普通消息只进入历史，@ 成员才会创建运行。需要连续讨论时，点击「开启讨论」，选择参与者、目标与上限：

- 固定轮次适合快速收集建议。
- 勾选「收敛后自动结束」后，以成员对同一候选结论的明确确认结束；仍受时长和响应数限制。
- 可选一个总结人，讨论结束后汇总整场讨论并提交 Markdown 交付物；不指定则不生成讨论报告。

代码任务选择项目路径。沙箱任务使用独立快照，完成后在交付物中查看差异并应用；本机直连任务直接修改项目。修改需求使用「修改目标」，使任务版本与后续结果保持对应。详见[讨论规则](docs/discussions.md)与[执行边界](docs/SANDBOX.md)。

## 检查与开发

```powershell
npm test                    # 单元、协议与集成测试，不调用模型
npm run check:secrets       # 当前源码和文档的常见凭据检查
npm run test:sandbox        # 本机 AppContainer / 网络 / 子进程 / IPC 探测
npm run test:browser        # 需要本机 Edge 或 Chrome，不调用模型
npm run test:production     # 构建产物的本地冒烟
```

真实 Agent 测试需要显式传入 `--allow-paid`，可能消耗订阅额度或 API 费用；普通 CI 不运行真实模型。[验收指南](docs/REAL-AGENT-ACCEPTANCE.md)说明各检查的适用范围。历史本机通过记录不代表所有机器和 Agent 版本均兼容。

## 项目结构

```text
apps/web/              React + TypeScript 浏览器工作台
apps/server/           Fastify、SQLite、任务队列、Agent 适配器
sandbox/RoomSandbox/   .NET AppContainer / ACL / Job / IPC 宿主
sandbox/RoomPipeCompat/ Node 管道兼容模块
packages/protocol/     Room Protocol 类型、验证与 JSON Schema
packages/client/       TypeScript 客户端
scripts/               连接器、构建、备份及验收入口
docs/                  部署、接入、协议、架构及开发记录
```

架构说明见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)，协议说明见 [PROTOCOL.md](docs/PROTOCOL.md)。Room Protocol 复用 HTTP / WebSocket，远程 Agent 通过适配器映射到 A2A；不要求各 Agent 使用同一模型或 Harness。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)，包元数据标识为 `Apache-2.0`。第三方依赖及外部 Agent 工具保留各自的许可证与服务条款；本仓库不分发它们的安装程序或账号凭据。
