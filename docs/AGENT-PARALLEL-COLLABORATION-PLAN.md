# Agent 并行与实时协作架构 Plan

> 由 Tempt Room 房间「Agent 并行与实时协作研讨」中 DeepSeek 综合 DeepSeek / Claude / Codex 两轮讨论生成；房间 ID：`room_046d0d633a45437686f338c84c2c508b`。

# Agent 并行与实时协作架构 Plan

**版本**：v1.0（三方交叉评审收敛稿）  
**范围**：Tempt Room 单机 Windows 模块化单体；目标是在不重写为分布式服务的前提下，支持多 Agent 并行、群聊式实时协作与企业级可运维性。

---

## 1. 目标与非目标

**目标**
- 多个 Agent 可并行执行任务，消息流像 QQ 群一样实时可见、可回放，每个 Agent 只消费与自己相关的增量。
- 任务进度、产物（artifact）和运行状态共享同一事实源，客户端、Agent、服务端看到一致状态。
- 回复速率不同的 Agent 不会互相阻塞；慢者可有界降级，快者不能独占轮次。
- 所有失败可解释、可重试、可审计；断线后可恢复；成本可计量、可限制。

**非目标**
- 不做跨机器的强一致分布式事务，也不做多租户 SaaS；
- 不以内存广播作为事实源；不把 AgentScope 风格的静态管道当作主要编排模型；
- 不在 P0/P1 引入中心化 Agent Service RPC 与外部消息队列。

---

## 2. 消息模型与实时协议

### 2.1 四层分层

| 层 | 内容 | 持久化 | 可重建 |
|---|---|---|---|
| 命令 `command` | 用户或 Agent 的意图写入（发消息、建任务、取消） | 是（`commands` 幂等表） | 否 |
| 事件 `event` | 已提交事实，唯一真相源 | 是（`events`，`UNIQUE(room_id,seq)`） | 否 |
| 投影 `projection` | 看板、inbox、presence 汇总、任务/运行快照 | 是，但可重算 | 是 |
| 瞬态 `ephemeral` | token delta、typing、ACK、光标 | 否 | 丢弃 |

**关键规则**：新增事件类型必须在 **schema 注册表** 中声明 `durability / aggregate / projector / schemaVersion`；未注册或未通过契约测试的类型一律拒绝落库。这样可避免靠人工记忆判断“该不该落库”，也为后续 schema 演进提供升级路径。

**事件信封**（所有 kind 复用）：

```ts
{ eventId, roomId, seq, ts, kind, schemaVersion,
  actor: { type: 'human'|'agent'|'system', id },
  aggregate: { type: 'room'|'task'|'run'|'artifact', id },
  baseSeq, replyTo, idempotencyKey, generation, traceId, payload }
```

**已确定的事件类型**：`message.posted`、`task.created|state|version|handoff|claim|lease`、`run.queued|started|blocked|partial|completed|failed|cancelled|superseded`、`artifact.published`、`audit.recorded`。瞬态包括 `token.delta`、`typing`、`presence`、`ack`。`run.partial` 是**持久事件但不进入聊天投影**，只用于进度回放与 supersede 链。

### 2.2 seq、快照与读写路径

- **单写者**：每个房间由服务端单一写线程分配 `seq`，事件与投影在同一 SQLite 事务内提交；跨房间可并行。
- **客户端一致性**：入口为 `GET /rooms/:id/snapshot?cursor`，同事务返回 `snapshot(asOfSeq=N)` + `tail`。WebSocket `subscribe?afterSeq=N` 只推增量；发现 `seq` 缺口（`nextSeq > localSeq+1`）立即走 REST 补拉，按 `eventId` 去重。
- **幂等**：命令携带 `commandId`；同 id 同 hash 返回原 receipt，同 id 异 hash 返回 409。Agent 侧幂等键升级为 `(runId, agentId, generation, operationId)`，其中 `operationId` 是**工具副作用**的稳定标识（见风险 R4），不再用 attempt 计数。

### 2.3 断线恢复

服务端在启动时重建 `running` 且租约过期的 run 为 `interrupted`，`generation+1` 后重新入队；客户端重连后先拉快照再补尾。任何“看起来在跑”的 UI 必须能对应到一条 `run.started` 事件，否则视为异常。

---

## 3. 任务状态同步与数据共享

- **投影**：`proj_task`（状态机 `proposed → accepted → running → blocked → done/failed/cancelled` + 进度 + 依赖）、`proj_run`（阶段、耗时、成本、错误码）、`proj_artifact`（引用与版本）。每张投影表带 `as_of_seq`，支持 `rebuildProjections(fromSeq)` 全量重放；重建期间对外只读。
- **进度只能由服务端派生**：Agent 的进度上报是“证据”（工具调用、产物写入），服务端状态机据此生成 `run.status`，禁止 Agent 自行写“进度条”。这样可统一消除伪造进度和重复事件。
- **baseSeq 读取水位**：派发 run 时固定 `baseSeq = 当前 seq`，Agent 的上下文、工具读取与提示组装都以该水位为界；回复携带 `baseSeq` 与 `generation`。提交时做两项校验：
  1. `generation` 必须等于当前值（fencing token），旧执行一律拒收；
  2. 若 `seq - baseSeq` 超过阈值，或期间出现针对该 Agent 的新 `@`/任务版本变更，则不直接接收，而是先补投增量，要求 Agent 对账后重新提交，避免“基于旧快照得出相反结论却被双双记为成功”。
