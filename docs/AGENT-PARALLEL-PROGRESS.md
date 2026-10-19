# 并行协作计划实施记录

目标仍为完整实现根目录 [agent-parallel-collaboration-plan.md](../agent-parallel-collaboration-plan.md)。本文件记录实际状态，不能替代原计划或缩减验收范围。目标状态：进行中。

## 本批：P0 的事件与投影底座

已实现并验证：

- 协议中的事件注册表，声明 durability、aggregate、projector、schemaVersion 与允许的 kind；新增的持久事件逐一通过载荷/投影契约测试。未注册类型、错误载荷、瞬态落库以及超前的读取水位均在事务提交前拒绝。
- 事件增加 kind、ts、schemaVersion、aggregate、baseSeq、generation、replyTo、idempotencyKey、traceId，保留原 type/createdAt 等字段。首批只提供 generation 信封字段；实际运行 fencing 在下述第二批中接入。
- 事件表的 SQLite UPDATE/DELETE 禁止触发器；提交后通知使用独立、冻结的事件对象，不会被业务对象后续变化篡改。
- 实时写入、历史快照和重建共用投影器。实际 messages/tasks/runs/artifacts/discussions/decisions/contexts 行由事件驱动更新；任务版本事件会使旧消息失效。`Store.put` 对这些表也是事件入口，不能绕过日志单独改投影。
- 实际表增加 `as_of_seq`，`projection_offsets` 保存房间水位；`proj_task`、`proj_run`、`proj_artifact` 是现有投影表的兼容视图，不另存一份可能分叉的状态。
- `rebuildProjections(roomId, fromSeq)` 在事务内重建实际应用读取的表；使用起点之前最近的基线，并重放至当前 head。重建中拒绝应用写入，遇到断号或无效事件整体回滚。
- 不支持的事件 schemaVersion 会拒绝回放；取得重建写事务失败后可正常继续写入。打开更高版本数据库时，在修改 journal mode 前拒绝，并关闭句柄，保留原文件字节。
- `GET /api/rooms/:id/snapshot?cursor=&limit=` 在同一 WAL 读事务返回 snapshot、asOfSeq、headSeq、tail、nextCursor、hasMore。旧房间查询保留，并使用相同的一致性读取路径。
- TypeScript SDK 遇到乱序/缺口先用 REST 补齐连续事件，按 seq/eventId 去重；跨房间帧、复用 eventId、无法补齐的缺口不会推进游标。客户端队列有界，慢连接通过断线和持久游标恢复，瞬态输出可被丢弃。
- 补齐原先未持久化的外部租约续租、讨论轮次配额更新和 Agent 配置变更通知。
- 数据库 v2→v3 升级前创建 checkpoint 后的独立备份，并在迁移事务内追加每房间基线；不重写旧事件。基线以前无法证明完整的历史不作为精确历史快照返回，响应以 historyFloor/reset 标明边界。

验证：

- `npm run test:replay`：14 项事件/迁移/回放测试和 5 项客户端游标测试。
- 完整测试 144/144 通过；包括真实子进程在事务内退出、提交后退出、幂等回执恢复与逐字节重建比较。
- 类型检查、生产前后端构建、SDK 类型声明与逐事件 JSON Schema 生成通过。
- 离线 SDK 打包、离线安装、ESM/协议导入及 TypeScript 声明消费通过；未请求模型。证据：`.state/sdk-probes/run-v7cWro/report.json`。
- 最终生产构建在独立目录完成认证、SPA/CSP、WebSocket、持久化及终止后重启恢复测试；数据库版本为 3。证据：`.state/production-smoke/run-LMH6Sk/report.json`。凭据扫描 0 项发现。
- 对日常 SQLite 通过只读连接创建一致副本，在副本上迁移并逐房间重建：33 个房间全部逐字节一致；最大基线事件约 726 KB。日常数据库未迁移、服务未重启，未调用真实模型。证据索引：`.state/parallel-audit/latest.json`。

源码入口：[注册表](../packages/protocol/src/events.ts)、[投影器](../apps/server/src/event-projections.ts)、[存储与迁移](../apps/server/src/store.ts)、[游标同步](../packages/client/src/event-cursor.ts)、[回放测试](../tests/event-replay.test.ts)。

## 第二批：执行 fencing、租约与 Room 工具操作账本

已实现：

