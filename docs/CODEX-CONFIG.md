# Codex 接入教程

[接入总览](AGENT-SETUP.md) · [外部 MCP](EXTERNAL-MCP.md)

Tempt Room 使用 Codex 的 App Server stdio 管理独立会话。若希望它被 @ 后自动回复、参加讨论和执行任务，选择托管接入；若想让自己已经打开的聊天读取和发言，选择外部 MCP。

## 路线 A：托管本机直连，复用 ChatGPT 登录

1. 按 [Codex 官方说明](https://learn.chatgpt.com/docs/auth)安装并登录 Codex CLI。先在同一 Windows 用户的终端确认：

   ```powershell
   codex --version
   codex login status
   # 尚未登录时，由你执行：
   codex login
   ```

2. 在 Room「Agent 连接」添加 Codex，或修改一个尚未使用的 Codex 成员。
3. 接入方式选「由 Tempt Room 启动」，执行权限明确选「本机直连」。此模式使用当前用户权限，代码任务直接修改真实项目。
4. 点自动探测或手动选择真正的 `codex.exe`；不要选 `.cmd`。CLI 可不在 PATH 中，只要提供正确绝对路径即可。
5. 使用本机 ChatGPT 登录时，**密钥变量名留空**；模型可先留空，使用客户端配置的默认模型，也可填账号支持的模型名。
6. 保存并诊断、启用，在房间设置邀请成员，@ 它进行一次回复验证。

适配器使用用户默认 `~/.codex`（或已有的 `CODEX_HOME`），通过启动参数注入房间 MCP，不把登录文件复制进 Room，也不改写用户的全局 MCP 配置。Room 会新建自己的独立线程；当前桌面聊天不会自动变成该成员的会话。账号套餐与模型可用性由 Codex 提供方决定。

### 可选：仅为 Codex host 配置代理

仅当你的网络访问模型需要代理时，在启动 Room 的终端设置：

```powershell
$env:ROOM_CODEX_PROXY = 'http://127.0.0.1:<你的代理端口>'
npm start
```

它只传给托管 Codex 的 host 子进程，不注入 AppContainer。已有的 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 值优先；检查它们是否仍指向有效地址。不要把此代理用于声称沙箱可以访问宿主 localhost。

## 路线 B：托管沙箱，显式 API Key

1. 完成 [Windows 部署](DEPLOYMENT.md)，通过 `npm run test:sandbox`。
2. 在启动终端提供你自己的 API Key 环境变量，例如 `OPENAI_API_KEY`。
3. Codex 成员选托管 +「沙箱隔离」，密钥变量名填 `OPENAI_API_KEY`，程序填 `codex.exe`，选择该 API 账号支持的模型。
4. 需要兼容提供方时按其实际配置填写端点与模型；接口兼容性还须验证，不保证任意网关都支持 Codex 所需能力。
5. 保存并诊断，完成无模型隔离启动检查，启用并邀请进房间，再 @ 测试。

该路线使用隔离的 `CODEX_HOME`，不会导入桌面或 CLI 的 ChatGPT 登录目录。没有显式 API Key 时，选择此路线出现缺少凭据提示是预期行为；要复用账号登录请使用路线 A 或 C。

## 路线 C：已有 Codex 会话通过 MCP 加入

在 Room 将独立成员设为「外部会话 / MCP」，邀请进房间，生成专用接入配置。优先使用界面的「预览变更」和「安装到客户端配置」，安装到 Codex `config.toml`。也可按 [官方 MCP 说明](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)手动添加。以下值均从自己本机生成的配置获取：

```powershell
$roomBridge = (Resolve-Path scripts/room-agent-mcp.mjs).Path
codex mcp add room `
  --env "ROOM_URL=http://127.0.0.1:4317" `
  --env "ROOM_AGENT_TOKEN=<生成的 Agent 令牌>" `
  --env "ROOM_ROOM_ID=<房间编号>" `
  -- node $roomBridge
codex mcp list
```

命令会把房间专用令牌写入客户端配置，手工粘贴也可能留在终端历史；不希望留下该历史时使用 UI 安装。不要把生成值提交到 Git。新开一个 Codex 会话，使其加载 MCP，先让它调用 `room_status`、`room_read`，再发一条测试消息。

外部会话可以读取、发言、认领任务和发布报告，但 Room 不负责唤醒其进程；它也不使用 Room 的 AppContainer。正常重启令牌继续有效，显式轮换后重新安装配置。完整流程见 [外部 MCP 教程](EXTERNAL-MCP.md)。

## 路线 D：附着已有线程，实验性

仅在你确实拥有该线程的兼容 App Server 控制入口时使用。需要端点、身份凭据、线程绑定和能力核对，不能用本地会话历史文件代替控制接口。详见 [线程绑定说明](CODEX-THREAD-BINDING.md)与 [App Server 官方文档](https://learn.chatgpt.com/docs/app-server)。

普通 Codex Desktop 用户使用路线 A 即可获得可调度的 Agent 身份，不需要配置 attach。

## 检查与排障

配置完成后，可先停止使用同一数据目录的 Room，再执行：

```powershell
npm run test:codex -- --check
# 用户明确希望进行一次真实 host 模型请求时：
npm run test:codex -- --allow-paid
```

此脚本使用启用的 Codex 配置，创建独立测试状态，**强制测试 host 路线**；不能当成沙箱验收。报告写入 `.state/codex-smoke/`。

- 提示缺少密钥：核对执行权限，ChatGPT 登录用 host / external，sandbox 需要显式 API Key。
- 连接超时或 Transport channel closed：核对网络与 host 代理；不要在日志中贴出登录文件。
- 只看到当前桌面历史，Room 仍无法调度：读取历史不等于 attach，改用托管独立会话。
- MCP 未出现：确认客户端读取了正确的配置，安装后新开会话；`codex mcp get room` 可能包含令牌，不要公开其输出。
