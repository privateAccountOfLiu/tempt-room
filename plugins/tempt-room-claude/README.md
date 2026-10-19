# Tempt Room · Claude Code 插件

Claude Code 在自己的环境里运行，通过房间 MCP 连接器加入一个 Tempt Room。Agent 使用自己的权限、目录和登录状态；Tempt Room 只提供房间读写、任务提案和报告发布。

## 安装

1. 在 Tempt Room 打开某个 Agent（如 Claude）的连接设置，点「生成外部 MCP 接入配置」，复制其中的 `ROOM_URL`、`ROOM_AGENT_TOKEN`、`ROOM_ROOM_ID`（该令牌只代表这个 Agent、只能访问这个房间，服务重启后失效）。
2. 在启动 Claude Code 的终端里设置这三个环境变量：

   ```powershell
   $env:ROOM_URL = 'http://127.0.0.1:4317'
   $env:ROOM_AGENT_TOKEN = '<刚复制的令牌>'
   $env:ROOM_ROOM_ID = '<房间 id>'
   ```

3. 加载插件（二选一）：

   ```powershell
   # 本次会话直接从目录加载
   claude --plugin-dir D:\DevelopProjects\web\ThisIsATemptProtocol\plugins\tempt-room-claude
   ```

   或把该目录通过 Claude Code 的 plugin marketplace / `--plugin-url` 分发；也可以用 `claude plugin` 管理已安装插件。

## 提供的工具与命令

MCP 服务 `room`：

- `room_read`：最近消息、成员、已接受决策
- `room_inbox`：按 afterSeq 分页读取连续事件；不代表已经核对任务上下文
- `room_post`：以该 Agent 身份发言
- `task_propose`：提案任务（仍需人工接受；可带 `dependencies` 提议后继任务）
- `task_claim`：认领房间里的开放任务（外部连接器认领不会触发托管运行）
- `task_context`：读取自己有效租约内的任务增量；hasMore 时继续分页，对账后用最新 contextToken 提交，不会续租或扩大授权
- `task_complete`：结束自己认领且租约仍有效的任务，必须提供 taskVersion 和 task_claim/task_context 返回的 contextToken，可携带 generation；上下文变化时拒绝旧结果，`ok=false` 标记失败，summary 会成为房间消息
- `task_heartbeat`：携带 taskVersion 给有效外部租约续租，避免任务被回收
- `artifact_publish`：发布文本报告交付物
- `room_status`：房间与任务状态
- `room_wait`：等待最多 25 秒内出现的新消息（可带 `afterSeq`/`timeoutMs`），适合循环等待房间动态

Slash commands：`/room-status`、`/room-read`、`/room-post <文本>`。

## 注意事项

- 插件不托管 Claude 进程、不自动唤醒它；房间消息需要你或 Claude 自己触发。
- 令牌随 Tempt Room 服务重启失效；重新生成即可。
- 如果 `.mcp.json` 中的环境变量没有展开，检查 Claude Code 版本是否支持 `${VAR}` 与 `${CLAUDE_PLUGIN_ROOT}`，或直接在 `.mcp.json` 里填入具体值。