- 新运行使用 generation=1；每次实际启动分配独立 executionId。沙箱宿主使用 executionId 路由进程、stdio、取消与管道；Host 管道回调捕获冻结的 RunFence，不通过逻辑 runId 重新推断当前执行的权限。
- 沙箱 Codex 用本次进程的命令参数固定 MCP 管道；Claude 的 MCP 配置按 executionId 独立写入且禁止覆盖，避免新执行重写共享配置后被旧进程重新加载。取消前已撤销的 native 启动不打开进程通道。
- 消息、交付物、会话/usage 回调、等待输入与完成路径核对 generation、executionId 和任务版本。实际投影器也拒绝旧 generation 的运行/消息/交付物事实，不能用事件直写绕过生产者检查。
- 托管运行的租约由仍持有授权的 Worker 续租；过期或重启恢复递增 generation，撤销旧执行标识并保存 interrupted/unknown。旧输入等待的取消回调不会清理或恢复新 generation 的输入通道。
- 外部任务认领、回收、过期和目标变更推进任务 generation；认领回执返回 generation，续租/完成支持显式 generation 校验。旧连接器仍能以 taskVersion 作为兼容的租约 fence；原生运行的 executionId 不向 Agent 自行选择。
- Room 写工具使用稳定 operationId，持久 operation.started 后才执行；副作用结果与 operation.completed 在同一提交中确认。相同键和参数返回原回执，不同参数拒绝。跨 generation 重试同一已完成操作也返回原结果，未知操作阻止重做。
- 操作保存在事件驱动的 operations 投影；重建与历史基线支持该表。启动时将未确认的 started 标记为 unknown，不假定 SQL 回滚能够撤销磁盘写入。
- MCP 桥接器允许调用者显式提供 operationId；未提供时按本次桥接实例和 MCP 请求 ID 生成。跨桥接实例的业务重试需要保留显式 operationId，不能把新请求 ID 当成旧操作已去重的证据。
- Owner API `GET /api/runs/:id/operations` 与 SDK `RoomClient.operations(runId)` 可读取操作记录；协议包提供 RunFence、ToolOperation、对应 JSON Schema 与逐事件 schema。
- 数据库升至 v4；v3→v4 新增操作投影和索引，保留原事件及房间游标。v2→v4 保持旧数据基线迁移。

验证：

- 完整回归 161/161 通过；其中 17 项执行隔离/操作记录测试包含 100 次旧 generation 拒写、真实 Windows Host 管道与 MCP 桥接子进程、操作回执丢失与未提交前崩溃、租约过期、旧输入回调、传输配置不被后续执行覆盖、HTTP/SDK 查询及 v3 升级。
- 类型检查、生产构建和 SDK/JSON Schema 生成通过；模型请求数为 0。
- 日常 v2 数据的只读副本和前批审计 v3 副本分别迁至 v4，均有 33 个房间逐字节回放一致；1283/1316 条原事件字节不变。证据：`.state/fencing-audit/latest.json`。日常库没有迁移或重启。
- 原生 AppContainer 基础探测 23/23 通过（`.state/fencing-native/diagnostics/sandbox.json`）。`npm run test:fencing-native` 在新建临时库与真实 AppContainer/Job 内先写入一次，再换 generation，验证旧进程继续经原 MCP 管道发言被拒、房间序号不变、Job 清空；不调用模型。证据：`.state/fencing-native-probes/latest.json`。
- 离线 SDK 消费验证包含新增的 RunFence/ToolOperation 导出、JSON Schema 与 operations 方法：`.state/sdk-probes/run-0eRmmn/report.json`。最终生产构建启动、认证、事件持久化和退出恢复均已验证：`.state/production-smoke/run-BsXcs9/report.json`。凭据扫描 0 项发现。

范围边界：操作账本覆盖 Room 提供的写工具；原生 CLI 内部自行执行的 Shell/文件/远程请求尚没有通用稳定操作拦截。因此尚未启用这些任务的崩溃自动重跑，不能宣称所有外部副作用都已具备 exactly-once 保证。新 generation 也不能撤销旧进程已经产生的外部副作用。

## 第三批：运行状态机、持久草稿与 supersede

已实现：

