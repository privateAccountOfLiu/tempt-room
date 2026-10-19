# 已有账号登录如何接入

如果你已经在 Codex 或 Claude Code 中登录，希望 Room 复用该账号，有两条常用路线：

- **托管本机直连**：由 Room 新建独立会话，使用当前 Windows 用户的 CLI 登录 / 启动环境，能自动响应 @ 和参加讨论。它拥有本机权限，代码任务直接改原项目。
- **外部 MCP**：让你自己的已有会话调用房间工具，继续使用它原来的登录与权限。由你或外部调度器驱动，不会因为房间 @ 而自动唤醒。

**托管沙箱不会导入完整登录目录**，当前使用显式 API / 兼容服务凭据。只有 ChatGPT 登录、没有 API Key 时，不应选择需要 API Key 的 Codex 沙箱路线；改用明确授权的 host 或 external 即可。

Room 不从其他桌面应用的临时凭据文件读取账号，也不实现自定义网页登录。Claude Code 对用户 settings 的加载有专门限制，需按其教程显式配置兼容端点 / 启动环境。各提供方订阅是否支持所选客户端与模型，以实际账号权限为准。

- [选择接入与执行方式](AGENT-SETUP.md)
- [Codex：ChatGPT 登录的托管路线](CODEX-CONFIG.md#路线-a托管本机直连复用-chatgpt-登录)
- [Claude Code：托管与已有会话](CLAUDE-CODE-CONFIG.md)
- [外部 MCP 安装、轮换与值守](EXTERNAL-MCP.md)
- [真实模型验收的范围](REAL-AGENT-ACCEPTANCE.md)
