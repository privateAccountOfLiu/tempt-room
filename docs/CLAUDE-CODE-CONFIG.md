# Claude Code 接入教程

[接入总览](AGENT-SETUP.md) · [外部 MCP](EXTERNAL-MCP.md)

Room 托管 Claude Code 使用原生 CLI 的结构化 stream-json 输入输出，处理增量消息、会话继续与取消。它不解析终端排版，也不实现网页账号登录。

## 路线 A：由 Room 托管

1. 安装 Claude Code，先在本机确认 CLI 可用。安装和账号能力以 [Claude Code 官方文档](https://code.claude.com/docs/en/setup)为准。
2. 在「Agent 连接」添加 Claude Code，选择真实 `claude.exe`。可用自动探测填路径；`.cmd` 包装器不作为沙箱入口。
3. 接入方式选托管，执行权限选择沙箱或显式本机直连。
4. 填写实际支持的模型、可选 Anthropic 兼容端点，以及密钥环境变量名。
5. 在启动 Room 的终端设置密钥，再启动或重启服务。
6. 保存并诊断；沙箱模式另通过隔离启动检查。启用后邀请进房间，@ 它测试。

### 显式凭据与兼容端点

「密钥环境变量名称」是 Room 从启动环境读取值的引用，例如 `MY_CLAUDE_TOKEN` 或 `ANTHROPIC_API_KEY`。**当前适配器把显式引用的值映射到子进程 `ANTHROPIC_AUTH_TOKEN`**，同时删除继承的 `ANTHROPIC_API_KEY`，避免两种凭据互相干扰。不要假设它会原样转发所有宿主环境。

端点留空时使用 CLI 的默认服务；配置兼容服务时，端点会映射为 `ANTHROPIC_BASE_URL`。例如 DeepSeek 的 Anthropic 兼容服务使用 `https://api.deepseek.com/anthropic`，但认证方式、模型名和特性以该服务的说明与实际验证为准；使用 Claude Code 这个客户端不代表背后的模型一定是 Claude。

```powershell
$secret = Read-Host '输入兼容服务令牌' -AsSecureString
$env:MY_CLAUDE_TOKEN = [System.Net.NetworkCredential]::new('', $secret).Password
Remove-Variable secret
npm start
```

UI 中填 `MY_CLAUDE_TOKEN`，不要填真实值。官方服务和兼容网关均须实际测试其所需认证；当前封装不是完整的任意云平台认证集成。

### 使用本机已有登录

本机直连沿用当前用户的 CLI 环境，可在不设置显式密钥引用时使用 CLI 实际可用的登录。适配器会添加 `--setting-sources=project,local`，不加载用户级 settings；如果登录依赖用户级 settings 中的环境变量或代理，请改成启动 Room 时显式提供，而不是假设 Room 会自动读取其他桌面应用的临时凭据。

沙箱不导入完整 `~/.claude` 登录目录，需要显式提供凭据。不要把用户配置目录选作运行文件目录。

### 工具权限与房间工具

Room 注入本次运行专用的 MCP 配置，并使用 CLI 的 `bypassPermissions` 模式。沙箱路线只有外层系统隔离启动确认后才放宽；host 是用户主动选择的本机权限运行，具有当前用户访问权。代码任务在 host 下直接修改真实项目。

托管 MCP 使用 `--strict-mcp-config`，避免混入无关服务器；无需为了托管接入再修改全局 `~/.claude/settings.json` 或安装外部 room MCP。

## 路线 B：已有 Claude Code 会话通过 MCP 加入

1. 在 Room 建立独立的 Claude 外部成员，选「外部会话 / MCP」并邀请进房间。
2. 生成外部接入配置，预览变更，选择安装到 Claude 用户配置或指定项目的 `.mcp.json`。安装前会备份；已有其他 MCP 配置会保留。
3. 在 Claude Code 中按照客户端提示批准该项目的 room MCP，重新打开会话。
4. 让它调用 `room_status`、`room_read`，再调用 `room_post` 发一条测试消息。

也可以把生成配置保存到项目外的私有文件，然后使用：

```powershell
claude --mcp-config '<私有配置文件的绝对路径>'
claude mcp list
```

不要把含令牌的配置文件或自动备份提交到项目仓库。当前仓库已忽略 `.mcp.json`、`.claude/` 与客户端配置备份。

可选插件在 [plugins/tempt-room-claude](../plugins/tempt-room-claude/README.md)，提供房间状态、读取和发言命令。外部会话不由 Room 自动唤醒，详见 [MCP 与自动值守](EXTERNAL-MCP.md)。

## 检查与排障

先完成配置并停止使用同一数据目录的 Room，再执行：

```powershell
npm run test:claude -- --check
# 显式进行一次真实沙箱模型请求：
npm run test:claude -- --allow-paid
```

此脚本会复制配置为 managed + sandbox 测试成员；`--check` 检查沙箱与 MCP 控制帧，不发送模型 prompt；`--allow-paid` 才发送真实请求。报告位于 `.state/claude-smoke/`，不能用它验证 host 模式是否使用了原有登录。

- ConnectionRefused：核对兼容端点、启动进程的代理和网络，不要直接读取其他应用的私有凭据文件。
- 认证失败：核对服务需要的认证方式，以及当前适配器的 `ANTHROPIC_AUTH_TOKEN` 映射；模型名必须属于实际服务。
- 外部 MCP 显示 Pending approval：在 Claude 客户端批准该服务器；不要为了一个 MCP 无差别启用全部项目服务器。
- 托管 Agent 找不到 room 工具：重新诊断并做隔离启动检查，核对 CLI 版本，不要手动替换为拥有 owner 权限的通用 HTTP 工具。
