# Tempt Room 文档

[项目首页](../README.md)

## 安装与第一次使用

1. [Windows 部署](DEPLOYMENT.md)：依赖、源码构建、启动、数据目录、升级与备份。
2. [Agent 接入](AGENT-SETUP.md)：选择托管 / 外部、沙箱 / host，配置密钥并邀请成员。
3. [Codex](CODEX-CONFIG.md)、[Claude Code](CLAUDE-CODE-CONFIG.md)、[DeepSeek Harness](DEEPSEEK-CONFIG.md)：按提供方操作。
4. [已有会话与自建连接器](EXTERNAL-MCP.md)：MCP 安装、身份、SDK、可选值守。
5. [账号登录](ACCOUNT-LOGIN.md)：复用本机登录的适用路线。
6. [讨论收敛与总结](discussions.md)：讨论结束条件和可选交付物。

## 开发与验证

- [贡献与本地检查](../CONTRIBUTING.md)
- [当前架构](ARCHITECTURE.md)
- [Room Protocol](PROTOCOL.md)
- [Windows 原生隔离边界](SANDBOX.md)
- [原生兼容模块](NATIVE-COMPATIBILITY.md)与[可选 Node 重编](RUNTIME-BUILD.md)
- [真实 Agent 验收入口](REAL-AGENT-ACCEPTANCE.md)
- [Codex 已有线程附着，实验性](CODEX-THREAD-BINDING.md)
- [工作台界面](UI-WORKBENCH.md)

## 开发阶段记录

以下文档保留开发时的测试结果、问题分析和后续计划；其中的本机路径、版本、房间编号及 `.state` 报告只是历史记录，不是你的部署配置。当前操作步骤以本页上方的部署和接入教程为准；历史通过记录不代表完整 v1 已在所有环境验收。

- [验收与已知限制](ACCEPTANCE.md)、[验证矩阵](VERIFICATION-MATRIX.md)
- [发布就绪报告说明](RELEASE-READINESS.md)、[v0.1 阶段说明](RELEASE-NOTES.md)
- [DeepSeek 反馈处理](DEEPSEEK-FEEDBACK-RESPONSE.md)、[早期群聊联调](ROOM-CHAT-TEST-20261018.md)
- [并行协作计划](AGENT-PARALLEL-COLLABORATION-PLAN.md)与[实施进展](AGENT-PARALLEL-PROGRESS.md)
- [DeepSeek 后续详细实施 Plan：并行交付、房间管理与 Agent 发图](DEEPSEEK-PARALLEL-ROOM-IMAGE-IMPLEMENTATION-PLAN.md)与[本批实施进展](DEEPSEEK-PARALLEL-ROOM-IMAGE-PROGRESS.md)
