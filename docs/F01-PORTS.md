# F01 — EventStore 与 AgentTransport 端口

实现日期：2026-10-21

## EventStore

`apps/server/src/ports/event-store.ts` 定义协作核心实际使用的事件存储能力：

- `atomic` 本地写事务
- `event` 原子追加 + `saveReceipt`/`receipt` 命令回执
- `events` / `scanEvents` 水位分页
- `snapshot` / `snapshotAt` / `snapshotWithTail`
- `get` / `list` / `room` / `rooms` / `settings` 投影查询
- `projectionStatus` / `projectionBytes` / `rebuildProjections`
- `findPreviousOperation` 供工具操作去重使用

没有虚构分布式事务：事务语义就是当前 SQLite 连接上的本地事务。

`Store` 显式 `implements EventStore`；`RoomService`、`Worker` 及
context/execution/resource-manager/tool-operations 等核心辅助模块均改为依赖该端口。
生产路径由 `app.ts` 注入真实 `Store`。

### 验收

`tests/event-store-transport-contract.test.ts`：

- SQLite 文件库与内存库（`Store(':memory:')`）跑同一套房间协作场景
- 相同事件序列、消息/任务数量、分页与重建投影结果一致
- 命令回执、水位、历史 floor 均可用

## AgentTransport

`apps/server/src/ports/agent-transport.ts` 定义：

- `openExecution(context)` → `outputs` 异步流
- 可选 `provideInput` / `cancel` / `queryOutcome`
- `LocalAdapterTransport` 包装现有 `runAdapter`，不另造协议

`Worker` 构造参数新增 `transport`，生产默认使用 `localAgentTransport`；
旧的 `adapter` 测试注入保持兼容（自动包装为 `LocalAdapterTransport`）。

### 验收

`tests/event-store-transport-contract.test.ts`：

- 用自定义 `AgentTransport` fixture 跑完整 run 状态机
- 成功输出写入房间消息、run completed
- 失败 fixture 产生 failed + 错误保留，不修改投影/调度逻辑

## 未做/边界

- 没有引入 HLC 或跨实例分布式事务。
- `AgentTransport` 的 service 能力是否可用由各适配器能力证据决定；本地适配器不伪造这些能力。