- **版本与冲突**：任务目标修改递增 `task.version` 并取消旧 run；产物应用前比对 `expectedVersion` 与基线，不匹配整体拒绝。代码类任务仍按 worktree 隔离，产物以引用共享而非内联复制。

---

## 4. Agent 并行调度

- **依赖 DAG**：任务依赖决定可运行集（`ready set`）；只有依赖全部交付且未被阻塞的任务才可派工。fanout 只是 DAG 的一种元数据（并发度 + 聚合 deadline），不单独实现一套执行器。
- **租约**：`lease_until` + 心跳续租（默认 10 分钟，可配）；过期回收为开放任务，`generation+1`；回收与旧写拒收配合，防止重复执行。
- **并发上限**：保留现有三道闸门——同 Agent 会话串行、房间级并发上限、全局并发上限；外部 CLI 进程数与内存另设硬顶。
- **公平队列**：单一仲裁循环从 `ready set` 取任务，按 `(deadline slack, 等待老化, 优先级, baseSeq)` 做加权公平调度（WFQ + aging）。同一根消息设**链深上限**与每 Agent 每轮配额，防止 A→B→A 自激与快 Agent 独占。
- **抢占与取消**：用户新消息或任务版本变更触发取消，取消向下传播到适配器进程；被抢占的运行标记为 `superseded`（保留已有产物与 partial），而不是 `cancelled`。重试按错误分类（瞬时/永久/取消/策略拒绝）决定，指数退避 + 抖动，且受预算约束。

---

## 5. 速率差异与异步背压

- **动态发言窗口**：`deadline = clamp(EWMA(p95 最近 N 次耗时) × 系数, min, max)`，按 `(agentId, adapter, 任务类型)` 分桶统计，避免固定 30 秒把快 Agent 拖慢、把慢 Agent 逼成超时。
- **partial supersede**：窗口到期时，若有中间产出则发布 `run.partial`（限频，例如 ≤1 条/2 秒/run，并设大小上限），最终稿以 `supersedes` 指向 partial；partial 永不进入聊天投影，重放不重复计数。前端按 `draft → final` 替换渲染。
- **背压**：per-agent 有界 inbox（满则合并同类进度、保留终态）、房间级待办上限、WS 慢客户端只丢瞬态不丢事件、工具输出截断与摘要化。
- **quota 与 budget**：每 Agent 每轮 `@` 配额、每任务 token/费用/时长硬限额，超限即 `run.failed(budget_exceeded)` 而不是静默截断。
- **迟到处理**：迟到结果先做 `generation + baseSeq` 校验；校验通过但轮次已结算，则记为 `run.late`，作为下一轮输入而非插回已冻结的投影；讨论轮次采用显式 quorum（如 2/3 到场即续），缺席者显示 `absent` 而非空白。

---

## 6. 企业级 UX 与可观测性

- **进度透明**：run 时间线逐阶段展示（排队/运行/阻塞/完成），每条消息挂 `traceId`、工具调用摘要、耗时与成本；阻塞要给出具体原因（等依赖、等租约、等用户确认）。
- **真实失败态**：统一错误码与原文摘录，提供重试、取消、回收、查看差异；`interrupted / absent / unknown-cost` 必须显式呈现，严禁“假成功”或把未知费用显示为 0。
- **审计**：事件不可变，审计记录可导出 JSONL；关键动作（取消、应用产物、接受决策、令牌轮换）单独成事件。
- **成本**：按 run/agent/房间三维聚合 token 与费用，未知即 unknown；预算熔断在调度入口生效。
- **权限与信任边界**：沿用房间级 Agent 令牌隔离；消息带**来源与信任级**（human / server-derived / agent / untrusted-external），外部 MCP 与 A2A 文本默认低信任度。**工具调用前做策略校验**，低信任消息不得直接转化为高权限指令或文件写入，防级联提示注入。

---

## 7. 与 AgentScope 的差异对比