- 新入队运行带 lifecycleVersion=1，投影器校验合法状态转换；queued→running 必须有 run.started，已结束的运行不能用普通 updated 复活。未知/中断后的完成使用显式 run.reconciled，重新排队必须有 run.requeued。旧日志按当时的事实回放，不对旧事件套用新状态约束。
- run.partial 持久到 Run.partial，永不生成聊天消息行。服务端每个运行最多两秒一份、每份最多 64 KiB UTF-8；超长文本保留完整 Unicode 前缀并明确标记截取。事件直写也受大小、限频、generation/executionId、任务版本与 supersedes 链校验。
- 每份草稿通过 supersedes 链接上一份；最终回复设置 final/supersedes 并原子保存 finalMessageId。若同一正文已经通过 MCP 发言，run.finalized 复用那条消息，不重复发布；一个运行只能有一个最终回复。普通运行状态更新不能注入或覆盖草稿与最终回复指针。
- Worker 在输出过程中持续保存有界检查点；取消/失败时保留已提交草稿，不再把不完整正文伪装成一条完整聊天回复。崩溃后草稿随投影恢复；未提交的最后一小段瞬态仍可能丢失。
- 任务改版和交接标记旧运行 stopReason=superseded，确认执行结束后成为 superseded；不能证明原生/远程执行已经停止时仍为 unknown/interrupted。用户明确停止仍为 canceled。普通历史消息不停止工作；新的点名请求替代该成员此前的聊天运行，代码任务和有界讨论使用各自的目标修改/停止操作。
- 界面单独渲染已保存草稿；流式正文和持久检查点只显示一份，最终稿出现时移除草稿。瞬态缺口不会被拼成看似完整的文本，而是显示最近的持久检查点。替代或取消后的草稿保留对应状态。
- 数据库升至 v5，阻止不理解新终态的旧程序打开数据；v4→v5 不改写既有事件或游标。提供 run-partial JSON Schema，其中 UTF-8 字节限制以 x-maxUtf8Bytes 描述，服务端执行实际校验。

验证：

- 13 项草稿/状态机测试覆盖限频、字节边界、旧 generation 拒写、非法 supersede 链、MCP 正文去重、瞬态缺口、目标替代与真实子进程退出后的恢复。完整测试 174/174 通过，结果见 `.state/partials-tests-final.log`。
- 最终浏览器端到端通过草稿刷新恢复、流式→最终稿无重复、superseded 草稿保留及原有任务/交付物/断线/登录恢复场景；无控制台异常。报告保留为 `.state/partials-browser-report.json`，截图保存为 `docs/screenshots/partial-drafts.png`；已检查布局。
- v2/v3/v4 只读数据副本分别迁至 v5，各 33 个房间逐字节回放一致，1283/1316/1316 条原事件字节不变。证据：`.state/partials-audit/latest.json`。
- 原生执行管道拒写探测继续通过（无模型调用）；构建通过。最终离线 SDK 验证包括独立 run-partial schema 和 superseded 状态导出：`.state/sdk-probes/run-KxBrRZ/report.json`；生产构建启动与恢复：`.state/production-smoke/run-3vLkZX/report.json`。凭据扫描 0 项发现。完整证据索引：`.state/partials-delivery.json`。日常库仍为 v2，未迁移、未重启。

仍未实现基于 baseSeq 的增量对账、EWMA 发言窗口与 quorum/late；持久检查点不等于这些调度行为已经实现。（后续第四批完成 baseSeq 对账、第六批完成 quorum/absent/late；EWMA 与公平排队仍未实现。）

## 第四批：baseSeq 增量对账与上下文预算

已实现：

- 新增 `ContextPolicy`（`maxDeltaBytes`、`maxLag`、`maxRounds`）与 `ContextDelta`；每个运行记录 `contextSeq` 水位，派发后如果出现新的 @、已接受决策、任务/交付物变化或落后超过阈值，必须先对账再提交旧结果。
- `contextDelta()` 从运行水位开始读取连续事件并生成有界增量（超过单条或总量上限时返回 `hasMore`，不把未读事实伪装成已读）；`assertContextCurrent()` 在消息发布、复核和完成路径拦截过期结果；`advanceContext()` 在同一事务内创建新的上下文快照、递增 generation/executionId 并发出 `run.context.advanced`，避免旧执行继续写入。
- Worker 在候选结果完成后自动发起一次“增量对账”补充轮次；Agent 收到 `reconciliationPrompt`，要求只根据新增事实修正结果，禁止重复有副作用的命令；完成时写入 `run.context.confirmed`，并把水位推进记录保留在事件日志。
- 协议与 SDK 提供 ContextDelta/ContextPolicy 类型及 JSON Schema；数据库升至 v6，迁移前创建独立备份并保留旧事件；旧数据库缺失上下文字段时按兼容策略处理，不伪造历史水位。
- 浏览器支持展示“正在核对新增上下文”、持久草稿恢复、superseded 草稿保留与最终稿不重复；浏览器 E2E 新增 `context-reconciliation-visible`。

验证：

