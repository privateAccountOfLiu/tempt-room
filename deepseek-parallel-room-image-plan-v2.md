# DeepSeek 后续实施 Plan：并行交付闭环、房间管理与 Agent 图片消息

版本：v2.0。编写日期：2026-10-21。实施负责人：DeepSeek。

本文件是下一批工作的唯一详细实施清单；原始架构目标继续参考 [架构 Plan](AGENT-PARALLEL-COLLABORATION-PLAN.md)，原 M1 的七项验收以 [下一位 Agent 实施计划 §2.7](NEXT-AGENT-IMPLEMENTATION-PLAN.md#27-最小任务场景与里程碑验收) 为准。本文件补充修复路径与新需求，不降低原验收标准。

本文交付的是实施计划。本轮没有修改产品代码、数据库、房间配置或启动真实模型实验。下文“新增”“修改”“执行”都是给后续实施者的工作项，不表示已经完成。

## 0. 如何使用这份计划

### 0.1 代码基线与行号规则

- 编写前实际读取的 HEAD：`e05a0cf6baab1ac412a11e07c45c207047c1e3e7`。
- 编写前 `git status --short` 无输出，工作树干净。
- 与上轮 `517af35` 相比，最新提交是未完成草稿分组的前端修改，不能直接沿用旧提交的测试成绩。
- 本文的 `文件:行号` 指该 SHA 下的定位锚点，不是未来代码的固定行号。
- 每张卡给出入口、符号、语句级顺序、错误分支、测试与关闭条件。实施时按符号查找；禁止因为行号移动而机械覆盖相邻代码。
- 代码块标为“流程骨架”的部分说明控制流，涉及的新类型、辅助函数须按对应任务先实现；不能声称整块复制即可编译。
- 不展开 import 排序、变量空格等机械操作；每一个会改变状态、权限、磁盘、网络、退出码或 UI 行为的语句都应落入任务卡与测试。

### 0.2 本轮重新核对的事实

1. `apps/server/src/worker.ts:258-314`：`processIntegrations()` 在全局 `active.size > 0` 时返回；staging 从当前产物的旧 manifest 加当前 changes 重建，未包含已经应用的其他产物；验收使用 `spawnSync` 阻塞事件循环。
2. `worker.ts:323-348`：`dispatchCandidates()` 在候选入列后递增房间计数，尚未真正派发就用掉容量，导致调度器看不到完整可选集合。
3. `worker.ts:387`、`:490-505`：host 项目任务锁住并直接进入源目录；sandbox 分支则在每次启动时重新 snapshot 当前源目录。现有 `project.bind` 保存摘要，尚未提供可重用的不可变文件内容基线。
4. `scripts/acceptance-parallel-tasks.ts:58,66-77,94`：恒真验收、顺序 `materialize()` 和最终文件读取，不能证明 Worker 并行执行，也覆盖不到 Worker 的组合验收缺陷。
5. `scripts/verify-collaboration-baseline.ts:83,132`：`statusHash` 仅绑定状态文本，`ok` 仅看命令失败数。当前没有 release 模式，也未接入 collaboration 发布门禁。
6. `packages/protocol/src/index.ts:88-90`、`service.ts:60-74`：已有 `room.create`、`room.update`、`room.members.set`；没有删除命令。
7. `apps/web/src/main.tsx:197`：房间设置先发送 `room.update`，再发送 `room.members.set`。第二次失败会留下只更新了一半的房间设置。
8. `app.ts:371-386`：已有 owner multipart 上传、附件下载和文本预览；Agent token 不能使用 owner 上传路由。图片尚无专门的安全内联路由。
9. `worker.ts:852-866,951-986`：托管和外部 `room_post` 都只接收 text/mentions；`artifact_publish` 只发布文本报告。
10. `scripts/room-bridge.mjs:16-29`、`host.ts:90`、`sandbox/RoomSandbox/RoomPipe.cs`：管道与连接器单帧约 1 MiB，不能直接塞入 10 MiB 图片的 base64。
11. **新增的可复现前置故障**：在 Node `v24.14.0` 下分别执行 `node --check scripts/room-agent-mcp.mjs` 与 `node --check plugins/tempt-room-claude/server/room-agent-mcp.mjs`，两者均在第 34 行报 `SyntaxError: Unexpected token '{'`。前一项 `room_wait` 后缺少逗号。
12. `store.ts:7,72-73,173-174,314`：数据库版本为 16；事件禁止删除/更新；房间列表包含全部记录；seed 在完全没有房间行时创建演示房间。删除设计必须兼容这些约束。

本轮只做上述源码核对与两条连接器语法检查，没有重跑全量测试。旧的 422/422、56/56 或旧 acceptance PASS 不能写成当前 SHA 的成绩。

### 0.3 最终应交付的用户行为

- 同一项目的两个独立任务真正重叠执行，各自在独立目录产出 patch；Worker 对实际组合后的项目验收，失败分支不会带走独立分支。
- 用户可一次保存房间名称、描述和成员；新增成员立即能被 @ 和分配新任务；并发编辑不会悄悄覆盖另一窗口的结果。
- 用户可删除房间；房间从常规入口消失，后续派工与写入被阻止，已有受托管执行被停止并核对清理结果。
- Agent 调用一个发图工具即可把自己可读取的本地 PNG/JPEG/WebP 发进房间；消息里看到缩略图，可放大或下载；重试不会产生重复图片消息。
- 模拟验收、真实 CLI 证据、源码发布门禁分别报告。未执行的验证显示 `not_run` / `not_verified`。

## 1. 先冻结的产品与实现选择

### 1.1 房间删除的精确定义

本批实现**持久逻辑删除**：保留房间 tombstone、历史事件、既有产物、费用与 journal，默认列表隐藏。它实现用户的“删除房间”，同时维持事件不可变与故障核对能力。

- 生命周期为 `active → deleting → deleted`。
- 接受删除命令后就阻止新消息、新任务、新上传、新唤醒与新集成；不等待清理完成才封入口。
- 运行或资源清理未确认时维持 `deleting`，显示具体 pending 原因；不能直接显示“进程已清理”。
- 此处不实现物理擦除、恢复房间、自动清除用户项目、自动删除 CLI 用户配置。后续若需要彻底擦除，单独定义数据保留与备份语义。
- 删除不会撤销已经发生的本机/远程副作用，不自动回滚已应用 patch。
- owner 可以经显式历史导出入口获取已删房间审计；Agent token 无权获得这项能力。

### 1.2 修改房间与新增成员

- 新 UI 使用一个新命令 `room.configure`，原子修改 name/description/members，携带 `expectedRevision`。
- 保留旧 `room.update` 与 `room.members.set`，复用同一校验/更新内核；不再维护两套业务语义。
- 不使用全局 `seq` 作为设置版本，因为聊天消息会持续推进 seq。新增独立的 `revision`。
- 增加成员只改变后续可见成员与派工资格，不自动重跑历史任务、不自动加入进行中的 Discussion。
- 保留已有成员移除能力：本批对仍拥有活动 Run、排队任务、外部租约、活动讨论参与资格或未释放资源的成员返回 `member_busy`，用户先停止/交接，再移除。不得静默取消别人的任务。
- 新增一个全局 Agent 与把既有 Agent 加入房间是两个动作。房间设置提供“新增 Agent”入口复用 `AgentForm`，成功后再勾选，不另造 Agent 配置模型。

### 1.3 Agent 发图的范围

- 必须覆盖托管 host、托管 sandbox、外部 HTTP MCP、Claude 插件和 `RoomAgentClient`。
- 对附着的已有 Codex 线程，只在其实际已有连接器可调用时提供发图；不能冒充已给原线程注入 MCP。
- 首批支持静态 PNG、JPEG、WebP。SVG、GIF、动画 PNG/WebP、HTML、远程 URL 和 data URI 不属于本批输入。
- 默认单图 10 MiB；最长边 8192、像素总数最多 16,777,216；单消息最多 10 个附件，沿用现有上限。
- 图片是 `Artifact(kind='file')`；消息仍用 `attachments: artifactId[]` 关联。禁止在消息、事件、审计或模型上下文中嵌入 base64。
- 上传与发消息分为两个可重试阶段；对用户暴露 `room_send_image` 便利工具，底层使用三种分块上传操作和既有 `room_post`。
- 上传成功但发消息失败要返回 artifactId 与明确阶段；重试只补发消息。不得虚报“已发到房间”。
- 本批证明“Agent 发图 + 用户看图”。其他模型能否理解图片依赖其适配器；当前 API adapter 仅收到附件描述，不因此宣称新增视觉输入能力。

### 1.4 工程边界

- 继续用 SQLite、现有 Worker/RoomService/Store、事件注册表和权限体系，不引入第二个调度器或外部队列。
- 目录隔离与执行安全模式分开：host 也可在独立快照目录执行；这不会把 host 伪装成沙箱。
- 模拟适配器通过现有 `Worker.options.adapter` 注入。测试不得直接伪造 `run.started` 或绕过 Worker 发布结果。
- 新图片依赖仅放在服务端。连接器仍能通过 Node 内置模块运行，不能要求沙箱里安装图像解码 native addon。
- 实施开始先记录当前 SHA；若源码已移动，复核本文件锚点并更新差异，不覆盖其他成员改动。

## 2. 交付顺序与任务状态

按以下顺序提交小批次；这里的切片不替代原 M1 七项验收。

1. G00/G01：固化事实，修复外部 MCP 语法与可执行性门禁。
2. P01/P02：候选公平性、不可变共同基线与 host 独立目录。
3. P03/P04：按项目集成、异步验收、精确组合与应用前复核。
4. P05/P06：Worker 真并行屏障、七项验收与失败恢复。
5. R01/R02/R03：房间协议、原子设置、删除生命周期。
6. R04/R05：HTTP/WS/SDK 与前端房间管理。
7. I01/I02/I03：图片协议、上传状态与验证存储。
8. I04/I05：两个传输连接器与 SDK 的发图便利入口。
9. I06/I07：安全预览与消息内展示，跨功能竞态验收。
10. V01/V02/V03/V04：源码绑定报告、CI/preflight、真实实验与统一文档。

P01 中的 room active 校验、P02 中的 prepared binding 参数先按 R01 的公共 Room 类型冻结；可把 R01 的纯协议定义前置提交，生命周期业务仍按 R02–R05 交付。每个可合并提交都必须能 typecheck，不能先引用尚不存在的符号再把编译失败留给后续任务。

每张卡状态只能是 `not_started / in_progress / blocked / verified`；`verified` 必须附实现 SHA、命令、退出码、报告路径与未覆盖项。新建 `docs/DEEPSEEK-PARALLEL-ROOM-IMAGE-PROGRESS.md` 记录本批，不把本计划的 TODO 预先勾成完成。

## 3. G 批：基线和外部连接器先恢复可用

### G00 — 开工记录与测试隔离

修改：后续新增的进展文件；不改业务逻辑。

逐步执行：

1. 运行 `git rev-parse HEAD`、`git status --short`、`node --version`、`npm --version`、`git --version`。
2. 把输出写入 `.state/parallel-room-image/<run-id>/baseline.json`，凭据环境变量不进入报告。
3. 读取 `package.json`、已有迁移版本和正在发生的文件修改；保留用户已有改动。
4. 本批所有 fixture 都用 `mkdtemp` 独立数据库、目录和 loopback 端口；不连接日常 `.state/room.sqlite`。
5. 记录当前连接器语法失败为已复现缺陷，而不是隐藏它后声称基线全绿。
6. 后续单测按受影响范围执行；最终做一次当前提交的全量门禁。

关闭条件：证据能说明“本次从哪份代码开始”，不把历史群聊结论当作本次运行输出。

### G01 — 修复两份外部 MCP，并防止副本漂移

锚点：`scripts/room-agent-mcp.mjs:33-34`、`plugins/tempt-room-claude/server/room-agent-mcp.mjs:33-34`。

1. 在 `room_wait` 对象结束处补数组分隔逗号，只修语法，不改变工具语义。
2. 两份文件分别 `node --check`，保存各自退出码；不能只看一段 PowerShell 最后命令的退出码。
3. 新增 `tests/mcp-connector-contract.test.ts`：spawn 实际 `.mjs`，通过 stdin 发 `initialize`、`tools/list`、`ping`。
4. 断言 stdout 每行是合法 JSON-RPC；诊断只能写 stderr，不能污染协议流。
5. 测试未知工具、非法 JSON、超过帧上限、缺少 token 的明确失败。
6. 新增 `scripts/sync-room-agent-plugin.mjs`：以主连接器为唯一源码，把完整自包含结果同步到插件目录；提供 `--check` 比较字节摘要，差异时退出非零。
7. 不让插件入口 import 工作区外的 `../../../scripts/...`，因为插件安装后没有源码仓库的相对目录。
8. 本批新增 helpers 时同步程序一并复制，manifest 固定列出文件名，拒绝动态路径。
9. 加入 package scripts：`sync:room-plugin`、`check:room-plugin`、`test:mcp-connectors`。

定向验证：两份 `node --check` + 实际 stdio 握手 + 副本一致性检查。后续每次改工具 schema，都重跑这三个检查。

## 4. P 批：完成真正的并行交付

### P01 — 候选枚举不消耗容量，派发才计账

锚点：`worker.ts:214-219,323-379`，复用 `scheduler.ts`。

修改语句顺序：

1. `dispatchCandidates()` 先从真实活动 Run/未释放资源取得房间占用，不对候选自身计数。
2. 删除当前 `candidates.push(run)` 后的 `activeRoomCounts.set(...)`。
3. 对每个 queued Run 校验 room active、Agent enabled/member、讨论状态、线程锁、依赖和项目目录冲突。
4. 可用槽位为 1 时，同房间的 A/A/B 三个独立候选都可进入候选集；由 scheduler 选择一个。
5. `startRun()` 在任何资源预留前再次检查房间、Agent、任务版本、房间容量与线程归属。
6. 资源准入失败不允许 while 循环反复选中同一个 Run。为本轮 tick 维护 `attemptedRunIds`，失败后本 tick 跳过；下一 tick 可以重试。
7. 可恢复资源忙返回结构化 `not_started/resource_busy`，不把排队任务直接标 failed；永久无效任务才落失败事件。
8. 若第二项资源申请失败，只释放本次新取得的第一项资源，保留他人租约。
9. 真正取得全部资源、记录 `run.started` 并启动后，才调用 `recordServed()`；重放/候选扫描不更新公平计数。
10. `this.active` 先登记，再触发异步适配器，防止同一 tick 重复启动；失败走已有 finally 清理。

新增 `tests/worker-dispatch-fairness.test.ts`：

- 房间上限 1，持续 A/A/B，测试实际 adapter 进入顺序和 `maxBypassDispatches`，不只测 SWRR 类。
- 房间上限 2、全局 3，多房间混合；槽位不超限，B 不会因前面 A 排队而消失。
- 首选资源忙仍能派发另一个项目；tick 有界返回，不出现无限 while。
- start 前成员移除/房间 deleting 后不会调用 adapter；公平账本不把失败准入计作已服务。

### P02 — 真正冻结基线，host 项目也支持独立目录

锚点：`service.ts:106-115`、`project-manifest.ts`、`workspaces.ts:24-66`、`worker.ts:387-393,477-510`、`task-contract.ts`。

新增文件建议：`apps/server/src/project-files.ts`、`immutable-baselines.ts`。目标是共享扫描和基线内容，不是复制两套 snapshot。

**共享扫描器，按语句落地：**

1. 抽取 `scanProjectFiles(root, limits)`，返回规范化路径、字节数、SHA256、内容读取引用。
2. 合并现有排除规则，取更严格边界：不复制 `.git/.state/node_modules`、密钥目录、`.env*`、凭据文件与重解析链接。
3. 保留文件数/总字节限制；绑定阶段与执行阶段用同一算法和上限，不再用不同排除清单算“同一个” manifest。
4. 对 Windows 大小写冲突、保留设备名、ADS、尾随点/空格、越界路径明确报错。
5. 使用稳定的路径排序与 hash 格式；旧 hash 算法标记版本，禁止静默把旧字段重解释为新算法。
6. 扫描期间文件改变则重读比对并返回 `source_changed_during_snapshot`，不能把混合时刻的文件当不可变基线。

**绑定与落盘：**

7. `project.bind` 的 route 先异步准备快照临时目录，RoomService 的同步事务不跨 await。
8. 生成 `baselineId`、`manifestAlgorithm`、`manifestHash`；将每个已过滤文件写入受管基线目录，写 complete 标记。
9. 提交 `project.bound` 前重新确认房间 active 和请求身份；事件只引用受管 ID/hash，不保存任意客户端可指定的快照路径。
10. 事务失败留下的未引用快照由限时 GC 回收；已被 Run/产物引用的快照不得回收。
11. 老 project binding 没有内容快照时，只能在源内容与旧摘要一致时补建；不一致返回 `baseline_unavailable`，要求重新绑定，不能悄悄冻结新内容。

**工作区策略：**

12. `TaskContract` 增加可选 `workspaceMode: 'isolated'|'source'`；新并行 fixture 明确写 `isolated`。
13. 老任务缺少字段时保留旧行为；历史事件重放不能改变已有运行的 cwd。
14. 新建严格项目任务的 UI/命令明确选择 isolated，且冻结进 Task/Run；不能在 Run 启动后随 Agent 配置变化重选目录。
15. 新增 `Workspaces.snapshotFromBaseline(baselineId, runId)`：验证 complete/hash，复制到每 Run 目录，建立独立 Git 元数据，写该 Run 的 manifest。
16. sandbox 与 host-isolated 都使用该方法；源项目不作为工作目录。
17. host-isolated 的资源键使用独立 workspace canonical path，不拿真实 source 互斥锁；真正应用 patch 仍锁 source。
18. host-source 保留独占源目录锁。attached 线程 cwd 固定，若无法满足 isolated 明确 `workspace_mode_unsupported`，不得偷偷退回源目录。
19. `worker.execute()` 记录 `baselineId`、目录、manifest hash、原始 sourcePath 与执行模式；更改后用现有 `Workspaces.changes()` 产出 patch。
20. host-isolated 必须产出 patch，不再进入“本机直接变更清单”分支；host-source 沿用观察报告，不宣称可安全归因。
21. dependency artifact 若要叠入工作区，先校验冻结的任务版本/hash，记录输入组合摘要，再复制；不能让后继读上游还在变化的目录。

测试：同基线两个 host-isolated cwd 不同；A 改文件不影响 B/源目录；绑定后源目录被改不影响已冻结快照；敏感文件不进入快照；attached 不支持时保持明确阻塞；legacy host-source 仍串行。

### P03 — 按 canonical 项目互斥，集成验收异步执行

锚点：`worker.ts:258-314`、`resource-manager.ts`、`resource-lease.ts`。

新增 `apps/server/src/integration-runner.ts`，复用现有 integration 表与事件。

1. 删除全局 `if (this.active.size > 0) return`。
2. 队列按 createdAt 排序后，逐项尝试项目准入；第一项项目忙不能挡住其他项目。
3. 项目键取 realpath + Windows 规范化；不同 room/binding 指向同一 source 时仍互斥。
4. 每个项目同一时间只有一个 `validation/apply/rollback` 操作；host-source Run 也使用同一资源键。
5. host-isolated/sandbox Run 不占 source 写锁，可与该项目的受控集成并存；独立执行输入已冻结。
6. Worker 保留 `integrationControllers` / `inFlight`，启动后立即返回 tick，不能在 tick await 全部验收。
7. 把验收命令 `spawnSync` 改为 async `spawn`。设置 `windowsHide`、超时、输出字节上限和 AbortSignal。
8. 使用现有进程树/Job 清理机制，不能只 `child.kill()` 就宣称树已清空。
9. 验收进程纳入 CLI 进程硬顶；全局 Run 并发与 verifier 并发分别有界，不能因抽出模块绕过内存/进程限制。
10. 只接受冻结的 verifier argv/清单；Windows npm 通过已解析的 npm cli 用 Node 执行，避免把不可信参数拼进 shell。
11. command 字符串兼容路径按已有明确授权规则处理；新 fixture 一律用 argv。
12. 异步结束后在短事务里复核 integration 状态、room、任务版本与项目资源所有权，再记录结果。
13. finally 释放控制器与本操作租约；清理证据未知则 quarantine，不显示 released。
14. `Worker.close()` 停止并等待本 Worker 拥有的 verifier，使用有界等待并保留未清理原因。
15. `cleanupStaging()` 排除 in-flight、持久 validating/testing/applying 及未知 journal 引用的目录；异步验收不能被现有纯 mtime 清理器删掉工作目录。

新增测试：一个长期阻塞的无关项目 Run 存在时，另一个项目照常完成集成；两个不同项目 verifier 可在上限内重叠；同项目跨房间串行；验收期间 HTTP/WS/adapter 增量仍能处理。

### P04 — staging 必须等于“当前受认可目标 + 本次候选”

锚点：`worker.ts:270-283,303-313,801`、`workspaces.ts:84-110`、`integration.ts`。

**选定方案：**拿项目 source 锁后，对当前源目录生成受控快照，确认它是本 binding 的合法基线或已记录应用后的已知状态，再叠本次 changes。不能从本次产物自己的旧 manifest 单独装配 staging。

1. 取得项目锁，读取 binding、候选 artifact、changes 文件；校验房间/任务/Run/generation 归属。
2. 校验 artifact 与 changes 的实际字节摘要；不能只信任客户端回填的 `artifactHash`。
3. 计算当前目标文件 manifest，记录 `verifiedTargetManifestHash`；目标应等于共同基线或最近已完成 journal 认可的完整目标摘要。
4. 如果目标包含未登记的用户修改、未完成 apply journal 或不匹配的 binding，返回 `source_changed` / `recovery_required`，不把它们默默纳入批准内容。
5. 对旧 integration 缺少完整目标摘要，只有能从基线 + 有序已应用/回滚记录无歧义重建时才补证；否则阻塞并提示核对，不猜测。
6. 清空并新建当前 integration 自己的 staging。只操作已验证处于 `.state/staging/<integrationId>` 内的路径。
7. 把当前已认可目标的完整文件集装入 staging，包含之前应用的 A 产物及删除事实。
8. 对候选 changes 逐文件校验 before hash；不一致是 patch conflict，不能强行覆盖。
9. 应用 after/deletion 后生成 `stagedManifestHash`、候选摘要和 `appliedArtifactSetHash`。
10. 拒绝 patch 修改冻结验收器、契约文件或 allowedPaths 之外文件；不要让被验收 Agent 自己改测试后过关。
11. verifier 从 owner 控制的不可变副本执行，报告 argv、cwd、verifier 内容 hash/version、开始结束时间、exitCode、stdout/stderr hash 与环境。
12. `metadata` / 检查清单存在不等于实际执行；只有进程正常退出且所有冻结检查通过才可 ready_to_apply。
13. 等待人工授权时持久保存上述 hash，不能在等待期间永久占住项目锁。
14. 授权后重新取得锁，并重算完整 source manifest；与验证时不同则回到 queued 重新验证或返回 source_changed，禁止复用旧 PASS。
15. 正式 apply 仍通过已有原子预检 + journal + backup 机制；失败保留原 patch、staging 和诊断。
16. journal 写入 `targetBeforeHash` 与 `targetAfterHash`，完成后 integration 记录 `appliedTargetManifestHash`。
17. journal complete 与 SQLite applied 之间崩溃，用两份内容证据核对；未知不能自动补报 applied。
18. rollback 同样锁项目并检查完整目标，不能只按 bindingId 锁；回滚结果更新可认可目标摘要。
19. acceptance 通过但尚未 apply，严格任务与整体目标不能被标成“完整交付”。

`integrationSchema` 新增可选字段：`verifiedTargetManifestHash`、`stagedManifestHash`、`appliedTargetManifestHash`、`appliedArtifactSetHash`、`verifierManifestHash`。旧事件没有字段仍能重放；新路径要求字段齐全。

关键回归探针必须进入 `tests/parallel-task-integration.test.ts`：

- 基线 `a.txt=0,b.txt=0`；A 改 a=1，B 改 b=1；冻结 verifier 拒绝“两者同时为 1”。
- A 单独 staging 通过并应用；B 必须在包含 A 的目标上验收失败，b 仍为 0。
- 同时保留正常组合通过的案例，防止把集成一概禁止当成修复。
- 验证后、应用前篡改候选/目标/verifier；分别拒绝，不得 applied。
- source 在未被 patch 触及的文件发生变化也失效，避免只检查 touched paths 漏掉组合依赖。

### P05 — 双启动屏障和真实 Worker 派发

新增 `tests/helpers/controllable-adapter.ts`、`tests/parallel-task-execution.test.ts`，重写 `scripts/acceptance-parallel-tasks.ts` 的核心路径。

辅助装置的最小接口：

```ts
// 流程骨架：不是生产调度接口。
interface AdapterProbe {
  entered(runId: string): Promise<void>;
  waitForEntered(count: number, signal?: AbortSignal): Promise<void>;
  release(runId: string): void;
  fail(runId: string, error: Error): void;
  timeline: { runId: string; phase: string; atNs: string }[];
}
```

实现步骤：

1. helper 内使用 deferred Promise，不用 sleep 推测进入状态。
2. adapter 真被 Worker 调用时登记 `entered`，保留 `ctx.workspace`、Run 和 immutable baseline hash。
3. 两个不同成员的 task 通过正常 `task.create` / accept 流程入队；设置全局和房间并发至少 2。
4. 调用正常 `worker.tick()`，等待 helper 确认两个 adapter 均进入。
5. 两个进入前，不允许任何一个产出最终结果；屏障具备 timeout/abort，失败能退出测试。
6. 断言两个 Run 均处于活动执行区间；工作区不同、基线一致、源目录未变。
7. adapter 在各自 cwd 写受允许文件，通过正常输出结束，让 Worker 生成 patch、Run 终态和待验收任务。
8. owner/verifier 根据实际产物执行检查后记录 verification，不能填全是 `a` 的虚构 hash。
9. 走真实 integration queue，等待实际组合检查与 journal；最终对 UI 所见状态与事件对账。
10. `--check` 明确 `modelRequests:0`，没有任何真实 provider/账号探测；记录任务、工作区、时间线、产物和 verifier hash。
11. 删除顺序 `materialize()` 伪执行主路径；可保留为专门的底层 fixture，但名称必须说明不证明并行。
12. 清理阶段先 `worker.close()` 再关 DB，再删本 fixture 根目录；先验证绝对路径属于 test-data。

### P06 — 将原 M1 七项逐一变成可失败的用例

新增 `tests/parallel-task-dependencies.test.ts`，扩展 integration/recovery/resource 相关测试。

1. **重叠执行**：P05 屏障通过；把并发改为 1 时该场景必须失败，证明测试有检出力。
2. **共同基线与隔离**：A 修改后 B 的工作区和 source hash 保持原值；host-isolated 与 sandbox 分模式报告。
3. **整体组合**：P04 的正常组合与互斥组合均经 Worker verifier 路径；单任务 PASS 不替代整体 PASS。
4. **局部失败**：A 失败，独立 B 完成保留 artifact；A 的后继 C 阻塞，B 的后继 D 可推进。修复 A 后 B 的 Run/产物 ID 不变。
5. **幂等与 fence**：相同 commandId/operationId 不重复派工/应用；同 ID 不同内容 409；旧任务版本/generation、目标变更、未知 journal 均不能 completed/applied。
6. **冲突/清理/恢复**：故意同文件冲突保留双方 patch；剩余进程未知保留租约隔离；取消、暂停和重启不扩大原预算，不自动重跑副作用。
7. **真实实验与对照**：另行按 V03 记录两个固定版本 CLI 的可观察执行区间，并比较单 Agent、简单并行、完整协作。缺少真实实验时只可关闭模拟切片。

执行状态、验收状态、集成状态、整体目标状态必须分别断言。不要通过把 failed 改名为 blocked 让报表变绿；要验证阻塞范围和原因。

## 5. R 批：房间修改、新增成员与删除

### R01 — Room schema、事件和迁移先定义清楚

锚点：`protocol/src/index.ts:87-91,139`、`events.ts:16,35-36`、`store.ts:7,104-119`。

新增 `packages/protocol/src/room.ts`，集中导出 roomSchema、设置/删除 payload schema 和类型；避免 index.ts 的接口与 events.ts 的局部 Room schema继续漂移。

Room 新增字段的形状：

```ts
// 新字段在历史载荷中可缺省，业务读取用 normalizeRoom() 补齐。
type RoomStatus = 'active' | 'deleting' | 'deleted';
interface RoomLifecycleFields {
  revision?: number;                 // 新房间从 1 开始，设置/生命周期改变时递增
  status?: RoomStatus;               // 缺省表示 active
  deletion?: {
    requestedAt: string;
    requestedBy: string;
    commandId: string;
    deletedAt?: string;
    pendingReasons: string[];        // 结构化、限长、去重，不放令牌或原生 stdout
  };
}
```

新命令：

```ts
// 加到 payloadSchemas，均使用 strict()；id 沿用 idSchema。
'room.configure': {
  name: string; description: string; members: string[];
  expectedRevision: number;
}
'room.delete': { expectedRevision: number }
```

逐项改动：

1. `roomSchema` 兼容旧字段缺省；对新字段做 enum、整数、时间戳、长度校验。
2. `Room` 类型从同一 schema 推导或使用同源类型；不要同时手改三个不一致的定义。
3. `normalizeRoom()` 只用于返回/业务读取，缺省 revision=1、status=active；不能重写旧事件字节。
4. 新建房间显式写 revision=1/status=active，并去重 members。
5. 新注册 `room.configured`：payload `{room, addedMemberIds, removedMemberIds}`；单个事件承载一次完整设置更新。
6. 新注册 `room.deleting`、`room.deletion.updated`、`room.deleted`：payload `{room}`，同样用 room projector；不是审计字符串代替状态事件。
7. 旧 `room.updated`、`room.members.updated` 允许附带新 revision，保持旧载荷可重放。
8. `projectEvent()` 对新生命周期检查前后状态：禁止 deleted→active、禁止删除后接受配置、禁止 revision 倒退；`deletion.updated` 不得改变删除请求身份。
9. 同样扩展 MemoryProjectionSink 与 SqlProjectionSink 的一致行为；snapshotAt 旧水位仍显示当时的 active 房间。
10. 给旧命令添加可选 expectedRevision；新 UI 必填。旧客户端没传时保留其兼容写法，不宣传它具有 CAS 防覆盖保证。
11. `scripts/schema.ts` 导出 `room.schema.json`，重新生成 command、event、各新事件 schema 与 registry；不要手改生成 JSON。

**迁移安排：**由同一个实施者分配版本，建议 17=不可变基线/工作区语义，18=房间生命周期，19=图片上传操作表。若开工时版本已占用，顺延并记录。

12. `store.ts:104-119` 的 v11–v16 分支目前嵌在 `if(version<10)` 内；整理为独立有序迁移，保证从 v10/v11/v16 都能抵达新版本。此项属于新增迁移前必须解决的升级入口问题。
13. 不把新迁移继续嵌进旧版本条件内；每步事务成功后才推进 user_version。
14. 即使生命周期只存在 JSON body，也提升 writer 版本门槛，防止旧进程不知道 deleted 状态仍写入。
15. 不给 events 加 ON DELETE CASCADE，不移除 `events_no_delete/no_update`。

测试：空库升级、v10/v11/v16 fixture 升级、重复打开、升级失败回滚、较新版本拒绝打开；历史 room 事件逐字节不变；新旧房间回放/重建一致。

### R02 — 一个事务保存房间设置与成员

锚点：`service.ts:31-49,60-74`、`sessions.ts`、`agent-tokens.ts`。

建议新增 `apps/server/src/room-lifecycle.ts`，放纯校验/更新规划；持久提交仍留在 RoomService。

逐句控制流：

1. `execute()` 先查幂等 receipt，重复命令原样返回；同 ID 不同内容继续 409。
2. 读取 raw Room，校验 room 存在且 active；只有 human owner 可 configure/delete。
3. 解析输入并 trim name；空白名、超长描述、超过 30 成员都返回现有 validation_error。
4. 将 members 去重；逐一查全局 Agent 存在。disabled Agent 允许加入，但 UI 明确未启用且调度仍拒绝。
5. 比较 expectedRevision 与 normalizeRoom(room).revision；不匹配返回 `room_revision_conflict`，409，结果只附当前 revision/可刷新信息。
6. 计算 added/removed；查 removed 每人的活动 Run、queued Task、外部租约、活动 Discussion 与未释放资源。
7. removed 存在忙状态时整个命令失败，不先保存 name/description。
8. 对可移除的闲置逻辑会话发 `agent_session.ended`，相关 subscription 写 enabled=false；pending inbox/batch 通过已有终止事件过期。
9. 构造 `{...room,name,description,members,revision:old+1}`；除明确字段外不接收客户端伪造 seq/status/createdAt。
10. 完全无变化的提交返回当前 revision，不追加无意义事件；同 commandId 仍保存 receipt。
11. 追加一次 `room.configured`，包含 added/removed，保存 receipt，同一 Store.atomic 提交。
12. 不自动 enqueue 新成员、不自动修改现有 Discussion.participants、不重写冻结 RunContext。
13. 后续新 @ / 新 Task 正常使用新成员列表；旧成员历史消息仍按原 actor 显示，不丢产物。
14. 旧 room.update / members.set 先构造完整输入，再复用该规划与校验；旧事件格式兼容保留，不能绕过 busy/active 检查。
15. token 每次访问继续检查当前成员资格；不把“移出后再加入”描述为旧 token 永久吊销。若未来需要永久吊销，再增加独立 token epoch。

新增 `tests/room-configuration.test.ts`：

- 修改名称+描述+加成员成功；未知成员使全部变化回滚。
- 两窗口同 revision，第一成功，第二 409；聊天推进 seq 不引发假冲突。
- 成员重复自动去重；空成员房间仍可保存，owner 不需要伪装成 Agent member。
- 忙成员移除拒绝；闲置移除后旧 token 调用被拒，其他成员与其历史不受影响。
- 加成员不花模型额度；新 @ 才触发正常准入；进行中的 Discussion 不被自动扩容。
- 重建投影后名称、成员、revision 与 live 一致。

### R03 — 删除请求、停止执行与持久清理

锚点：`service.ts:31-49`、`Worker.constructor:82`、`worker.tick()`、`execution.ts`、资源和讨论服务。

先给 `Store.atomic()` 增加 after-commit 副作用队列：

1. 新增 `afterCommit(fn)`；事务内登记函数，嵌套 atomic 共用外层队列。
2. rollback 丢弃队列；commit 后先可见持久事件，再调用副作用。
3. after-commit 抛错不能把已提交命令伪装成回滚；记录可重试清理原因。
4. 删除引起的 AbortController.abort、待输入拒绝等通过该队列触发；不要在事务提交前杀进程。
5. 已有 `RoomService.cancel()` 所调用的 onCancel 改为同一机制，测试确认 rollback 不会取消仍合法的执行。

删除命令的短事务：

6. 校验 owner、幂等、revision、room 状态；已经 deleting/deleted 的新删除请求返回现有状态，不重复取消/重复计费。
7. 先追加 `room.deleting`，status=deleting/revision+1，记录请求身份与时间。
8. queued Run 用现有合法终态转移取消；running/waiting_input Run 请求取消，不凭空填 cleanupProof。
9. 对 externally claimed Task 使租约失效并递增 task generation，拒绝旧 complete/heartbeat；保留任务与产物。
10. 活动/暂停 Discussion 走 stop，禁止自动生成新的总结 Run；session ended、subscription disabled、pending wakes suppressed(reason=room_deleting)。
11. 未发送的 input batch 标 expired；正在等待的输入/工具审批在 commit 后被明确拒绝，不悬挂 Promise。
12. queued/ready_to_apply integration 写 blocked(errorCode=room_deleting)；不自动授权，不自动应用。
13. 正在 validating/testing 的 integration 请求 Abort；正在 applying 或未知 journal 必须核对实际磁盘事实，不能当作“已取消所以没有副作用”。
14. 正在外发的 delivery 请求停止后续尝试；已发出去的 payload 不声称收回。未开始 delivery 记录明确终止原因，禁止 restart 再发。
15. 使 pending 图片上传失效并释放预约容量；异步解码完成后也不得提交新 artifact/message。
16. 保存 receipt 后提交；post-commit 通知 Worker 清理。HTTP 不同步等待整棵进程树退出。

Worker 的持久 finalizer：

17. 每 tick 扫描 deleting 房间，包括进程重启后；不能只靠本次请求的内存 callback。
18. 检查本房间 active map、Run 终态、原生未知执行、资源租约、verification 子进程、apply journal 与待输入句柄。
19. 已无活动句柄且清理证明充分时，发 `room.deleted`，填 deletedAt，revision+1。
20. 仍有未知清理则发限频、去重的 `room.deletion.updated`，pendingReasons 使用 `process_cleanup_unknown` / `apply_journal_unresolved` 等稳定码。
21. 不能仅因为 lease_until 到期就把进程确认数写 0；沿用 quarantine 与人工核对证据规则。
22. 已删除房间允许必要的 run cleanup / usage settlement / resource reconciliation 事实继续落审计；这些内部事实不重新开放消息、任务、上传或集成。
23. 所有正常业务入口增加 `assertActiveRoom`，包含 service.enqueue、retry/recovery、dispatchPendingWakes、scanSubscriptions、自动讨论、tool post、artifact publish、staging/apply、owner upload 和 external room_wait。
24. 不通过在 Store.event 全面禁止 deleted 房间事件来实现封禁，否则会连清理/计费/回放都阻断。封禁放在业务写入口，内部清理白名单保持窄且不接受 Agent 伪造。
25. 最终消息发布与所有 await 后提交点再次查房间状态及身份；只在 adapter 入口查一次不够。
26. 不无差别递增正在运行 Run.generation：现有 projector 对 generation 有专门转移规则；房间封写 + 取消已有执行即可阻止迟到公开结果，清理仍沿用原 fence。

新增 `tests/room-deletion.test.ts` / `room-deletion-recovery.test.ts`：idle 删除、运行中删除、queued/租约/讨论终止、重复命令、无权限、旧输出迟到、restart finalizer、未知 journal、清理失败、预算结算分别覆盖。

### R04 — API、WebSocket、SDK 与列表语义

锚点：`app.ts:77-105,213,262,371,388-405`、`store.ts:173-174,233,314`、`packages/client/src/index.ts`。

1. `Store.room()` / `Store.rooms()` 保留内部 raw 语义；新增 `activeRooms()` 和 `requireActiveRoom()`，避免历史审计/迁移误丢 tombstone。
2. `/api/rooms` 返回 activeRooms；deleting/deleted 默认不在侧栏列表。
3. 普通 snapshot/read：active 正常返回；deleting 返回最小生命周期信息供已有 UI 显示清理中；deleted 返回 `410 room_deleted`。
4. 普通 events/subscription 对已删除房间返回 410；owner 历史 audit/export 用显式 `includeDeleted=1` 允许读取，仍走 owner 鉴权。
5. `/api/agent/tool` 对 inactive 房间先拒绝正常调用；已有 room_wait 收到删除时立即以 room_deleted/room_deleting 结束，不能再等满 25 秒。
6. 正在订阅的 WS 先发送持久 room.deleting/room.deleted 事件，再关闭或停止常规订阅；不能靠临时通知替代终态事件。
7. 新 WS 握手遇 inactive room 拒绝；客户端把 410/删除事件识别为终态，不进入无限重连。
8. REST 缺口补拉遇 410 也转到房间消失处理；网络抖动仍保留原有重连能力。
9. `RoomClient` 增加 `configureRoom(roomId,input,commandId?)` / `deleteRoom(roomId,revision,commandId?)`，底层继续 `/api/commands`。
10. 不额外增加一套无幂等的 PATCH/DELETE route。命令发现列表应包含新命令，Agent 能力列表仍不包含管理命令。
11. artifact 下载/图片路由查所属 Room：正常入口不能用已知 artifactId 绕过删除；历史导出路径由 owner 显式选择。
12. seed 检查所有 raw room 行：用户删掉最后一个房间后重启，不能自动长出新演示房间；全新数据库仍初始化一次。
13. room-import 丢弃外部删除元数据/运行授权，创建新 ID 的 active Room revision=1；本地历史导入旧 tombstone 不得让它覆盖现有房间。
14. 导出包含 lifecycle、revision 和图片引用；导入对映射后的附件 ID 与内容 hash 一致校验。

测试：REST 状态码、WS 双窗口、410 停止重连、最后房间删除后重启、删除房间中的 artifact URL、owner 历史导出、导入新 active 身份。

### R05 — 房间设置和删除 UI

锚点：`apps/web/src/main.tsx:63-98,170,197,357-369`，样式在现有 style/workbench.css。

1. `RoomForm` 保存初始 revision；打开/切房间时按 room.id 重置 form，不能把上一房间成员勾选带入下一房间。
2. 保存按钮发送一个 `room.configure`，替换第 197 行两个顺序命令。
3. 使用 snapshot.room.members 控制成员勾选；显示已选人数、provider、启用状态与连接模式。
4. 增加“新增 Agent”入口复用现有 AgentForm；保存后刷新 allAgents，将新 ID 加进待保存 members，再由用户保存房间。
5. revision_conflict 保留未保存表单，显示“房间已被其他窗口修改”，提供刷新数据；不自动覆写或静默重试。
6. member_busy 保留表单并显示忙成员与下一步停止/交接入口；不先关闭 Modal。
7. 设置底部增加删除操作，弹出明确的确认 Modal，显示房间名称和受影响活动数量；一次明确确认提交 stable commandId。
8. 文案说明“从房间列表移除，停止后续活动，历史保留用于审计”；不承诺已擦除文件。
9. 删除响应/事件后先注销当前订阅、增加现有 generation.current，再清 snapshot/streaming/composerDrafts/reply/mentions/attachments/right-panel 状态。
10. 从最新 activeRooms 选择下一房间，更新 URL，禁止旧房间异步请求把页面切回去。
11. 没有剩余房间时展示空状态与“创建房间”，不继续渲染旧消息或转圈。
12. 两窗口同时开同一房间，未发删除的窗口也根据事件离开；网络补拉得到 410 同样处理。
13. 删除后在全局提示里保留 deleting 状态与查看清理详情入口；未知清理不能显示绿色“全部完成”。
14. 提交期间禁用重复按钮，失败恢复按钮；键盘焦点、Escape、aria-label 沿用现有 Modal 规范。

浏览器验收：改名、加既有成员、创建新 Agent 后加入、冲突保存、取消删除、确认删除、最后房间空状态、两个窗口同步、手机布局。

## 6. I 批：Agent 发图片的完整链路

### I01 — 冻结协议、工具参数与统一权限

锚点：`protocol/src/index.ts:42,91,134,140,144`、`models.ts:12,17`、`worker.ts:834,904`。

在 `packages/protocol/src/images.ts` 定义常量、upload 参数 schema、图片元数据与结果类型；导出到 index.ts。参数必须 strict，不接收客户端指定 actor/room/pathToWrite。

**Agent 看到的便利工具：**

```ts
interface RoomSendImageArgs {
  path: string;              // 只由 Agent 进程中的连接器读取，服务端不接收这个路径
  text?: string;             // 可省略，纯图片也能发消息
  alt?: string;              // 最多 1000 字符；不是可执行指令
  mentions?: string[];
  replyTo?: string;
  operationId: string;       // 同一张图片/同一次发言重试必须复用
}
interface RoomSendImageResult {
  artifactId: string;
  messageId?: string;
  stage: 'uploaded' | 'posted';
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number; height: number;
}
```

**服务端低层操作：**

```ts
image_upload_begin({name, size, sha256, mediaType?, alt?})
  -> {uploadId, chunkBytes, completedParts, artifactId?, expiresAt}
image_upload_chunk({uploadId, index, dataBase64, sha256})
  -> {uploadId, index, acceptedBytes, duplicate}
image_upload_complete({uploadId})
  -> {artifactId, name, mediaType, size, contentHash, image}
room_post({text?, mentions?, replyTo?, attachments?})
  -> existing message receipt
```

1. `chunkBytes = 192 * 1024`，base64 上限 `262144` 字符；完整 JSON-RPC/pipe frame 必须明显小于 1 MiB。
2. begin 只接受 size=1..10 MiB、SHA256 64 hex、安全 display name；媒体类型是提示，服务端重新识别。
3. index 最大为 ceil(size/chunkBytes)-1；除最后块外长度必须等于 chunkBytes。
4. complete 不接收新的文件名、roomId、actor 或客户端声称的 width/height。
5. root operationId 与阶段 ID 分开：用稳定 SHA 派生 `begin`、`part:index`、`complete`、`post` 四类 commandId/operationId，均满足 idSchema 的 128 字符上限。
6. 同 root ID 换文件/换 caption/mentions 视为不同参数冲突，返回 409；用户确实要重新发图时用新 root ID。
7. 便利工具可以不在服务端 HTTP enum 中接收：它由连接器本地编排。服务端 enum 必须含三个低层操作；权限列表包含统一的 `room_send_image` 能力。
8. 所有低层操作映射到同一 image-write 权限，不能因为工具名没出现在 writeTools 就按只读放行。
9. 真正发消息同时要求 `room_post` 权限；有上传能力但无发言能力者最多创建 artifact，不得自动发布消息。
10. `roomToolNames`、`agentToolNameSchema`、`assertRoomToolAllowed`、`authorizeTool.writeTools`、UI labels、能力探针使用同一映射清单；消除名字漏列。
11. read-only/deny Agent 一律不能上传或发图。显式 allowedRoomTools 老列表保持原权限；未配置列表按现有默认规则处理，UI 提供明确开启发图项。
12. 每个低层请求仍受调用数、限速、字节预约和 run 预算约束，不能因它是“内部子请求”绕过限额；begin 可以提前检查剩余调用数能否容纳本文件。
13. `ToolAuthorization.argumentDigest`、`ToolOperations.hash` 只记录 hash，不存/日志打印 dataBase64；通用 path 检查不递归误把 base64 的 `/` 当路径。
14. 新增专用 image 参数校验；不能靠禁用全局工具前授权来让上传通过。

Artifact 新增可选元数据：

```ts
contentHash?: string;
image?: {
  verified: true;
  width: number; height: number;
  alt?: string;
  previewMediaType: 'image/png';
  previewHash: string;
  previewSize: number;
};
```

15. `kind` 继续为 file，不新增一个绕过既有查询的 image 表。
16. message 附件仍是 ID 数组；Artifact 元数据可存 alt，之后要支持同图不同说明再增消息级描述，不在本批引入第二套富文本树。
17. `message.send` / `room_post` text 默认空字符串；superRefine 要求非空 text 或至少一个附件。两个全空失败。
18. 发送时再验证每个 artifact 同房间、文件存在、图片验真状态与当前权限；新图片上传者写入 provenance，可由同房间其他已授权成员引用，不能跨房间。
19. mentions/replyTo 保留现有成员与引用范围校验；旧 text-only room_post 完全兼容。
20. schema 生成器输出 image metadata、上传参数及 agent-tool-call schema；添加新事件无需另造 image message kind，继续 artifact.created + chat.message.created。

讨论运行中的图片按普通消息附件处理，原有 `artifact_publish` 的讨论总结管理限制继续生效；不能为发图放开所有讨论报告副作用，也不能让图片误走仅允许总结人发布文本报告的分支。纯图片 @ 消息使用附件上下文构造输入，不靠伪造占位正文绕过空内容校验。

### I02 — 有界、可恢复的上传临时状态

新增 `apps/server/src/image-uploads.ts`，必要时拆 `image-upload-store.ts`；DB migration 建 operational 表，不把未完成二进制块做成事件。

建议表结构如下；这是上传暂存状态，不属于可回放的业务投影：

```sql
CREATE TABLE image_uploads (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  operation_key TEXT NOT NULL UNIQUE,
  metadata_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  body TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX image_uploads_expiry ON image_uploads(state, expires_at);
CREATE TABLE image_upload_parts (
  upload_id TEXT NOT NULL REFERENCES image_uploads(id),
  part_index INTEGER NOT NULL,
  byte_length INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY(upload_id, part_index)
);
```

`body` 只存 name/size/content hash、actor、绑定 run/task/fence、预期块数、结果 artifactId、配额状态与时间；不存 base64、绝对源文件路径或令牌。

begin 的语句顺序：

1. 解析输入，验证 Agent enabled、当前房间 active/member、上传权限，以及托管通道的不可变 fence。
2. 用服务端身份构造 operation_key；external 绑定 room+agent+root，managed 加 run/operation scope。不能由客户端换 agentId。
3. 查已有 begin：metadata_hash 相同则返回原 upload/result；不同则 409。
4. 同事务计算并预约 pending 字节/数量，默认每 Agent 2 个、每房间 4 个 pending；全局 pending 字节也设置硬顶。
5. TTL 默认 30 分钟；客户端不能无限延长，也不能上传空文件占 ID。
6. 分配不包含用户路径的 uploadId，创建 `.state/uploads/<uploadId>/parts/`，保存记录；未引用目录失败时可 GC。

chunk 的语句顺序：

7. 再次查 upload 的 room/agent/run/fence/state/TTL；ID 知识本身不能授予使用权。
8. 严格验证 canonical base64，拒绝非法字符/填充/隐含空白，不能只依赖宽松 Buffer.from。
9. 在解码前检查编码长度，解码后检查实际字节数、index、块 SHA256；还要检查总量不超过 declared size。
10. 相同 index+hash+长度重复返回原结果，不重复计数；同 index 不同内容 409。
11. 使用 `parts/<index>.tmp-<nonce>` 写入、flush、rename 为服务端生成的最终 part 文件；不直接 append 到一个文件，避免 crash 后重复追加。
12. 再提交 part 元数据；若文件已落地但 DB 未记账，重试验证现有文件 hash 后补记；若 DB 有记录但文件缺失，返回 chunk_missing，不能假成功。
13. 每 upload 有并发互斥；跨请求重复不能出现“先检查都没块，再各自覆盖”的竞态。

过期/恢复的语句顺序：

14. complete/abort/expire 只释放一次预约字节，state 转换有条件更新，不能并发减成负数。
15. 定期清理过期 pending 的临时文件；deleted room 立即禁止其继续，GC 自己的受管目录，不碰 Agent 原图。
16. 重启核对 records/parts；缺块允许同身份补传；managed Run 重启 fence 已变则旧 upload 失效，external 需重新通过当前 token/member 校验。
17. 已完成上传的 result/receipt 不能跟临时 parts 一起过早删除，保证客户端丢回复后可恢复 artifactId。
18. operational 表不是投影重建的一部分；重放 artifact/message 不依赖 pending 上传仍存在。
19. GC 排除 complete 正在处理的目录，用租约/锁而不是纯 mtime；所有 recursive 删除先校验 canonical 目标在 uploads 根内且不是链接。

测试：块顺序/缺失、越界、重复、并发同块、摘要冲突、文件/DB 之间 crash、过期、租约变化、跨 Agent/跨 room、配额释放一次、GC 不删原图。

### I03 — 实际解码验真、原图与安全预览落盘

新增 `apps/server/src/image-validation.ts`、`artifact-files.ts`；原图仍使用 `.state/artifacts/<artifactId>`，预览使用受管 `<artifactId>.preview.png`。

本批选用服务端 `sharp` 做真实解码。可从 `sharp@0.35.5` 的精确锁定开始，在实施环境执行安装、Windows x64/Node 24 smoke 与依赖审计后确认；不能只改 package.json 不提交 lockfile。[该版本发布记录](https://sharp.pixelplumbing.com/changelog/v0.35.5/) 与 [官方安装说明](https://sharp.pixelplumbing.com/install/) 是依赖选择依据，不能替代本项目构建验证。

完整控制流：

1. 先取得 upload completion 互斥，核对所有块数/长度；stream 合并到服务端临时文件，同时算完整 SHA256。
2. 不把所有块和所有图片同时堆进内存；最多并发 2 个解码任务，等候队列也有上限。
3. 完整大小/hash 不符返回 image_hash_mismatch，不创建 artifact。
4. 先用签名字节排除非 PNG/JPEG/WebP，拒绝 SVG/XML/HTML 和伪装扩展名；display name 后缀不作为可信格式依据。
5. PNG 检查标准 chunk 结构并拒绝 acTL；WebP 拒绝动画标志/ANIM/ANMF；JPEG 走解码器格式验证。不要只靠 metadata.pages 判断 APNG。
6. `sharp(input, {failOn:'warning',limitInputPixels:16777216})`；不设置 unlimited，不允许未批准格式自动转换后入库。[构造参数文档](https://sharp.pixelplumbing.com/api-constructor/) 说明了这些限制选项。
7. 读取 metadata，要求 format 与签名识别一致、width/height 是正整数且最长边不超过 8192，pages 不超过 1。
8. metadata 只检查头，必须继续完整解码/输出；仅 metadata 成功不能通过验真。[官方 metadata 说明](https://sharp.pixelplumbing.com/api-input/) 明确它不解码压缩像素。
9. 生成最长边不超过 1920 的静态 PNG 预览，保留比例、不放大；应用方向信息，不复制原 EXIF/XMP；预览尺寸/字节也有上限。
10. 记录原图 contentHash 与安全预览 hash/size，所有结果由服务端计算。
11. 重查 room active/member、权限、fence/task version 与 upload state，避免 await 期间删除房间、移除成员或取消 Run 后仍提交。
12. 准备原图/预览临时文件并 flush；artifactId 由该 upload 稳定分配。已有同 ID 文件必须核对 hash 后复用，绝不覆盖不同内容。
13. 使用 `artifact-files.ts` 安装已准备文件；失败不发 artifact.created，不假报 uploaded。
14. 在短 Store.atomic 内记录 artifact.created、upload complete、stable receipt；事件包含 hash/provenance/图片元数据，不包含原图路径与二进制。
15. 文件安装后 SQL 提交前崩溃，留下可核对孤儿；同 upload 重试复用同 artifactId/hash，不重复发布事件。
16. SQL 成功但客户端丢回复，通过 completion receipt 返回原 artifact；临时块删除失败不影响已完成结果，交给 GC。
17. 原图/预览删除必须按引用和状态处理；不能为了清理 pending 上传而删已被 message 引用的 artifact。

**与现有同步操作框架衔接，必须单独处理：**

18. `ToolOperations.execute()` 当前只允许同步 action，遇 Promise 会抛错。图片 complete 的合并/解码必须先在事务外 await，不能把 async action 直接塞进现有 execute。
19. 可选最小实现：先安全准备不可见文件，最后交给现有 `operations.execute(fence,...,syncCommit)` 做二次 fence/上下文校验和原子元数据提交；如果已有 completed receipt，优先返回，避免重复解码。
20. 准备阶段只做受管临时文件/可重做验证；正式可见副作用仅在 syncCommit。若安装步骤存在未知结果，沿用 operation.unknown 核对，不把所有错误自动重试。
21. external 路径同样分 prepare/commit，共用 ImageUploadService；不能在 SQL 事务打开期间 await sharp 或等待网络。
22. 最终 `room_post` 继续走既有 service.execute 与稳定 post ID；若 context_outdated，返回 uploaded 阶段，要求对账后补发，不能绕过 baseSeq/fence。

验证：三种真实静态格式、损坏/截断/伪 MIME、APNG/动画 WebP、超字节/超像素、decode 过程中删除、磁盘满、SQL rollback、相同 ID 不同字节、纯图片与文本+图片消息。

### I04 — 托管 bridge、host 和 AppContainer 传输

锚点：`scripts/room-bridge.mjs`、`worker.ts:834-875`、`adapters.ts:267-315`、`toolchain.ts:50-68`、`sandbox/RoomSandbox/RoomPipe.cs`。

新增无第三方依赖的 `scripts/room-image-transfer.mjs`，由 bridge 和外部 MCP 共用；plugin 同步任务把它复制进包，toolchain 把它复制进沙箱 runtime。

1. bridge 的 tools/list 增加 room_send_image schema，room_post schema 增加 attachments/replyTo/可选 text；低层 upload 操作可隐藏在便利编排之后。
2. `tools/call room_send_image` 不把 path 发给 Room 服务器；在连接器当前权限域读取文件。
3. path 限制为本地普通文件，不接收 URL/data URI/UNC/device 路径/ADS，不跟随 symlink/junction；检查每级路径与 canonical 根边界。
4. 托管 roots 由 adapter 注入当前 workspace 和允许的附件/产物目录；不要给 bridge 一个可任意读取宿主所有目录的 broker 接口。
5. open 后用句柄 fstat 核实常规文件与大小，读取期间校验稳定性；校验同一文件内容并计算 hash，文件变化就停止，不上传混合版本。
6. 分块 helper 按 begin→chunks→complete→room_post 执行，每次 RPC 独立帧；一个 10 MiB 图约需 54 块，而不是一条大 JSON。
7. root operationId 派生每个子请求 ID；重试同块使用相同 ID，重启后仍能通过显式 root 恢复。
8. pipeline 逐块等待确认，默认单图串行块，避免同时几十个管道连接撑爆队列；响应只带小元数据。
9. `executeTool()` 新增三个低层分支，先执行现有 active/fence/policy/tool budget，再进入公共 ImageUploadService；最终 commit 仍再校验。
10. host 与 sandbox 执行身份由现有通道绑定；客户端 upload 参数绝不接受 runId/generation 覆盖服务器绑定。
11. `HostRoomPipe`、C# RoomPipe 与 bridge 保留 1 MiB 上限。仅调整明确的上传超时/分块请求方式，不把帧上限改成几十 MiB。
12. 编排总时长受 Run 剩余时间约束；每次块请求有既有 bounded timeout，取消后停止读取/发送并使剩余 upload 失效。
13. helper/协议常量内容加入 `stageToolchain()` 的 fingerprint 和复制清单；仅改 bridge hash 不够，防止继续运行旧 helper。
14. `adapters.ts` 的 runtime 文件路径/环境变量同时覆盖 Claude/Codex/DeepSeek 托管入口；不写回其全局用户配置。
15. `toolchain.ts` 的检查测试确认运行时包含 helper；C# 代码如无需改业务逻辑，不做额外改写，但必须跑真实 pipe chunk smoke。
16. MCP 成功结果只返回 artifact/message ID 和阶段；错误返回 isError 与稳定 code，不把 base64 或本地源路径打印 stdout。

新增 `tests/managed-image-tools.test.ts`：直接经过 executeTool 的身份拒绝与成功流程；新增 `scripts/smoke-agent-images.ts --mode host|sandbox` 使用固定图片，不请求模型，验证真实管道分块与 Worker 事件链。

### I05 — 外部 MCP、Claude 插件与浏览器可用 SDK

锚点：`scripts/room-agent-mcp.mjs`、插件副本、`app.ts:213-227`、`RoomAgentClient`。

1. 外部连接器 tools/list 提供相同 room_send_image / room_post 参数；先完成 G01，不能在语法不通的入口上追加新工具。
2. 外部 helper 在 Agent 自己的 cwd 或显式 ROOM_IMAGE_ROOTS 中读文件；该环境变量由本机用户配置，不接受房间消息临时指令扩展。
3. 调 `/api/agent/tool` 仍只用该 Agent 的 scoped token；不要把 owner session/cookie 提供给连接器。
4. 新工具允许显式稳定 operationId；老工具保留原调用兼容。根 ID 不再仅由随机 connectorId+request.id 生成，否则跨进程重试会重复发图。
5. HTTP 端只接收低层小块参数，不新增接受任意本地 path 的上传端点。
6. `worker.agentTool()` 与 managed executeTool 使用同一个 ImageUploadService；agentTool 每次查 enabled/member/active 及 allowlist。
7. 授权异步等待完成后再次查当前权限，不能审批前合法、移出后继续上传。
8. 更新 plugin 同步脚本，复制 helper 并执行 `--check`；分别运行主连接器与真正插件目录的 initialize/tools/list/call。
9. 补外部连接器 request timeout、上传中断和可恢复错误；401/403/410 不自动无限重试。

SDK 新增 `packages/client/src/image-upload.ts`：

```ts
// 仅给出公开接口，实际低层请求仍使用 prepare/send 的稳定 commandId。
uploadImage(bytes: Uint8Array, options: {
  name: string; operationId: string; alt?: string; signal?: AbortSignal;
}): Promise<UploadedImage>;
sendImage(bytes: Uint8Array, options: {
  name: string; operationId: string; text?: string; alt?: string;
  mentions?: string[]; replyTo?: string; signal?: AbortSignal;
}): Promise<RoomSendImageResult>;
```

10. SDK 不引入 `node:fs/path`，浏览器可以传 File.arrayBuffer 得到的字节；不把 raw filesystem path 暴露给浏览器 API。
11. 通过 Web Crypto 计算 hash；分块 base64 编码不使用对大数组 `String.fromCharCode(...bytes)` 的方式，避免参数栈溢出。
12. 中断时保留 root operationId 和已上传阶段；错误对象附 stage/artifactId/commandId，方便精确重试。
13. 单独发图不误用 owner RoomClient 的 request JSON headers 发送 FormData；上传本批统一走小块 JSON。
14. build:sdk 的 d.ts 导出 image 类型；`packages/client/README.md` 加最小 bytes 示例，连接器文档加本地 path 示例。
15. 对 reader-only/explicit allowlist/token wrong room 全部测试，确认前端能看图不意味着外部 token 可任意下载房间附件。

新增 `tests/external-image-tools.test.ts` / `tests/sdk-image-upload.test.ts`：真实 stdio→HTTP→Worker 上传并发消息；模拟网络丢回复后同 ID 重试，最终只有一个 artifact.created 和一个 chat.message.created。

### I06 — 安全内联路由与图片消息展示

锚点：`app.ts:43-57,379-386`、`main.tsx:128,175`、`markdown.tsx`。

服务端新增 `GET /api/artifacts/:id/image`：

1. 保留 owner session/owner bearer 鉴权；不开放匿名、不把 token 放在 URL query。
2. 和现有二进制下载一样，仅对这个精确 GET 路径豁免 Room-Protocol-Version 头，以便 `<img src>` 用 HttpOnly cookie 请求；不能豁免整个 `/api/artifacts/*`。
3. 查 artifact 存在、所属 room active、image.verified=true、受管 PNG 预览存在，必要时核对 preview hash。
4. 响应固定 `Content-Type: image/png`、`X-Content-Type-Options:nosniff`、`Content-Disposition:inline`、`Cross-Origin-Resource-Policy:same-origin`。
5. 使用 private/no-store 缓存策略，删除房间后不能继续通过条件缓存拿 304；不设置 public immutable。
6. 原始下载仍 octet-stream + attachment，不直接用客户端 MIME inline 输出任意文件。
7. 预览损坏/丢失返回明确错误，前端降级文件卡片；不能读用户提供的任意 previewPath。
8. 旧 owner 上传的 image/* 没有 verified 元数据时保持下载卡片。可在 owner 明确打开时受控准备预览，或让新 owner 图片上传复用 validator；不能直接信旧 MIME。
9. CSP 继续只允许本域图片；不为这个需求加 wildcard img-src 或允许任意远程图像。

前端新增 `apps/web/src/attachments.tsx`，从第 175 行抽出附件展示：

10. `MessageAttachments` 按 artifactId 查 metadata；verified image 渲染缩略图，其他仍用原文件/报告按钮。
11. 用 `/api/artifacts/<encoded-id>/image`，width/height 保留比例；`loading=lazy`、`decoding=async`、max-width 限制移动端溢出。
12. alt 使用 image.alt 或 artifact.name；只作为文本属性，不 dangerouslySetInnerHTML。
13. 点击缩略图打开 Lightbox Modal，键盘 Escape、焦点返回、下载原图和关闭按钮完整可用。
14. 图片 onError 切为“预览不可用”文件卡，保留下载/重试，不无休止重新设同一个 src。
15. 纯图片消息不渲染空 Markdown 段；图文消息先正文再附件；外部来源 trust badge 保留。
16. UI 文案区分“上传完成”和“消息已发布”；只有收到 message receipt/event 才显示进入聊天。
17. 自动滚动沿用 followLatest：图片加载改变高度时只在用户贴近底部才跟随，不能把正在看历史的用户拉走。
18. 多图、长文件名、透明图、竖图、窄屏布局覆盖；大图不把消息区域挤成全屏。
19. 房间删除/切换时关闭 lightbox，取消未完成预览状态，旧请求不能把别房间图片塞回来。

浏览器验收：Agent 连发文字和图片、纯图、两图组合、刷新/WS 回放、预览放大/下载、cookie 过期、伪图文件降级、移动端与键盘访问。

### I07 — 必须一起验证的跨功能竞态

新增 `tests/room-image-races.test.ts`、`scripts/acceptance-room-images.ts --check`。

1. begin 后删除房间：chunk/complete/post 均被拒，不产生公开消息，临时预约最终释放。
2. complete 解码 await 时删除：即使预览已生成，最终 commit 仍拒；临时孤儿可 GC。
3. 上传期间移除成员/Agent disabled/read-only：后续操作拒绝；权限变化不能靠旧 uploadId 绕过。
4. 托管 Run 取消、任务版本变化、旧 generation：旧完成或 post 被拒，不混入新 Run 产物。
5. 上传完成但 post 响应丢失：用同 post ID 重试只得到一条消息；对账完成后不能重传成第二 artifact。
6. 图发到 A 房间后拿 ID 给 B：message.send 拒绝；B 的 scoped token 无法继续 A 的 upload。
7. 多个并行 Agent 各传图片，块/文件/actor 不串线，队列有界，另一个普通文字任务仍可推进。
8. 事件导出/重放只含 artifact 元数据与 message 引用；无 base64、原始本地路径、环境 token，image preview 元数据一致。
9. artifact 实体文件缺失时，投影重建不造假文件；UI 显示不可用，导出报告缺失内容而非伪 hash。
10. 房间设置新增成员之后，新成员可上传并发图；进行中的其他成员任务不会因为普通设置变更被误取消。
11. 同 room 删除与最终 apply 并发：两者通过短事务/项目锁串行复核，不能删除已接受后又开始新应用。
12. 删除最后房间、restart、重建投影后列表仍为空，旧图片 URL 普通读取仍不可用。

`--check` 用本地固定图与模拟 transport，不启动模型。host/sandbox 真管道与 external stdio 单独记录 transport 证据，不能只用函数 mock 宣称全模式通过。

## 7. V 批：源码绑定、持续验证与真实实验

### V01 — 开发报告和发布报告分模式

锚点：`scripts/verify-collaboration-baseline.ts:19-27,72-87,97-151`、`tests/verification-report.test.ts`。

CLI 增加 `--release --expected-head <完整SHA>`；默认仍是开发验证。开发模式可在 dirty 树上运行，但必须绑定实际内容并明确不能据此声称 release ready。

1. 将 `SourceInfo` 扩成 sourceBefore/sourceAfter；包含完整 HEAD、dirty、Git 命令状态、trackedTreeHash、workingContentHash、untracked manifest hash、lockfile hash、node/npm/git 版本。
2. Git 调用失败必须 report `source_unknown` 并让 release 失败；现在空字符串既可能是 clean 又可能是 git 失败，必须拆开。
3. 文件枚举使用 `git ls-files -z` 和 `git ls-files --others --exclude-standard -z`；不要用空格拆文件名。
4. 每条清单记录路径/文件类型/字节数/SHA256；删除、重命名、symlink、大小写也进入摘要。报告不保存文件内容。
5. 哈希实际字节；`statusHash` 可保留为诊断，但不再作为源码内容身份。
6. `.state`、node_modules、dist 等 ignored 生成物不进入源码集合；tracked schema、package-lock 与文档进入，禁止任意把本批源码排除。
7. 开始前 capture；release 要求 expected-head 存在且等于 HEAD、dirty=false、工具版本已知。
8. release 前置失败时记录命令 not_run，退出非零；不是“没跑所以没失败”。
9. 每条命令保留 argv、cwd、开始结束、exitCode/signal/timeout、完整输出文件与 hash、明确环境；null exitCode 视为失败。
10. 完成后再 capture，HEAD 与源码内容必须和开始一致。验收期间源码变化，即使命令全过也不能通过 release。
11. 本批 build:sdk 会生成 tracked schema；应先在开发阶段生成并纳入目标提交，再在 release 中验证生成结果无差异。
12. 报告 schemaVersion 升 2；旧报告按原版本解释，不能用新规则篡改历史 ok。
13. `checksPassed` 与 `releaseEligible` 分字段。`ok` 根据 mode 明确计算，release 还要求所有 required 命令实际运行且通过。
14. expected-head 是验证目标，不等于人工批准记录；没有单独批准事实时只写“目标提交验证通过”，不声称已获发布授权。
15. CLI 把 --release/--expected-head 传入 verify，而不是只在打印时显示；未知参数报错，避免拼错参数静默退回 dev。
16. 保留 modelRequests=0，只用于本地验证命令集；不把真实实验脚本加进默认集合。
17. 报告写 ignored `.state`，不在验证结束后改 tracked 完成文档再沿用同一 SHA 的 release 声明。

定向测试：clean 成功、dirty dev 内容区分、dirty release 拒绝、expected-head 错误、Git 失败、同 status 不同内容、未跟踪内容变化、命令运行中源码变化、删除/带空格文件名、缺项/skip、输出异常、schema 漂移。

### V02 — CI/preflight 接入真实入口，避免递归与重复测试

修改 `.github/workflows/ci.yml`、`scripts/preflight.ts`、`package.json`、必要的 tsup 构建参数。

建议新增脚本：

```json
{
  "test:mcp-connectors": "tsx --test tests/mcp-connector-contract.test.ts",
  "check:room-plugin": "node scripts/sync-room-agent-plugin.mjs --check",
  "acceptance:room-images": "tsx scripts/acceptance-room-images.ts --check",
  "test:room-images-native": "tsx scripts/smoke-agent-images.ts",
  "verify:collaboration:release": "tsx scripts/verify-collaboration-baseline.ts --release"
}
```

`test:room-images-native` 要求显式选择模式；没有 Windows sandbox 环境时记 not_verified，不把 skip 算 supported。`--expected-head` 由调用方显式传入。

1. 定义 collaboration manifest：typecheck、npm test、既有 replay/fault/concurrency 必需检查、连接器 syntax/stdio/副本一致性、parallel --check、room-images --check。
2. 共享测试若已作为 npm test 执行，报告可引用同一次完整结果；若既有 replay CI 明确要求独立命令则保留。不得为了凑数量重复整套测试。
3. verify 不调用 preflight，preflight 也不能递归进入自身；`verification-report.test` 继续注入 fake runner，绝不触发全量自调用。
4. preflight 调 release collaboration 一次，替换原重复 typecheck/unit 步骤，随后执行现有 secrets/build/SDK/browser/production 项。
5. preflight 外层同样 capture sourceBefore/After，保证后续 build/SDK 阶段也不改变被验证源码。
6. CI 传 `${{ github.sha }}` 为 expected-head，目标 commit 必须与 checkout 的实际 HEAD 一致；PR merge SHA 与源分支 SHA 不要混用。
7. 现有 CI verify job 与 release-preflight job 可以各对自己的干净 checkout 验证，但同 job 内避免重复执行全量测试。
8. `npm run build` / tsup 明确 external sharp，生产 node_modules 包含锁定依赖和对应 native 包；不把 sharp 打进浏览器或沙箱 toolchain。
9. Windows production smoke 实际从 dist 启动，发一张固定图并检查预览，证明开发环境可用以外的部署能力。
10. 上传证据新增 collaboration-baseline、acceptance-parallel-tasks、room-images、mcp-connectors 和必要截图，if:always；不上传 tokens、用户原图与完整用户数据库。
11. 每项 required 测试缺失/跳过/超时都使 release eligibility=false；UI 检查被 skip 时只能出开发报告。
12. 原生图片管道可作为有条件环境 job，但其缺失必须出现在模式矩阵；不能让基本模拟 CI 因缺少真实模型账号而失败。

### V03 — 固定版本真实 CLI 和三组对照

复用 `scripts/real-dual-agent-experiment.ts` / `real-experiment-lib.ts` / `docs/E02-REAL-EXPERIMENT.md`。先修复实验任务类型，现有会话级顺序 E02 不证明项目并行。

1. 先完成无模型 CI，选择独立一次性 fixture；不要拿日常仓库或本房间数据库做实验项目。
2. 核对当前已有明确的真实 CLI/费用/时长授权；未有具体上限就保持待执行状态，不把“写 Plan”扩大成启动付费模型的授权。
3. 记录 CLI 绝对程序路径、实际 --version、provider/model、adapter 指纹、executionMode、workspaceMode 与账号来源类别；不导出密钥。
4. 固定同一“订单查询”契约和 owner 维护的独立 verifier 内容 hash，不让受测 Agent 改验收器。
5. 三组保持目标、输入与验收一致：单 Agent；两个独立 Agent 简单并行；完整协作与受控集成。
6. 实际走项目任务而非仅写群聊正文；两个 Run 都应有共同 baseline、独立 cwd、真实 patch 与 integration 证据。
7. 记录可观测执行开始/结束区间，用 `max(startA,startB) < min(endA,endB)` 检查重叠。时间源/粒度不足或仅有 run.started 事件时标 not_verified。
8. 另行保存适配器真正启动/首活动/最后活动/退出证据，不能用服务端排队状态伪装执行区间。
9. 报告契约通过/失败数量、墙钟耗时、各 Run 耗时、known tokens/cost、unknown cost 清单、返工/重试/人工介入次数。
10. 不把 unknown 当 0；对账续轮计入总耗时/费用；失败试验不从对比里隐去。
11. 设置总时长/激活数/费用 hard limit；中止后保留资源清理证据。
12. 做真实连接器发图 smoke 可使用固定本地 PNG，不必让模型生成图片；至少验证两个实际受支持入口，未测模式单列。
13. 若模型未按契约产出、版本不匹配或环境不可用，修复可控原因后再试；当前报告保留失败/未验状态，不宣称 M1 完成。

### V04 — 文档、备份/导入导出与统一完成口径

所有进度清单、提交说明统一使用 G00–G01、P01–P06、R01–R05、I01–I07、V01–V04，共 24 张任务卡。

1. 更新 `docs/AGENT-PARALLEL-PROGRESS.md` 与 `NEXT-AGENT-PROGRESS.md`，对引用本批卡片而非复制另一份完成状态。
2. `docs/CAPABILITY-COMPLETION.md`、`PLAN-CLOSURE.md`、`VERIFICATION-MATRIX.md`、`ACCEPTANCE.md` 统一引用同一验证报告与 SHA。
3. 状态分为“机制实现”“M1 模拟验收”“M1 真实实验”“本批新功能验收”“发布证据”；M1 全部七项缺一不能改成完成。
4. 文档写明 host-source 仍串行、host-isolated 的执行权限边界、attached 未自动获得新工具、API adapter 未新增视觉输入。
5. `PROTOCOL.md` 写 room revision/lifecycle/CAS/410、新事件、图片低层操作、幂等阶段和限制。
6. `EXTERNAL-MCP.md`、各 Agent 配置文档与 plugin README 给出 room_send_image path 示例、根目录限制、稳定 operationId、上传成功但发言失败的恢复方式。
7. `UI-WORKBENCH.md` 描述原子设置、加成员、删除确认/清理中、图片预览与空房间列表。
8. 更新 `scripts/backup-state.mjs` / restore 与其测试：备份 SQLite、已引用 baselines、artifact 原图/预览、apply journal；不只拷一个 DB。
9. 一致性备份应有快照水位/manifest，不能 DB 与文件拷贝跨时刻后假称完整；pending upload 可以明确不恢复，完成 artifact 必须恢复。
10. 导出图片二进制的现有限制为单件 8 MiB、总计 32 MiB，和本批单图 10 MiB 不同。保留有界导出，但报告 omittedArtifacts 与原因，不能悄悄省略后声称全量。
11. 导入原图后重新验 hash/生成安全 preview；外部导入的 image.verified 字段不是可信证明，不能直接 inline。
12. 无二进制的事件导入允许保留缺失 artifact 引用，但 UI 显示缺失；禁止生成错误的新内容冒充原图。
13. release 报告存在 ignored 目录，不在其验证后追写已跟踪完成文件再复用 SHA；如需提交摘要，提交后对最终新 SHA 再做相应验证。
14. 提交/发布动作沿用当时明确的用户授权；计划完成与发布就绪不等于自动获准推送或发布。

## 8. 逐文件修改核对清单

本清单用于 review 漏项核对；具体行为以对应任务卡为准。除新文档外，下列全部是待实现项。

### 8.1 协议与生成物

- `packages/protocol/src/room.ts`：新增统一 Room schema、lifecycle/配置/删除 schema，兼容历史缺省值。
- `packages/protocol/src/images.ts`：新增图片限制、元数据、低层上传参数/结果、工具权限映射。
- `packages/protocol/src/index.ts`：导出新模块；增加命令和工具 enum；扩 Room/Artifact 类型；message.send 支持纯附件。
- `packages/protocol/src/models.ts`：message text+attachments 联合条件；artifact contentHash/image 元数据，与接口同源。
- `packages/protocol/src/events.ts`：统一 Room schema、注册四类房间新事件，保持历史兼容与 registry 校验。
- `packages/protocol/src/task-contract.ts`：workspaceMode、冻结输入与兼容策略。
- `packages/protocol/src/project-binding.ts`：baselineId/算法版本与不可变内容引用；旧 binding 有明确补建规则。
- `packages/protocol/src/integration.ts`：验证前目标/组合/验收器/应用后摘要字段。
- `scripts/schema.ts`：新增 schema 出口，生成所有受影响 JSON；同一源码重复生成无差异。
- `packages/protocol/schema/**`：生成物随实现一起提交，禁止人工修一份遗漏其他份。

### 8.2 服务端

- `project-files.ts`、`immutable-baselines.ts`：安全统一扫描、内容快照、hash 与保留引用。
- `project-manifest.ts`、`workspaces.ts`：复用同一 manifest，copy baseline 而非每次扫可变源目录；原子应用 journal 完整摘要。
- `host-workspace.ts`：保留 host chat 隔离/观察语义；新项目隔离不要退回共享 commit。
- `integration-runner.ts`：异步 verifier、进程预算/取消清理、项目锁和准确组合。
- `room-lifecycle.ts`：设置规划、busy 校验、删除封写与 finalizer 所需纯逻辑。
- `image-uploads.ts`、`image-validation.ts`、`artifact-files.ts`：分块操作、实际解码、两阶段文件与事件提交。
- `store.ts`：独立迁移、afterCommit、activeRooms；raw 房间与审计保留；uploads operational tables。
- `event-projections.ts`：新房间状态转移与 revision 校验；新 artifact 字段回放一致。
- `service.ts`：原子 configure/delete、legacy wrapper、活跃房间检查、图片附件消息、project.bind prepared context。
- `worker.ts`：纯候选、准入重查、host-isolated、异步集成、删除 finalizer、两种 Agent tool 入口共用图片服务。
- `resource-manager.ts` / `execution.ts`：项目 canonical key、必要的清理白名单与 fence；不能扩大工具权限。
- `inbox.ts` / `input-delivery.ts` / `discussions.ts` / `wake-policy.ts`：删除后不派工、不补投、不自动新总结；真实账本保留。
- `tool-policy.ts` / `tool-authorization.ts` / `adapter-capabilities.ts`：image-write 映射、allowlist、型别化参数摘要与实测能力证据。
- `app.ts`：owner async command preparation、房间读取/删除语义、图片 route、上传复核、WS 终态、历史导出。
- `adapters.ts` / `toolchain.ts`：正确工作区与 helper roots；新 helper 复制/指纹；禁止暗改用户全局连接器。
- `room-import.ts`：新 room 身份与图片重验，不能信导入的 verified/授权字段。

### 8.3 连接器与客户端

- `scripts/room-bridge.mjs`：便利发图、扩展 room_post、子操作稳定 ID、保留小帧。
- `scripts/room-image-transfer.mjs`：本地读文件、块编排、重试恢复与小结果；Node 内置模块即可运行。
- `scripts/room-agent-mcp.mjs`：语法修复、稳定 operationId、external room_send_image/低层调用。
- `plugins/tempt-room-claude/server/*`：生成同步的自包含连接器和 helper，不引用仓库外路径。
- `scripts/sync-room-agent-plugin.mjs`：同步与 --check，不含用户 token。
- `sandbox/RoomSandbox/RoomPipe.cs` / `host.ts`：上限不扩大；真实分块管道用例验证，必要的错误码/超时处理。
- `packages/client/src/index.ts` / `image-upload.ts`：configure/delete helper、410 终态、bytes 发图；浏览器无 fs 依赖。
- `apps/web/src/main.tsx`：RoomForm 原子保存、删除状态/切房清理、成员新增、消息附件组件。
- `apps/web/src/attachments.tsx`：缩略图、降级卡片与 Lightbox；样式与无障碍。
- `apps/web/src/style.css` / `workbench.css`：设置删除区域、图片比例/网格、窄屏/空状态。

### 8.4 验证与运维

- `tests/helpers/controllable-adapter.ts`：可取消双启动屏障、可观测 adapter 区间。
- `tests/worker-dispatch-fairness.test.ts`：真实派发公平和资源忙候选跳过。
- `tests/parallel-task-{execution,dependencies,integration}.test.ts`：M1 前六项可失败用例。
- `tests/room-configuration.test.ts` / `room-deletion*.test.ts`：CAS、原子保存、删除/恢复。
- `tests/{managed,external}-image-tools.test.ts` / `sdk-image-upload.test.ts`：三类入口和稳定幂等。
- `tests/room-image-races.test.ts`：删除/权限/版本/上传跨阶段竞态。
- `tests/mcp-connector-contract.test.ts`：实际 JS 入口语法、stdio 与副本一致性。
- 既有 `event-replay` / `fault-injection` / `backup-restore` / `room-import` / `verification-report` 测试：新 schema 和故障边界。
- `scripts/acceptance-parallel-tasks.ts`：改为 Worker 实际执行，删除恒真验收主路径。
- `scripts/acceptance-room-images.ts` / `smoke-agent-images.ts`：无模型业务链与真实 pipe 模式证据。
- `scripts/verify-collaboration-baseline.ts` / `preflight.ts`：release 模式、前后源码 hash 和必需项。
- `.github/workflows/ci.yml`、`package.json`、`package-lock.json`、tsup 配置：门禁、命令、sharp 锁定与生产外置。
- 进展、协议、部署、插件/SDK README 与验收文档：事实源、操作方式、支持模式与限制。

## 9. 两个必须写清的跨层接口

### 9.1 异步 project.bind 不能破坏原命令幂等

现有 `RoomService.execute()` 是同步事务入口，不能直接在它内部 await baseline 准备。实施时固定以下接口次序：

1. 在 app 的 `/api/commands` async handler 中解析 command，先校验 owner 和已存在的匹配 receipt；未经授权不可触发源目录读取。
2. 普通命令直接 `service.execute(raw)`；project.bind 交给新的 server-only preparation helper。
3. helper 准备 baseline，返回私有 `PreparedProjectBinding`，含 raw command hash/source identity/manifest/baselineId。
4. prepared 对象通过内部参数传给 service；不加进 command.payload，客户端不能伪造 baselineId 或私有路径。
5. service 在同一短事务再次查 receipt/room/身份，并确认 prepared 与原始 command hash 一致，再写 project.bound 与 receipt。
6. receipt hash 继续绑定原请求，不因服务端随机生成 baselineId 导致同一 commandId 重试变成异参冲突。
7. 测试/acceptance 脚本使用同一 async command executor；不为测试保留一个能绕过冻结基线的 project.bind 后门。
8. preparation 成功、提交前取消/房间删除：不发布 binding，准备物按引用 GC；重试仍可复用已完成同 hash 内容。

### 9.2 Image complete 的 prepare/commit 不跨事务 await

流程骨架：

```ts
const scope = authenticateAndBindTransport(request); // 无客户端自定 actor/run
const input = parseImageComplete(request.arguments);
assertUploadAuthorized(scope, input.uploadId);
const prior = findCompletedReceipt(scope, request.operationId);
if (prior) return prior;
const prepared = await imageUploads.prepareCompletion(scope, input);
// 以上没有长期 SQLite 事务，也没有发布 artifact。
return commitPreparedImageOperation(scope, request.operationId, () => {
  assertUploadAuthorized(scope, input.uploadId);     // 删除/成员/fence 再检查
  assertContextAndBudgetCurrent(scope);            // 不能因为 prepare 成功就绕过
  const artifact = installPreparedArtifact(prepared);
  appendArtifactCreated(artifact);
  markUploadCompletedAndSaveReceipt(artifact);
  return artifact;
});
```

每一步的异常都保留稳定 code；install 和 SQL 之间崩溃由同 ID/hash 恢复；下游 room_post 使用另一个稳定 post ID。流程中的 helper 名是设计接口，实施时必须有对应定义和测试，不能留空壳。

## 10. 实施命令、交付物与完成判据

### 10.1 建议检查命令

以下新脚本要先按任务实现；本计划没有声称它们已存在或已通过。

```powershell
git rev-parse HEAD
git status --short
node --check scripts/room-agent-mcp.mjs
node --check plugins/tempt-room-claude/server/room-agent-mcp.mjs
npm run typecheck
npm run test:mcp-connectors
npm run check:room-plugin
npm run acceptance:parallel
npm run acceptance:room-images
npm test
npm run test:replay
npm run check:secrets
npm run build:sdk
npm run build
npm run test:sdk
npm run test:browser
npm run test:production
```

实施时按本卡需要选择定向检查；CI/preflight 使用固定 manifest 整合，不要求每张卡无差别重复上面整套命令。

最终 release 在已提交、干净的目标 SHA 执行：

```powershell
$taskExpectedHead = (git rev-parse HEAD).Trim()
npm run verify:collaboration -- --release --expected-head $taskExpectedHead
npm run test:preflight -- --release --expected-head $taskExpectedHead
```

如果 preflight 已包含同一 collaboration manifest，可直接以它为最终入口并引用该次子报告，不再为形式重复第一条。PowerShell 每个检查读取其自身 `$LASTEXITCODE`，不能依靠最后一条命令掩盖前面失败。

### 10.2 每张任务卡的最小交付格式

```text
卡号与状态：
基线 SHA / 实现 SHA / dirty 与内容摘要：
修改文件和关键符号：
变更前触发条件 / 变更后行为：
接口/事件/迁移/兼容性：
执行命令、cwd、环境、开始结束、退出码：
报告与日志/截图路径、内容摘要：
实际覆盖的模式和失败分支：
尚未验证项及明确原因：
下一张卡与依赖：
```

不要只交“已完成，所有测试通过”。不能用新建测试文件数、模块数或文档勾选代替功能证据。

### 10.3 最终关闭清单

- [ ] 两份外部 MCP 入口真实可启动，工具列表与插件同步。
- [ ] 候选集合不提前消耗容量，资源忙不会卡住整个 tick。
- [ ] 两个项目任务经过 Worker 进入 adapter 的屏障，独立目录、共同不可变基线。
- [ ] host-source / host-isolated / sandbox / attached 支持边界如实显示。
- [ ] staging 包含已经应用的完整目标；组合失败反例能检出，成功例能正常应用。
- [ ] 集成按 canonical 项目隔离，异步 verifier 不阻塞无关活动，进程预算/清理有证据。
- [ ] M1 原七项各有独立证据，真实实验未做时维持未验，不改标准。
- [ ] 设置一个事务保存，revision CAS 生效；新增成员能正常接收新任务，旧讨论不自动扩容。
- [ ] 删除房间后无新派工/上传/应用，迟到结果被拒；资源未知保留 deleting 和原因。
- [ ] 最后房间删除后重启不复活；双窗口、410、WS 终态与空列表体验通过。
- [ ] Agent 一次便利调用发图，纯图和图文均能显示、预览、下载。
- [ ] 三类传输有实际链路验证，单帧有界、权限与 fence 不被绕过。
- [ ] 幂等重试只有一个 artifact 和一条消息，失败阶段/可恢复结果明确。
- [ ] 图片完整解码、字节/像素/格式限制、safe preview 和导入重验通过。
- [ ] 删除/移成员/取消/重启发生在图片 prepare/commit 之间的竞态已覆盖。
- [ ] backup/restore、投影重建和导出/导入的图片缺失/省略语义准确。
- [ ] 当前目标提交的全量检查、源码前后一致与 required 门禁通过；未跑项没有伪 PASS。
- [ ] 进展/验收/能力文档引用同一报告，交付明确区分实现、验收与发布。

## 11. 可直接交给 DeepSeek 的执行指令

> 从本 Plan 的 G00 开始，按 G→P→R→I→V 顺序推进。先修外部 MCP 启动、真实派发公平、不可变基线和组合验收，再补房间原子设置/删除及发图。保留现有事件/fence/租约/预算/权限，不为过测试绕开它们。每次只关闭有实现 SHA、命令退出码和可回放证据的任务卡。遇到基线变化先复核，保留其他成员工作。新功能至少通过正常 Worker/API/stdio/UI 路径，不能靠直接 materialize 或恒真验收。没有真实 CLI/模式证据的能力保持未验证。当前任务是按计划实现与测试的工作说明；实际执行、真实模型费用及发布仍以届时用户明确请求和已有授权边界为准。