| 维度 | AgentScope | Tempt Room 现状/目标 | 取舍 |
|---|---|---|---|
| 消息模型 | MsgHub 进程内广播，消息随进程消亡 | SQLite 事件日志 + `seq` 全序 + 幂等回执，可回放 | 借鉴 `observe` 订阅语义，落为持久 subscription 投影；不照搬内存广播当事实源 |
| 编排 | sequential / fanout 静态管道，代码内定拓扑 | 事件驱动动态调度（@、认领、租约、DAG） | 借鉴管道组合与“收齐/超时”语义，降级为任务元数据（并发度 + quorum deadline） |
| 持久化/恢复 | 会话级，进程重启即丢失上下文 | 事件源 + 投影重建，崩溃恢复与断线补拉 | 保留；这是相对 AgentScope 的核心差异优势 |
| 服务化 | 2.x Agent Service 提供会话、存储、调度与消息总线扩展，中心化 RPC | 单机模块化单体，托管本地 CLI + MCP 外部 Agent + A2A | 不照搬中心 RPC；先抽 `EventStore`/`Transport` 接口，保留日后接入 Service 的可能 |
| 沙箱/工具 | 以框架内工具与执行环境为主 | Windows AppContainer / 本机直连双模式，工具副作用不受事务保护 | 保留隔离与权限优势；补齐工具操作 ID 与补偿机制 |
| 扩展性 | 进程内水平扩展受限，依赖外部服务 | 单机纵向扩展强，横向是短板 | P2 做房间分区与 outbox 外发，而非重写架构 |
| 适用场景 | 快速原型、单进程多 Agent 管道 | 长时任务、多 CLI 混合接入、需要审计与恢复的企业协作 | 定位不同：Tempt Room 更接近 durable workflow + IM |

**结论**：借鉴 MsgHub 的订阅解耦、管道的聚合语义、Service 的接口抽象；不照搬其内存状态作为事实源、静态拓扑作主编排、中心 RPC 作默认部署。

---

## 8. 落地路线与验收标准

**P0（一致性底座，2–3 个迭代）**
事件信封与 schema 注册表；投影重建器；`snapshot + afterSeq` 接口与 WS 缺口补拉；`baseSeq` 水位与 `generation` fencing；`run.partial/supersede`；真实失败态与租约回收。
*验收*：随机杀进程后重启，投影与事件重放结果逐字节一致；重复投递、乱序、缺口补拉全部通过；旧 generation 写入 100% 被拒；UI 不存在无事件支撑的“运行中”。

**P1（调度与体验）**
单一仲裁 WFQ + EWMA 窗口 + quota/budget 熔断；quorum 与迟到处理；审计导出；来源信任级与工具前策略校验；成本看板。
*验收*：快慢 Agent 混合压测下慢者不被饿死、快者不超配额；窗口超时 partial 可见且不重复渲染；预算超限 100% 熔断且原因可查；注入型消息无法触发高权限工具。

**P2（可演进性）**
`EventStore` / `Transport` 双接口抽取；outbox + HLC 预留多机同步；房间级分片；可选接入 AgentScope Agent Service 适配器。
*验收*：适配器可在不改核心调度与投影的前提下替换；单房间事件导出后可被第二实例重放消费。

---

## 9. Top 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| R1 上下文发散 | 两 Agent 基于不同旧快照给出矛盾结论且都被记为成功 | `baseSeq` 水位 + 提交前对账 + 增量补投 |
| R2 工具副作用不可回滚 | 取消≠撤销，重试造成重复写入 | 稳定 `operationId` + 工具端幂等/补偿 + 时间线标注“不可逆副作用” |
| R3 级联提示注入 | 被注入文本被下游当指令执行 | 来源信任级 + 工具前策略校验 + 低信任默认只读 |
| R4 事件日志膨胀 | 快照与恢复变慢、备份变大 | 日志分段 + 定期快照 + 保留策略与归档导出 |
| R5 伪进度/假成功 | 用户误判，审计失真 | 进度只由服务端派生；未知成本显示 unknown |
| R6 调度饥饿与自激 | 快 Agent 占满轮次，A→B→A 死循环 | WFQ + aging + 链深上限 + 每 Agent 配额 |
| R7 N 路上下文成本放大 | 广播式上下文导致费用指数增长 | 上下文摘要化 + 预算硬限额 + 按订阅而非全量投递 |

---

## 10. 建议的下一批实现任务（按优先级）

1. **事件信封 + schema 注册表 + 迁移**：定义 `kind/durability/aggregate/projector`，未注册类型拒绝落库。
2. **投影重建器与快照接口**：`rebuildProjections(fromSeq)` + `snapshot(asOfSeq)` + `afterSeq` 补拉，含缺口检测。
3. **baseSeq 水位与 generation fencing**：派发时固定水位，提交时双校验，旧写拒收。
4. **run 状态机与 partial/supersede**：服务端派生进度，`run.partial` 限频、不入聊天投影。
5. **租约回收与崩溃恢复**：启动时 `interrupted` 重建、`generation+1` 重入队。
6. **回放契约测试与故障注入**：seq 边界杀进程、重复投递、乱序、并发冲突纳入 CI 门禁。
7. **单仲裁调度器**：WFQ + aging + EWMA deadline + quota/budget 熔断（P1 起点）。
8. **信任级与工具前策略校验**：消息来源标注、低信任只读、审计导出 JSONL。