- `npm test` **191/191**，包含 13 项上下文对账测试（接受决策/点名触发、避免自激、增量上限、断号拒绝、上下文推进 fencing、旧写拒绝、真实 Worker 对账轮次、工作区成果保留、预算耗尽、零额外轮次策略等）。日志：`.state/context-tests-final.log`。
- 浏览器 E2E PASS，证据 `.state/browser-e2e/run-Ur4eKx/report.json`；生产冒烟 PASS（`.state/production-smoke/run-5ikIT9/report.json`）；SDK 离线消费 PASS（`.state/sdk-probes/run-lky2a9/report.json`）；原生沙箱旧 generation 拒写探测 PASS（`.state/context-sandbox-native.log`，`oldPipeRejected=true`、无新事件、Job 已清空）。
- v2/v3/v4 只读副本迁移审计：`.state/context-audit/latest.json`。全程未调用模型。
- 仓库基线已纳入 Git：`git init -b main` 后首个提交 `ced6da3`，包含本批之前的全部实现；后续小改动继续提交。

范围边界：这是“提交前增量对账 + 水位 fencing”，不是分布式共识，也不能撤销旧进程已经产生的外部副作用；有副作用的原生命令仍不盲目自动重跑。P1 的 EWMA 窗口与公平调度尚未实现（quorum/absent/late 已在第六批补上）。

## 增量：审计导出与 UI 体验

- 新增 owner-only `GET /api/rooms/:id/audit/export`：按事件原样输出 NDJSON（事件 id、seq、type、actor、payload 等），并设置 `application/x-ndjson` 与附件下载名；房间头部新增「导出审计日志」按钮。测试覆盖 owner 下载、未认证 401、NDJSON 可解析与事件字段；自动测试 202/202。
- UI 体验：运行用量改为紧凑的两行（用量未返回时不再重复三个“未知”），任务卡操作下拉改为紧凑样式并补 aria-label，房间头部显示“N 进行中”，owner 页脚提高对比度；新增“当前房间 id 写入 URL 查询参数 + 浏览器标签标题显示房间名”的持久化，刷新后保持所选房间。浏览器 E2E 新增 `room-url-and-title-persistence`、`usage-tab` 与 `run-detail-modal` 步骤，全量 38/38 通过。
- 新增右侧「用量」标签：按房间汇总输入/输出 Token、费用估值、已上报/未知运行数，并按 Agent 列出用量；未知提供方不会被当作 0。该面板不强制预算，只提供可解释的成本可见性。
- 新增「运行详情」弹窗：从进行中运行、错误卡片或用量历史打开，展示时间、任务/版本、上下文水位、提示词、错误原文、限额/预算与 Room 工具操作记录；支持停止和显式重试。
- 仓库与 CI：`git init -b main` 首个提交 `ced6da3` 纳入全部基线；新增 `.github/workflows/ci.yml`（typecheck、密钥扫描、单元测试、replay 契约、production build，Windows runner）；本地未实际触发 GitHub Actions。

## 增量：运行级 Token / 费用硬预算

- `executionSettingsSchema` 新增 `tokenBudget` 与 `costBudgetUsd`（0=不限），入队时冻结到 `Run.limits`；修改全局设置不影响既有运行。
- Worker 在每次 usage 上报后按 `usageByGeneration` 汇总已上报 Token/费用，超过冻结预算即以 `BudgetExceeded` 失败结束并保留错误原文；未知用量既不会误触发也不会被当作满足预算。预算检查不依赖 SQLite 回滚，原生进程由现有取消/生成器清理路径处理。
- 运行设置对话框新增两个上限字段；任务卡与用量面板显示预算；未知提供方仍显示未知。
- 测试：新增 3 项 `budgetError` 单元测试和 1 项真实 Worker 集成测试（报告超预算后运行 failed、聊天消息不发布）；`npm test` **198/198** 通过，浏览器 E2E 37/37 通过并验证设置对话框存在预算字段。

## 增量：显式失败重试入口

- 新增 owner 命令 `run.retry`：只允许对 failed/canceled/interrupted/unknown 运行重试；外部会话运行拒绝，任务版本必须未变且任务处于 failed/queued/canceled/interrupted/unknown，成员没有其他活动运行；重试创建新运行并保留原运行，明确不会撤销未知外部副作用。
- 聊天运行按原 prompt 与当前房间水位重新入队；失败任务会被重新置为 queued 并复用同一 task version。
- 运行错误卡片新增「重试」按钮，带副作用提示文案；命令失败会通过现有 toast 展示。
- 测试：`tests/run-retry.test.ts` 覆盖聊天重试、活动运行拒绝、任务失败重试与同版本复用；`npm test` **198/198**。

## 增量：讨论 quorum / absent / late

