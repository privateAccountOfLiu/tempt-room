# DeepSeek Harness 接入教程

[接入总览](AGENT-SETUP.md) · [外部 MCP](EXTERNAL-MCP.md)

Room 通过 DeepSeek Harness 的 **ACP profile** 接入会话、输出、权限请求与取消。支持 Desktop 和 npm 两种安装形态，不要求系统中一定存在 `dsh.exe`。

## 路线 A：DeepSeek Harness Desktop

1. 按 [DeepSeek Harness 上游说明](https://github.com/deepseek-ai/deepseek-harness)安装 Desktop。
2. 在 Room 添加 DeepSeek 成员，点「自动探测本机程序」，或手动选择安装目录里的 `DeepSeek Harness.exe`。
3. 选择「由 Tempt Room 启动」，执行权限选沙箱或显式 host。
4. 模型先留空使用 Harness 默认值。填写时必须匹配 ACP 实际公布的模型选项，不要填另一个提供方的模型名。
5. 密钥环境变量名填 `DEEPSEEK_API_KEY`，在启动 Room 的终端中提供值，然后启动服务。
6. 保存并诊断，沙箱模式做无模型隔离启动检查；启用、邀请进房间，再 @ 测试。

Desktop 会自动识别 Electron Node、asar 内 CLI 入口及 ACP，不需要手动拆出 `dsh.exe`。沙箱运行文件复制包含必要顶层文件、`resources/app.asar` 和 `app.asar.unpacked`，不复制用户配置或 `resources/runtime`。此接入面向 ACP 编程协作，Office 功能不在当前验收范围。

开发阶段验证过 Desktop `0.2.0-rc.2` 的隔离内会话、模型回复、连续会话复用和房间 MCP；这是一个已测版本记录，不代表后续上游版本都兼容。升级后重新做本机检查，必要时固定你验证过的版本。

## 路线 B：npm 包

1. 按上游说明安装固定版本的 `@deepseek-ai/dsh` 到一个专用目录，保留其运行依赖。
2. 在该包的 `package.json` 中核对真实 JS CLI 入口，通常为 `lib/bin.js`。
3. 程序入口选择该 JS 文件；完整运行目录选择包含它及所有依赖的专用安装目录。
4. 如填写固定版本，Room 会核对包版本；随后按路线 A 设置模型、密钥、诊断、启用和邀请。

Room 使用受控 Node 运行 JS 入口，不在 AppContainer 里执行 npm 生成的 `.cmd` 包装器。不要选择整个用户目录或包含账号配置的 npm 上层目录来补齐依赖。

## 路线 C：已有 Harness 会话通过 MCP 加入

把一个独立成员设为「外部会话 / MCP」，邀请进房间并生成配置。在连接设置中预览 DSH 的 ACP profile 变更，再安装到 `cordis.patch.yml`。已有自定义 patch 时工具会拒绝自动覆盖，需要你手动合并生成的 `@deepseek-ai/dsh-mcp-client` band。

重新打开 Harness 会话，让它调用 `room_status` 与 `room_post`。此路线使用外部客户端自己的权限，Room 不自动调度它；更多说明见 [外部 MCP](EXTERNAL-MCP.md)。

## 检查与排障

停止使用同一数据目录的服务后：

```powershell
npm run test:deepseek -- --check
# 显式进行一次真实 host 请求：
npm run test:deepseek -- --allow-paid
```

此入口强制用独立 **host** 测试成员，`--check` 只核对程序与密钥引用，不验证 ACP 模型轮次。沙箱检查需用 UI 隔离启动检查或[完整验收入口](REAL-AGENT-ACCEPTANCE.md)。报告保存在 `.state/deepseek-smoke/`。

- 找不到程序：Desktop 可不在 PATH 中，选择真实 exe 即可。
- 缺少模型或模型不匹配：先留空，以 ACP 公布的选项为准。
- Desktop 启动但无 ACP 输出：核对安装版本与运行文件布局，重新诊断；不要指向仅有桌面快捷方式的目录。
- 读取不到密钥：在启动 Room 的终端设置变量并重启，不从其他进程或桌面客户端配置中提取密钥。
- 沙箱复制超限：用专用运行目录；文件数与体积限制不会通过把目录上移而取消。
