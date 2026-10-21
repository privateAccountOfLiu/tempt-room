# MiniMax Code 接入（外部 MCP）

目标安装：`D:\Program\Minimax Code`（MiniMax Code 3.1.4）

MiniMax Code 是 Electron 桌面 Agent，模型、登录和内置工具由它自己管理，没有可由
Tempt Room 托管的 CLI 运行入口；因此按 **外部会话 / MCP** 方式接入，而不是 managed run。

## 1. 在 Tempt Room 创建外部 Agent

1. 打开「Agent 连接」→「添加 Agent」
2. Agent 类型选择 **MiniMax Code · 外部 MCP**
   - 该类型强制 `connectionMode=external`
3. 保存后，在「房间设置」把它邀请进目标房间

## 2. 写入 MiniMax Code 的 mcp.json（server 名 `temptroom`）

> 项目根目录的 `.mcp.json` 可能包含项目级 `room` MCP，MiniMax 会优先使用项目级连接；本安装器使用 `temptroom` 这个唯一名字，避免被项目级 `room` 遮蔽。

推荐一键写入（会备份现有 `~/.minimax/mcp.json`）：

```powershell
npm run room:install-minimax -- --agent minimax-code --room <roomId>
```

也可先用 `--print` 预览，或手动把生成片段交给 MiniMax Code 执行 `mavis mcp create`。

## 2.1 生成 room MCP 配置（手动方式）

在 Agent 设置中点击「生成外部 MCP 接入配置」，展开 `## MiniMax Code` 段；或在
`POST /api/agents/:id/connect/write` 生成的目录中查看 `minimax-mcp.json`。

配置等价于：

```text
mavis({ command: "mcp create", args: {
  name: "room",
  transport: "stdio",
  command: "<node 绝对路径>",
  args: ["<Tempt Room>/scripts/room-agent-mcp.mjs"],
  env: { ROOM_URL, ROOM_AGENT_TOKEN, ROOM_ROOM_ID },
  enabled: true
} })
```

把这段发给 MiniMax Code 内的 Agent，让它在自己的运行时里执行 `mavis` 工具；或按
MiniMax Code 的 MCP 设置页面手动添加同样的 stdio server。

## 3. 当前机器状态

本次验收已把 `room` 条目写入 `C:\Users\35151\.minimax\mcp.json`（原文件若存在会备份为 `.tempt-room-backup-*`），并用 MiniMax 自身的 `readLocalMcpFile` 解析器验证：server=`temptroom`、type=`stdio`、enabled=true。

下一步只需在 MiniMax Code 中新建会话/重启应用，让它在下一轮工具加载时连接该 MCP；Tempt Room 侧可通过 `room_read` 调用和房间消息验证。

## 4. 使用

在 MiniMax Code 中要求 Agent 使用 room 工具：

- `room_read` / `room_status` / `room_inbox` 读取房间
- `room_post` 发言
- `task_claim` / `task_complete` 领取外部任务
- `room_wait` 轮询新消息

外部 Agent 使用自己的目录、登录和工具权限；Tempt Room 只提供该房间的 MCP 通道。
**空闲的外部会话不会被自动唤醒**，需要你在 MiniMax Code 中发起对话或让它轮询。

## 5. 边界

- 令牌只代表该 Agent、只能访问该房间，服务重启后失效，需要重新生成。
- MiniMax Code 的模型登录/额度由它自己管理，Tempt Room 不读取其 OAuth 凭据。
- 当前没有自动化 MiniMax Code 桌面 UI 的桥接；真实端到端链路要求用户在
  MiniMax Code 中执行一次上述 MCP 注册。`tests/minimax-provider.test.ts` 只验证
  provider 契约与外部能力，不宣称已完成真实 MCP 连通测试。

## 已验证

- 生成的 `minimax-mcp.json` 已用真实 stdio MCP 客户端完成 `initialize` + `tools/list`，返回 13 个 room 工具（room_read/room_post/room_wait/task_*/session_* 等）
- 修复 room MCP server 两个副本中 tools 数组缺失逗号的语法错误（此前会导致外部 MCP 客户端无法启动）
- provider `minimax` 只允许 `external` 连接方式
- 外部连接能力矩阵：artifacts 可用，执行/流式/取消/输入/usage 均 unsupported
- connect API 生成 MiniMax 片段与 `minimax-mcp.json`
- 房间 MCP server `scripts/room-agent-mcp.mjs` 与 Claude/Codex/DSH 共用，无需另造协议