- `discussion.start` 新增可选 `quorum`（默认等于参与者数）；拒绝 quorum 超过参与人数、或 maxResponses 小于 quorum 的不可达配置。
- 每轮成功响应达到 quorum 即推进下一轮：未完成成员记入 `Discussion.absent` 并以 `superseded` 取消，避免慢成员阻塞本轮；若所有运行终止仍未达 quorum 则停止讨论。默认 quorum 为全员，保留原语义。
- 讨论横幅显示 Quorum 与缺席成员；创建讨论表单增加 quorum 字段（0=全部）。
- 测试：`tests/discussion-quorum.test.ts` 覆盖提前推进、缺席记录、迟到取消、quorum 不可达拒绝；`npm test` **204/204**。

## 增量：房间 / 成员待处理运行上限

- `executionSettingsSchema` 新增 `maxQueuedRunsPerAgent`（默认 5）与 `maxQueuedRunsPerRoom`（默认 20）；设置表单可调整。
- `enqueue` 在写入运行前统计房间与成员未终止运行数量；超限抛出 `agent_queue_full` / `room_queue_full`（429），整个命令事务回滚，不留下半创建的任务或运行。
- 聊天点名会先取消同成员旧聊天运行，因此上限主要约束任务与讨论等可累积运行；实际行为由测试覆盖。
- 测试：`tests/queue-limits.test.ts` 覆盖成员上限、房间上限与失败回滚；`npm test` **202/202**。

## 增量：EWMA 自适应超时

- `executionSettings.adaptiveTimeouts`（默认关闭）；开启后按 (agent, task/chat) 分桶，取最近 8 次已完成运行的实际耗时计算 EWMA（alpha=0.3），有效超时 = clamp(EWMA × 3, 30 秒, 配置超时)，只缩短、不延长。
- 入队时计算并冻结到 `Run.limits.timeoutMs`；设置改变不影响既有运行。
- 设置表单新增开关；未启用时行为与之前完全一致。
- 测试：`tests/adaptive-timeout.test.ts` 覆盖 EWMA、floor/cap、桶过滤与真实 service 入队冻结；`npm test` **204/204**。

## 原计划逐项剩余工作

P0 尚未完成：

1. 把可恢复副作用的操作记录扩展到适配器内部的命令执行，区分可证明幂等与结果未知的原生工作；Room 工具 fencing 与账本已完成，不能替代内部 Shell/网络副作用的验收。
2. 带 generation/租约的崩溃恢复与安全自动重入队。中断标记、generation 撤销与显式重入队事件已具备；必须先解决外部命令副作用不受 SQLite 回滚保护的问题，当前仍不盲目重试状态不明的写运行。
3. 更多 seq 边界的随机故障注入与并发冲突门禁，并把完整故障与 UI 不变量纳入 CI；本地 CI 配置已添加（`.github/workflows/ci.yml`：typecheck、密钥扫描、204 项测试、replay 契约、构建），尚未在远端实际执行。

P1 尚未完成：

1. 单一公平仲裁器、房间并发闸门、WFQ/aging、链深与每轮配额。
2. quorum/absent/late 与分桶 EWMA 自适应超时已实现（第六/八批）；partial 超时降级、按轮公平性压测与单仲裁公平调度仍待实现。
3. 每 Agent/房间待处理运行上限已实现（`maxQueuedRunsPerAgent`/`maxQueuedRunsPerRoom`，入队前 429 原子失败）；工具输出上限、每 Agent 增量 inbox 与大规模上下文分段/引用仍待实现。
4. 时长上限已由 timeout 控制；单次运行 Token/费用硬预算与房间成本看板已实现（未知用量不按 0 计）。入口预算熔断（启动前按历史/房间预算拒绝）仍待实现。
5. 来源/信任级、工具前策略校验和注入测试，以及更完整的失败解释与重试入口；JSONL 审计导出与显式 `run.retry` 已实现（198 项测试覆盖），但信任级/注入防护与自动重试策略仍未实现。
6. 真实 CLI 的混合快慢场景验收仍须与无模型测试分开，不能用模拟结果替代。

P2 尚未完成：

1. EventStore/Transport 接口抽取，替换适配器而不改调度和投影的验证。
2. outbox、HLC、多机同步预留与房间分片。
3. 单房间事件导出至第二实例重放的互操作验收；AgentScope Service 适配器在原计划中为可选项。

已完成一致性底座、执行 fencing、状态机/partial/supersede、baseSeq 提交对账与上下文预算四段，尚未完成整个 P0 或全项目目标。下一批优先处理适配器内部副作用的操作账本与安全恢复策略，P1 的公平调度/预算/可观测性可并行推进。
