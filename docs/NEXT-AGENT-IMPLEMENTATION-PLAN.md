# Tempt Room 下一代 Agent 实施规格与派工 Plan

版本：实施基线 1.1（任务并行主线修订）  
代码基线：`76632d4b4f4019722ffe8080da0ce1270b47bc0a`  
项目：`D:/DevelopProjects/web/ThisIsATemptProtocol`  
核查日期：2026-10-19  
交付范围：设计、代码核查、无模型验证与后续任务卡；本次修订只更新计划，未修改项目源码、未启动模型、未实际分派实现任务。原 1.0 交付物保留为历史版本。

本版修订：把“拆任务、并行执行、产物提交、顺序集成、整体验收”确立为实施主线；将项目映射、任务验收和双 Agent 实验的最小切片前移，并同步调整任务依赖与首批指令。以下新增设计仍是待实现规格，不是功能完成报告。

## 0. 下一位执行 Agent 先读这里

本规格替代旧 Plan 中与当前代码、后续三方确认基线冲突的实现指示。旧 Plan 保留为历史文档。所有现有行号均对应上述 HEAD；新增的文件、类型、接口、错误码与事件名均是本规格的**拟新增设计**，不是已经存在的实现。提交前用符号重新定位，不按过期行号机械替换。

“细化到每行代码”在这里落实为：每个任务写清现有修改锚点、字段、函数职责、执行顺序、事务边界、拒绝分支、测试输入与断言。尚未实现的完整函数不能被当作已编译补丁；实现后必须补上实际 diff 与测试证据。

任务卡中的负责人是建议分工：**Codex 执行开发与测试，Claude 审查架构和兼容性，DeepSeek 复核独立故障场景与测试缺口**。这些安排不表示已向成员发出工具任务。若只有一个后续 Agent，按依赖串行完成全部工作。

### 0.1 1.0 版本核查时观察到的基线

- `npm test`：283/283 通过，0 失败、0 跳过，约 22.6 秒。
- `npm run test:replay`：87/87 通过，0 失败、0 跳过，约 16.4 秒。
- `npm run typecheck`：退出码 0。
- 测试前后 HEAD 一致，`git status --short` 为空。
- 本次没有重跑浏览器、生产构建、AppContainer 原生验收或真实模型场景；历史报告不替代本次结果。

上述命令和数字属于 1.0 核查记录。本次 1.1 文档修订确认代码 HEAD 未变化，但没有重新执行这些测试；后续实现须重新生成绑定实际代码版本的证据。

### 0.2 保留并扩展，禁止重新造一套

以下已有实现，后续任务只补缺口：

1. `packages/protocol/src/events.ts:13–66`：事件注册、投影表清单、状态映射、瞬态声明。
2. `apps/server/src/store.ts:108–117`：事务提交后发布；`:216–245`：同事务快照及投影重建。
3. `apps/server/src/event-projections.ts:19–158`：共同 reducer，partial 与聊天终稿分层。
4. `apps/server/src/worker.ts:124–184`：单 Worker、执行代次、租约、全局并发、成员串行、host 项目排他。
5. `apps/server/src/context-reconciliation.ts:12–58`：连续增量、提交对账、执行结束后的补充轮次。
6. `apps/server/src/tool-operations.ts:9–42`：Room 工具先记意图、再执行、未知结果阻止重做。
7. `apps/server/src/native-operations.ts:9–65`：原生输入意图、工具通知、Codex 只读核对。
8. `apps/server/src/workspaces.ts:41–110`：脱敏独立快照、差异、基线哈希校验、应用日志与回滚。
9. `service.ts:94–111,325–398`：有界讨论、全员同候选确认、总结交付。
10. `tests/` 已有 replay、fencing、partial、恢复、信任、工具策略、讨论和并发测试。

### 0.3 本次发现的具体问题

**F01 加权公平可饥饿。**`scheduler.ts:15` 用 epoch 服务时间除权重。直接调用当前函数，两个成员持续有待办、权重 2:1、时间从 1792368000000 开始，1000 次选择得到 999:1。现有测试从小整数时钟开始，没有覆盖真实量级。

**F02 审计导出只取一页。**`app.ts:91` 只调用一次 `store.events(roomId,0)`；`store.ts:168` 默认 limit=500。因此超过 500 条事件的房间导出不完整。

**F03 host 变更报告不能检测全部内容变化。**`worker.ts:54–70` 比较 Git porcelain 状态码；执行前后均为 M 的文件，即使内容再次变化，也可能不进入新增变更清单。

**F04 host 聊天共享可写目录。**`worker.ts:47–50` 返回同一房间目录；`:79–85,338–340` 执行 git add -A / commit。成员串行仅限同一房间同一成员，不阻止不同成员同时编辑和提交这棵树。不能把共享目录自动提交当作隔离。

**F05 逻辑 AgentSession 尚未独立。**`sessions.ts:8–12` 是原生会话缓存键，`Store.sessions` 是 key/value；`worker.ts:159` 按 roomId+agentId 限制活动 Run。它们不等于三方确认的持久 AgentSession。

**F06 能力来自静态推定。**`protocol/index.ts:49–53` 按 provider/connectionMode 返回布尔值；`service.ts:71` 保存时重算。没有按实际版本与配置绑定的三态验证证据。

**F07 当前 inbox 没有提供端到端消费记录。**`worker.ts:587–590` 返回房间事件分页；没有持久的订阅匹配、输入批次、投递回执与上下文提供证据。外部 runner `:183–184` 启动时取当前 head；`:219–236` 等待执行结束后才再次拉消息，且只响应人类消息。persistent 进程不自动意味着运行中收信。

**F08 发言窗口与硬超时耦合。**`adaptive.ts:35–38` 使用 createdAt→updatedAt，包含排队和状态更新时间；`service.ts:319–321` 把它冻结进 Run.limits.timeoutMs，`worker.ts:267` 到时中止。它不是独立的讨论窗口或可靠执行耗时。

**F09 quorum 推进会取消未完成者。**`service.ts:357` 取消 pending Run，尚无冻结轮次与 late 结果的独立输入语义。当前收敛模式正确等待所有成员，必须保留。

**F10 用量可能覆盖或重复累计。**`worker.ts:249` 在一个 generation 内覆盖最新 usage；`codex.ts:16–19` 返回 last-request；`settings.ts:40–65` 汇总 generation；`web/main.tsx:232–243` 又按 run.usage 统计。三者口径未统一。

**F11 操作去重范围仍限同一个 Run。**`tool-operations.ts:14` 可以跨 generation 找 prior，但查询包含 runId；`service.ts:225–250` 的重试创建新 Run。不能据此声称已经跨 Run 去重。

**F12 任务完成与产物验收未分开。**`worker.ts:410–412` 把 Run 状态直接写任务；`:168` 依赖只检查 completed。`worker.ts:503–515` 的 patch apply 已有防护，但缺少持久集成队列、独立验收状态与验证环境。

以上是源码或针对性实验事实，不表示所有实际场景都会触发故障。

## 1. 必须保持的实现不变量

1. 房间事件日志仍是事实源；每房间 seq 保持单调全序。SQLite 当前仍是单写者数据库，不能承诺跨房间物理并行写事务。
2. 事件、核心投影和命令回执短事务提交，之后通知。模型请求、进程等待、Git/测试执行不得长期占用写事务。
3. baseSeq 对应当前字段 `Run.basedOnSeq`，只描述日志水位；文件和外部读取另外记录 SHA/内容哈希/版本。不要新增一个易分叉的同义可写字段。
4. generation/executionId 管受控提交资格；operation 的业务身份独立于物理执行代次。
5. 一条消息被持久化、投递适配器、提供为输入、得到可验证回执，是不同事实；任何回执都不证明理解或采纳。
6. 订阅只决定送达；触发规则才决定派工。typing、partial、状态和 ACK 默认不唤醒。
7. 单 AgentSession 默认一个活动 Run；跨 AgentSession 可并行，但同原生线程、同可写目录及独占资源仍互斥。
8. 暂停/结束在重启后保持；重启不自动扩大授权、激活预算或可用能力。
9. partial 不写普通聊天终稿；late 不改写冻结决策；quorum 不代表全员一致。
10. cancelled/canceled 表达停止结果，superseded 表达替代关系；租约过期不证明进程停止，取消不证明回滚。
11. host 目录隔离不等于安全沙箱。无法拦截的原生 Shell/文件/网络工具，不承诺全部前置门禁或恰好一次。
12. 老事件与命令回执不改写；新默认值只在新命令入队时冻结，不回填成历史“事实”。

## 2. 交付组织与合并顺序

任务卡保留六批编号：A 止血与证据，B 会话/投递，C 执行与副作用，D 交付与用量，E 发布与扩展，F 可选 P2 演进。实施按下述 M0–M3 里程碑推进，不要求先做完整 B/C 批才验证任务并行。每张卡原则上一个可审查提交；大卡按所列切片拆提交，但不能把未接入生产路径的空接口标为完成。

- `service.ts`、`store.ts`、`worker.ts`、`protocol/index.ts` 各批指定同一集成负责人，避免多个 Agent 并改核心大文件。
- 并行实现使用各自独立目录/分支；协议与迁移先合并，后续按已合并 SHA 开工。
- 模拟适配器、前端与证据脚本可在接口冻结后并行开发；不能凭尚未合并的接口自行提交兼容性声明。
- 下面测试命令中的 `npx tsx --test` 使用已安装依赖，不自动下载或升级工具。
- 所有临时库、项目与进程放到独立测试目录，不能迁移日常库、重启当前房间、改账号/模型配置来完成门禁。

### 2.1 并行交付目标与任务契约

首个核心里程碑是：两个不同 Agent 在独立工作区内同时完成不同子任务，提交可复核产物，经集成测试形成一个可用成果。多人讨论收敛、多个进程启动、多个 Run 显示 running，均不能单独作为该里程碑通过的证据。

复用现有 Task、Run、Artifact、Task.dependencies，不另建一套并行执行队列。先冻结目标和接口，再拆成低耦合任务；预计共同修改接口或核心模块时，先提取契约任务或明确依赖。

每个新严格任务须冻结以下信息，具体 schema 由 B01/D03 分阶段接入：

- objective、验收条件及批准的验证命令引用；验证脚本的版本与哈希也要记录。
- projectBindingId/bindingVersion、baselineRef、实际文件 manifest 哈希、接口产物 ID/版本/哈希。
- allowedPaths、预期产物与协作边界；路径声明只有接入实际工具策略时才是权限强制，不能把 prompt 当沙箱。
- 依赖任务及所需条件：execution、accepted_artifact 或 integrated，并绑定消费的任务版本和产物哈希。
- 被授权的执行者、执行模式、时长/激活上限及失败处理；后续接入 AgentSession 后使用其逻辑身份。

基线、接口和验收要求的变更由授权命令产生新版本。Agent 可以提出调整，不得通过普通聊天自行替换已批准目标。

### 2.2 就绪调度、依赖失效与局部恢复

扩展 worker.ts 和 dependencies.ts：先构造就绪集合，再通过 A02 分配槽位。就绪条件包括依赖达到要求、输入版本有效、会话/原生线程空闲、目录及独占资源可用、并发与预算准入通过。

领取任务、预留槽位/激活额度、绑定执行身份与 run.started 在短事务内确定；启动进程、模型请求和测试在事务外进行。同一任务版本不能因重复唤醒启动两个活动执行。启动失败释放有证据可释放的预留，结果未知则保留待核查状态。

一条分支完成即可解锁它的下游；没有依赖关系的任务不等待全员。Run.completed 只说明执行结束，不能代替依赖要求中的产物验收或集成通过。

任务失败只阻塞其依赖后继，其他有效分支继续。接口或产物版本变化时，根据实际消费版本确定受影响后继并撤销旧提交资格；新执行前复核输入，不对无关聊天或未使用该接口的分支强制重跑。已完成产物保留，已应用文件不因改版自动回滚。

未知副作用、旧进程未停止、未知集成结果分别进入待核查；不得把局部恢复实现成整房间重跑或自动重复业务操作。

### 2.3 共同基线、独立工作区与资源边界

同一轮独立开发先冻结一份不可变文件基线，生成 baselineRef/manifestHash，再从该基线创建各 Run 的独立目录；不能分别扫描持续变化的源目录，却宣称它们使用相同基线。下游在声明基线之上显式装配已接受的上游产物，记录输入清单与哈希。

优先扩展现有 Workspaces.snapshot、changes 和 apply。保留其脱敏过滤和独立 Git 快照；可选 worktree 模式仍须满足 D01 的授权与基线要求。业务源目录、聊天 scratch、执行目录、集成 staging 必须分别标识。

执行互斥作用于实际资源：单 AgentSession 一个活动 Run，同原生线程和同一可写目录互斥；不同独立工作区可并行，不使用房间级独占锁。端口、数据库、测试设备按容量分配；进程未确认停止或有效隔离时，不回收其资源。

M1 可先使用两个不同成员和各自新建的物理执行，沿用现有 roomId+agentId 守卫；不必先放开同一成员多会话并发。M2 完成 B03 后，才以 AgentSession 为粒度扩展，并继续保留 thread/目录/资源互斥。

### 2.4 执行中的协作与能力降级

任务并行的第一阶段使用稳定契约和完整启动输入，独立分支无需互相等待。执行中输入能力不是这一阶段的必要前提。

后续按任务关系投递有版本的接口变更、阻塞原因和产物引用。只有经 B05 验证的入口可进行运行中或工具边界补投；不支持时保留 inbox，进入下一轮，或在确认停止并核查副作用后受控重启。不能将自然语言“收到”或连接在线当作输入纳入证据。

M2 的验收增加执行中变更：记录持久化、适配器投递、输入提供及可验证回执，再通过产物测试证明新约束被使用。一次性 CLI 仍可参与任务并行，其补投模式按真实能力标注。

### 2.5 并行开发与顺序集成

各 Run 提交 patch/artifact、基线哈希、接口与依赖版本、文件范围和测试证据。独立 verifier 在隔离验证环境中运行批准的检查；执行完成、产物验收、集成应用和整体目标完成分别记录。

同一 canonical 项目目标的集成按 D02 队列顺序处理；队列锁不阻止其他独立工作区继续开发。集成 staging 装配精确产物组合，运行组合测试，通过后再核对源版本与文件 before-hash；源变化时拒绝陈旧应用。

冲突保留双方原产物并生成有明确输入的修复任务。应用动作沿用稳定命令身份和 journal；SQL 回执丢失先对账，不重复应用。默认集成权属于 owner 或已授权工作流，不由 Agent 多数表决取得。

### 2.6 M0–M3 实施顺序与切片边界

保留原任务卡 ID。a/b 表示同一卡的先后交付切片，不增加平行事实源或以接口占位代替完成；完整任务卡只有全部切片通过后才关闭。

**M0：并行准入与设计准备。**A00 固化证据，A02 修复持续待办饥饿；A03 与 D01 共同冻结目录映射和隔离方案。B05a 前移，先建立不依赖 AgentSession 的探针、指纹和三态结果格式；模拟契约与固定 CLI 的结果分列，没有执行实测则保持 unverified。A01 可按文件 owner 并行修复，不阻塞 M1 的任务闭环。

**M1：两个 Agent 固定契约任务的完整交付。**本阶段先限定两个不同成员、独立 fixture 项目、固定启动输入、已明确的执行模式和人工指定任务图，不包含动态自动拆解。按以下顺序交付：

1. B01a/B02a：先落地 Task 契约、项目绑定、基线引用、依赖条件、验收/集成记录及所需事件与迁移；同一迁移 owner 分配版本。完整协作 schema 后续增量迁移，不临时重解释旧事件。
2. C04a + D01a：实现本阶段目录/线程/房间并发准入、持久资源身份与取消清理边界；完成真实项目绑定、不可变共同基线、每 Run 独立目录。两张卡按冻结接口同批集成，不等待 C04 的所有远端/附着模式。
3. D03a：完成严格任务的执行/验收分离、版本化依赖与就绪判定、局部分支失败行为；不依赖完整 B08 摘要或动态输入。
4. D02a：接入单项目集成队列、staging 组合测试、源版本复核、稳定命令身份、应用 journal 与未知结果阻断。M1 不自动重试未知原生副作用；C01 的跨 Run 业务恢复不由此宣称完成。
5. E02a/E01a：接通现有服务入口和最小任务视图，用模拟适配器证明真正并行、隔离、产物交付、集成和失败处理，再按授权运行两个固定版本真实 CLI。UI 显示排队/执行/待验收/集成/阻塞原因。

M1 的启动、取消与工作区能力必须有模式明确的证据。未验证的运行中输入、恢复和工具门禁不自动启用；既有权限、fence、租约、额度检查不得为提前交付而删除。M1 使用明确的时长与激活上限，保留已有预算控制；未知费用按既有授权策略处理，不等待 D04 才设置上限。

**M2：持续协作与局部重规划。**按依赖完成 B03–B08、B05b、C01–C04 的剩余切片、D02b/D03b，接入持久 AgentSession、版本化补投、跨 Run 操作身份和恢复。至少让一个 AgentSession 走通“持久投递→实际输入→证据回执”，再推广适配器。相关接口变化只影响其消费后继。

**M3：规模、体验与扩展。**完成 B09、D04、完整 E01–E04；依据真实混合快慢场景调整容量、公平性和预算。F 批仍在闭环稳定后按需实施。每个里程碑都有 CI 契约门禁，不等完整 E03 才运行已有的阶段测试。

### 2.7 最小任务场景与里程碑验收

固定“新增订单查询功能”的接口契约后，A 开发服务端接口，B 开发客户端页面；独立 verifier 持有冻结的契约测试。两任务使用同一基线、不同目录，分别提交产物；集成 staging 用真实接口验证页面展示及异常处理。需要第三成员时，可让其并行编写额外用例，但冻结验收脚本不得被被验收 Agent 自行改写。

M1 必须满足：

1. 模拟适配器设置双启动屏障：两个执行均进入适配器后才允许任一个完成。不得只看两条 run.started、卡片状态或用 sleep 猜测。真实 CLI 记录可观察执行区间的重叠，无法确认时标 not_verified。
2. 工作区路径不同且基线引用一致；一个分支改文件不影响另一个；集成前源项目内容不变，旧共享目录不被自动 commit。
3. 单任务通过不等于整体通过；精确组合的产物通过独立集成测试，才能完成整体目标。
4. 一条分支失败时，独立分支可完成并保留产物；仅依赖失败分支的后继被阻塞。修复后复用仍有效产物，不能全盘重跑。
5. 同一来源/命令重复提交不重复派工或应用；源版本变化、旧 generation、验收失败和未知 journal 都不能误报交付完成。
6. 对故意冲突的 patch 保留原件并返回冲突；资源未清理时不显示已释放。暂停、取消、重启沿用持久状态，不扩大授权或预算。
7. 固定版本真实 CLI 场景和模拟 CI 分别报告。对同一目标比较单 Agent、简单并行、完整协作的质量、总耗时、费用已知/未知项和返工/人工介入次数，不预先承诺两倍提速。

新增定向测试建议：tests/parallel-task-execution.test.ts、parallel-task-dependencies.test.ts、parallel-task-integration.test.ts；新增 scripts/acceptance-parallel-tasks.ts。--check 不启动模型；真实模型模式、成本和授权边界沿用 E02，不因本次计划修订自动启动实验。

本项目自身的并行开发分工也须持久记录：每批列出文件路径/符号范围、主修改人、审查人、基线 SHA 与集成顺序。service.ts、store.ts、worker.ts、protocol/index.ts 和数据库迁移入口由该批唯一集成者写入；测试 fixture、独立模块和前端可按冻结接口并行。此规则管理开发协作，不得变成产品运行时的房间级锁。

## A 批：先修可复现缺口

### A00 — 固化当次代码与验证证据

负责人 Codex；DeepSeek 复核证据完整性；无依赖。

新增 `scripts/verify-collaboration-baseline.ts`，新增 `tests/verification-report.test.ts`，package.json 增加 `verify:collaboration`。

逐步实现：
1. 读取 cwd、HEAD、dirty 状态、Node/npm/Git 版本；不能读取环境变量全集。
2. 创建独立 evidence 目录；顺序运行 typecheck、npm test、test:replay。
3. 保存各命令 argv、开始/结束时间、exitCode、stdout/stderr 文件、报告 SHA256。
4. report.json 加 schemaVersion、sourceHead、sourceDirty、test counts、modelRequests=0；任何未运行项明确 not_run。
5. 总退出码：任一命令失败就非 0，不因成功生成报告而返回成功。
6. 不自动生成“280/280”等旧固定数字，不修改历史报告。
7. 从 M1 起将已落地的并行契约测试接入 CI；发布证据必须匹配当前 HEAD 和源摘要。开发中允许报告 dirty，但必须绑定完整 dirty 摘要；不能将旧 HEAD 或其他 dirty 内容的成绩作为当前 PASS。发布门禁要求批准的代码状态。

验收：用成功/失败假子进程验证汇总；更换 HEAD 或 dirty 后报告能区分。本文 283/87 是本轮观察值，不是以后测试数量上限。

### A01 — 修复审计分页截断

修改 `app.ts:88–95`，补 `store.ts` 有界事件扫描，扩展 `tests/audit-export.test.ts`。

具体顺序：
1. 固定导出起点、historyFloor 和 `throughSeq=headSeq`。
2. 新增 `scanEvents(roomId,{afterSeq,throughSeq,pageSize})`，每页最多 1000 条，游标取最后一个实际事件 seq。
3. 只导出 <=throughSeq 的事实；导出期间的新事件留给下一次导出。
4. 逐行输出 NDJSON，按 HTTP 流背压暂停，不一次拼接整个房间。
5. 对中间缺口或页游标未推进报错，不能把截断结果标成功；客户端断开即停止读取。
6. 保持 owner 鉴权；不把 Token、运行私有输出或未脱敏诊断新加进审计。
7. 如果采用读取连接，不复用当前写事务句柄进行跨 await 读事务；保证导出所用连接只读且 finally 关闭。

验收：0、500、501、2501 条事件均完整；导出中追加事件不混入当前水位；客户端中断释放资源；agent token 返回拒绝。执行 `npx tsx --test tests/audit-export.test.ts tests/event-replay.test.ts`。

### A02 — 修复加权调度饥饿，按“派发次数”定义公平

修改 `scheduler.ts:11–19`、`worker.ts:151–183`；扩展 fair-scheduler/fairness-pressure/pressure-scale 测试。

具体顺序：
1. 先把 eligibility 检查提成可测试函数：queued、依赖就绪、会话/线程/目录未占用、房间和全局槽位可用。
2. 新增 `ReadyScheduler.pick(eligible,weights)`；先按房间轮询，再在房间内按 AgentSession 做 smooth weighted round-robin。
3. 每次实际有资格派发时，候选 flow.credit += weight；选最大 credit，减去本次候选权重总和。相同 credit 按最老待办、稳定 ID 排序。
4. blocked/空队列不积攒额度；eligible flow 加入、退出或权重改变时，首版将该房间当前 flow 的 credit 一并归零，并清除退出 flow。长期份额按稳定集合区间验收；频繁集合变化另测最大等待界限，不承诺变化期间精准比例，也不保留历史欠账。
   对持续 eligible 但未被选中的 flow 另记等待派发次数，集合或权重变化不清零该计数。达到可配置 maxBypassDispatches 时优先最久等待者，稳定 ID 打破平局；服务后清零，退出/阻塞 flow 不继续积攒等待。有限 N 个候选下须用测试约束等待界限，防反复加入高权重 flow 导致每次重置后低权重成员仍被饿死。
5. 只有启动资格与 run.started 成功提交后才记一次已服务；失败或没有槽位不消耗信用。
6. credit 是调度缓存，可重建；重启不许绕过持久激活配额。首次恢复按排队顺序起算即可，不伪称跨重启精准份额。
7. 删除 epoch/weight 比较；若继续保留 fairOrder，只用于无权重稳定排序，不与新算法重复扣账。
8. 明确这是启动份额公平，不是 CPU/Token/完成时间 WFQ。WFQ 另行立项，不靠改名字宣称完成。

验收：真实量级时钟、持续入队 3000 次，稳定集合内权重 1:2 的长期派发份额接近 1:2；每成员最大等待派发数有界；100 个成员持续入队不饿死；成员加入/退出、在线改权重及反复阻塞恢复不形成历史欠账；多房间轮询；被锁住的队列不阻塞其他房间。旧 999:1 复现须成为回归。

### A03 — 修复 host 变更归因与共享提交

修改 `worker.ts:54–86,278–297,325–340`；新增 `tests/host-workspace-isolation.test.ts`，扩展 workspaces 测试。

具体顺序：
1. `hostStatus` 的状态码只能做展示；执行前后内容比较使用路径→SHA256/不存在，覆盖 tracked、untracked、删除、重命名和原来已脏文件。
2. 报告区分“执行期间观察到变化”与“该 Agent 独自产生”；缺少排他证明不能归因。
3. 新协作执行停用共享目录 git add -A 自动提交，改为各 Run 产物；不自动提交别的成员或用户文件。
4. 新的聊天运行默认使用独立执行目录。旧共享聊天工作区保留可读，不清空、不搬走、不伪造为项目源码。
5. 与 D01a 在 M1 同批接入真实项目映射与独立执行目录，不把项目隔离留到全部会话重构之后。确需共享写目录的旧模式只按 canonical 可写目录加排他锁，界面标明兼容模式；禁止用房间级锁代替隔离。
6. 同原生线程附着不自动改 cwd，仍按 thread lock 排他。

验收：原文件开始为 M，执行后仍为 M 但内容不同，报告仍检出；两个不同成员不能同时写同一兼容目录；独立目录可并行；用户预先存在的修改不被自动 commit。

## B 批：逻辑会话、订阅和输入交付

### B01 — 定义协议对象，复用现有 Discussion

负责人 Codex；Claude 先审字段和兼容性；依赖 A00。

新增 `packages/protocol/src/collaboration.ts`、`capabilities.ts`；修改 `index.ts:22–54,72–119`、`models.ts:10–15`、`discussion.ts:13–22`、`scripts/schema.ts:3–10`。

新增类型必须用 Zod 为事实源，TypeScript 从 schema infer；不要再维护两份字段不同的 interface。

拟新增字段/对象：
- **AgentSession**：id、roomId、agentId、discussionId?/taskId?、status(active/paused/ended)、adapterFingerprint、workspaceBindingId?、createdAt、updatedAt。物理 nativeSessionId 仍放绑定记录，不用作逻辑主键。
- **Subscription**：id、roomId、agentSessionId、eventTypes、taskIds、sourcePolicy、enabled、scanSeq。只支持明确类型与范围匹配，不运行任意用户脚本。
- **InboxDelivery**：id、agentSessionId、sourceEventId、sourceSeq、status(pending/batched/provided/expired)、batchId?。
- **InputBatch**：id、agentSessionId、runId、generation、executionId、deliveryIds、sourceEventIds、fromScanSeq、throughScanSeq、payloadHash、deliveryMode、createdAt、providedAt?、receiptEvidence?、status。
- **WakeIntent**：id、discussionId?、roundId?、agentSessionId、sourceEventId、status(pending/assigned/suppressed)、runId?、suppressionReason?。
- **CapabilityEvidence**：id、fingerprint、capability、state(verified_supported/verified_unsupported/unverified)、mode、testedAt、suiteVersion、evidenceHash、evidenceLocation、reason?。
- **Run 可选字段**：agentSessionId、inputBatchId、operationScopeId、responseSlotId、startedAt、finishedAt、adapterFingerprint。
- **Discussion 扩展**：paused 状态、triggerPolicy、activationLimit、activationsUsed、roundWindowMs、activeRoundId、authorizationRef、lifecycleVersion；具体终止原因补 budget_exhausted/activation_limit。沿用原 discussions 表，不创建第二个存相同内容的 DiscussionSession 表。

区分三个位置：
- scanSeq：已扫描到哪条房间事实，包括被过滤事件。
- batch.throughScanSeq：本批扫描边界，不能解释为该范围所有事件都已提供给模型。
- sourceEventIds/deliveryIds：真正提供的输入集合，必须精确枚举。

“已提供输入”是可审计阶段，不命名成“模型已理解”。能力名把 requestUserInput 与 steerDuringRun 分开，不能沿用现有 input=true 推导实时补投。

新增命令 schema：`discussion.pause/resume`、`subscription.set`、`input.ack`；owner 管会话和订阅，Agent 只确认发给自己的批次。字段均 strict，枚举和长度有上限；默认只在新命令入口赋值。

验收：schema 导出、未知字段拒绝、旧 Run/Discussion/事件可解析；旧命令 commandId/hash 不因新默认值变化；跨房间批次、伪造 actor、非法状态迁移拒绝。生成 schema 文件必须来自脚本，不手改 JSON。

### B02 — 增加可重放投影与数据库迁移

修改 `store.ts:7,14,38–86,129–136`、`events.ts:13–18,54–66,79–84`、`event-projections.ts:19–158,189`。依赖 B01。

迁移 owner 唯一。以当前 v9 为起点，第一批预留 v10；若开工时 HEAD 已前进，读取实际版本后使用下一个版本，不硬覆盖。

新增投影表：agent_sessions、subscriptions、inbox_deliveries、input_batches、wake_intents、capability_evidence、discussion_rounds。统一保留 id/room_id/body/as_of_seq；必要字段用表达式索引。全局能力证据可以保存成当前房间验证记录，避免往事件日志加入无 roomId 的特例。

必须建立：
1. inbox 唯一键 (agentSessionId,sourceEventId)。
2. wake 唯一键 (discussionId,roundId,agentSessionId,sourceEventId)，可空维度先归一化为明确的非空 scopeKey。
3. responseSlot 唯一键 (discussionId,roundId,agentSessionId)，与重试 attempt 分离。
4. 单逻辑会话活动 Run 的数据库约束/事务检查；不能只有 Worker.active。
5. 输入批次按目标会话与状态索引。

新增注册事件：agent_session.created/paused/resumed/ended；subscription.updated；inbox.delivered；input.batch.created/provided/acknowledged/expired；wake.requested/assigned/suppressed；capability.verified；discussion.round.opened/closed/late.received。
- 会话、订阅及轮次事件 aggregate 先归 room，输入执行事件归 run；不为此修改现有所有 aggregate 枚举消费者。
- projector 显式注册，SQL/Memory sink 同时支持。
- checkpointSchema 新增数组兼容旧 checkpoint 缺字段；仅在解码/重建中按空集合处理，不重写旧事件字节。
- Store.put 映射必须覆盖新增表；不通过旁路 SQL 修改投影。

旧会话处理：
- 原 sessions(key,value) 保留为原生缓存。
- 旧 Run 没有 agentSessionId 时使用确定性的 legacy scope 解析；只为需要继续调度的对象追加新事实，不把全部历史重写成新模型。
- 迁移前按现有 checkpoint+备份机制保存一致副本，失败整体回滚。旧服务应因版本门禁拒绝写入。
- 新增所有投影必须参与 projectionBytes、snapshotAt、snapshotWithTail、重建与清空；旧历史 floor 保留。

验收：v9→新版本与新库初始化；迁移中途异常；不支持的未来版本；旧收据和事件字节不变；每张新表实时结果与从头重放结果一致；并发连接不能创建两个活动槽位。先在 fixture/一致副本上跑，不打开日常数据库迁移。

### B03 — 实现可恢复会话生命周期与激活预算

修改 `service.ts:94–111,309–398`、`store.ts:88–101`、`worker.ts:124–184`；新增 `apps/server/src/agent-sessions.ts`、`tests/agent-session-lifecycle.test.ts`。依赖 B02。

执行顺序：
1. discussion.start 在同一事务建立 Discussion、参与者 AgentSession、首轮记录和 response slots。
2. pause 先持久标记暂停，禁止生成新 wake/激活；已在执行的 Run 是否停止由命令明确指定。resume 只由有权限命令恢复。
3. stop/end 持久写终态，撤销未激活意图；重启保持暂停或终态。active 讨论重启可停为 interrupted/restart，等待显式 resume，不自动跑模型。
4. 每轮每成员仅一个 response slot、同一时刻最多一个活动 Run；首版继续禁止普通 run.retry 绕过讨论调度。
5. 若后续增加讨论重试，必须走显式 discussion.retrySlot，并在原 slot 下创建新尝试；不是新 response slot，也不重置预算。
6. maxResponses 继续保留现有“已安排讨论响应”兼容含义；新增 activationsUsed 统计实际模型输入启动，额外上下文轮次与显式重试都收费。
7. 激活额度在 native.execution intent/输入提交前原子预留；一旦是否已提交未知，不自动退还。
8. sessionKey加入agentSessionId、实际workspace与adapterFingerprint；不同逻辑会话不得因同房间同成员而恢复同一个原生线程。旧v2缓存保留只读兼容；原生会话的cwd变化仍创建新scope。
9. 总结人使用独立、可见的最多一次总结授权；创建时同时声明其额度与费用上限，不能在响应预算耗尽后偷偷再开模型。
10. 默认值不能静默改变旧 discussion.start；UI 可提供“实验配置”预设：并发2、6轮、18次讨论激活、15分钟、90秒首轮窗口；总结额度另列。

验收：pause+重启仍不派工；end 后晚到事件不重开；同 event 重放不增预算；第19次讨论激活拒绝；额外对账也计数；总结失败与重试可见且受独立授权限制；当前收敛/总结既有测试继续通过。

### B04 — 实现订阅投递、幂等唤醒和有界队列

新增 `apps/server/src/inbox.ts`、`wake-policy.ts`；修改 `service.ts:75–92,309–332`、Worker 调度入口。依赖 B02/B03。

对每条新的 source event：
1. 先校验当前成员资格、订阅状态与授权范围。
2. 按序扫描并更新 scanSeq；命中后插入 InboxDelivery，重复唯一键返回已有结果。
3. 将“是否需要执行”交给纯函数 `shouldWake(event,session,discussionPolicy)`。
4. 默认 wake 白名单：显式点名、授权任务/接口交接、会话规定的前一响应完成；默认排除自身消息、audit、ACK、状态、partial、presence、typing。
5. 生成 WakeIntent，按 scopeKey+sourceEventId 去重。已有活动 Run 时只入 inbox，不再生成第二个活动 Run。
6. 同 round response slot 已激活时，新增消息并入现有补投或下一轮，不按每条消息启动。
7. 扫描游标与 pending delivery 必须分开持久化：扫描到 S 不代表 S 之前待办都处理完。
8. inbox 同时限制条数和 UTF-8 bytes；只合并可替换进度/提示。最终消息、任务、取消和权限变更不得丢。
9. 满队列对触发新工作的命令返回 429 inbox_full / room_queue_full，并记录原因；已提交事实不能靠“发布失败”回滚，后续投影重试必须可补全。
10. 业务事件与对应待投递意图在同一事务产生；若采用异步 projector，则持久 offset 与扫描恢复保证不因“commit后进程退出”漏消息。
11. 收信审计事件不能成为自己的新待办，避免轮询本身持续制造需消费事件。

验收：同一事件投递100次只一个delivery/wake；只有typing/partial/ACK时零新增Run；权限撤销立即阻断；扫描100条仅命中2条，返回 scanSeq=100 和精确2个ID；断线重启后pending仍在；满队列终态不丢。

### B05 — 能力证据矩阵替代静态保证

新增 `apps/server/src/adapter-capabilities.ts`、`scripts/verify-adapter-capabilities.ts`、`tests/adapter-capabilities.test.ts`；修改 `protocol/index.ts:49–53`、`service.ts:63–73`、`adapters.ts:29–64,141–201`、AgentForm。B05a 的探针与结果格式在 M0 独立于 AgentSession 前移；B05b 的持久证据、UI 与自动路由依赖 B01/B02。

实现细则：
1. 保留 capabilitiesFor 作为旧兼容提示；调度准入调用 `verifiedCapabilities(fingerprint)`。
2. fingerprint 至少绑定 provider、adapter实现版本、真实CLI版本、执行文件/运行布局标识、connectionMode、executionMode、模型与影响协议的配置摘要。摘要不包含密钥值。
3. 不把“exe路径没变”当版本没变；复用现有 executable-version/runtime 探测。
4. 每项能力分别存三态与验证模式：streamOutput、nextTurnInput、toolBoundaryInput、steerDuringRun、cancelOwnedTree、cancelRemoteTask、resumeSession、queryOutcome、usageScope、preToolGate。
5. 请求人类答题 requestUserInput 不等于 steerDuringRun；连接在线不等于 resume。
6. 新版本/配置摘要不匹配，旧证据失效，状态为 unverified。
7. UI 同时展示支持/不支持/未验证及证据日期；自动路由只启用 verified_supported。
8. 模拟适配器验证确定性契约进日常CI；真实固定版本集成验收作为相应适配器发布门禁，成本场景单独显式启动。
9. 没有本机CLI或模型授权时返回 not_run/unverified，不提交伪造证据。

验收：任意版本/模式变化使旧能力不参与路由；伪造正文“我支持实时输入”无效；未验证既不当支持，也不冒充实测不支持；测试证据可按 fingerprint 追溯。

### B06 — 输入批次交付与执行边界补投

新增 `apps/server/src/input-delivery.ts`；修改 `adapters.ts:26,323–380`、`worker.ts:209–218,220–263,301–317,523–559`、`context-reconciliation.ts:43–58`。依赖 B04/B05。

拟新增接口：

```ts
type DeliveryResult =
  | { kind: 'provided'; receipt: InputReceipt }
  | { kind: 'queued_next_turn' }
  | { kind: 'unsupported'; reason: string };

interface ExecutionInputPort {
  provide(batch: InputBatch, signal: AbortSignal): Promise<DeliveryResult>;
}
```

具体控制流：
1. 按目标会话和当前 RunFence 领取 pending deliveries，生成不可变 InputBatch，冻结 payloadHash。
2. 先持久 batch.created，再调用物理提供入口；不能先写 provided。
3. 只使用该 fingerprint 已验证模式。首版不支持 steer 的适配器走执行结束后的下一输入轮次，不能任意向 CLI stdin 拼接文字。
4. 工具边界补投要进入模型实际能读到的结构化工具结果；只在 Worker 内部读到 inbox 不算完成。
5. InputReceipt 包含 batchId、executionId、generation、provider关联输入ID、证据来源和精确事件ID；来源区分 provider-ack、adapter-boundary、submitted-input，不能相互冒充。
6. 无可观察回执保留 unknown/provided-unconfirmed；不能从自然语言“收到”改写状态。
7. 投递中崩溃后，先查询对应原生输入身份；未知时不重复注入。只有物理接口提供输入幂等保证时可重试。
8. ack 只确认当前目标批次，不接受任意 throughSeq 跳过未提供事件。
9. 活动中补投不任意推进 generation。真正开始新的执行尝试时，复用 advanceContext 的 fencing 流程，确认旧入口结束后分配新 executionId。
10. 老上下文候选仍在提交前 assertContextCurrent；是否提供输入和是否采纳分别由证据与产物测试判断。
11. 取消控制直接 AbortSignal/高优先级通道送达，不与普通 inbox 排队。

验收：fake adapter 用可控 barrier 证明新消息是在执行中、工具边界或下一轮哪个位置进入；错run/错generation回执拒绝；重复批次不重复输入；进程死于“已发送、未记回执”保持未知；新输入被纳入后产物必须按其约束改变。

### B07 — 外部 MCP/runner 可恢复消费

修改 `worker.ts:575–647`、`scripts/room-agent-runner.mjs:183–239`、`scripts/room-task-context.mjs`、`scripts/room-agent-mcp.mjs`、`plugins/tempt-room-claude/server/room-agent-mcp.mjs`、`packages/client/src/index.ts:56起`。依赖 B04/B06。

实施：
1. 新增会话 inbox/ack 接口，旧 room_inbox 与 room_wait 保持兼容；不把旧客户端暗中升级为可信消费确认者。
2. 新接口返回 deliveryId/eventId、分页 scan cursor、head、hasMore、historyFloor、resetRequired。
3. runner 重启按服务端会话身份恢复未完成delivery；首次连接从显式起点建立订阅，不默认 current head 吞掉离线消息。
4. 拉取循环与执行循环拆开：执行期间仍收消息并持久待办；实际输入补投受能力限制。
5. 不把 cursor 在 runPrompt 前推进等同处理成功；输出失败、Room回执失败、CLI崩溃都保留待核查批次。
6. sessionFile 只存原生恢复数据；状态文件原子 rename，内容不含房间令牌。
7. 新协议的人工/Agent触发按服务端 WakeIntent，不再只靠 actor.kind=human；仍禁止任意 Agent发言自激。
8. 通用MCP、Claude插件和SDK同步新增工具schema及 allowlist。原白名单不自动扩大，缺权限明确提示。
9. 服务端重启令牌的现有失效策略保持；连接器凭现有授权重新签发后，逻辑消费状态继续保留。
10. 旧cursor低于historyFloor时返回重置契约，不能伪称缺口已全部补齐。

验收：离线20条消息→重启逐条补取且不重复派工；模型执行中收到接口事件→待办不丢；结果发布成功但HTTP响应丢失→稳定操作ID返回同回执；新旧连接器各有兼容测试。

### B08 — 订阅上下文、关键约束与外部读取版本

修改 `context.ts`、`context-format.ts`、`context-reconciliation.ts:7–37`、`external-context.ts`、`worker.ts:198–202`；新增 `context-segments.ts` 和对应测试。依赖 B04/B06。

具体实现：
1. 输入分四段：当前目标/授权、已接受决策与接口约束、关联任务/产物、订阅增量；普通历史作为可裁剪尾部。
2. 字节预算按 UTF-8 累计；目标/授权/关键约束不能被最近消息挤掉。
3. 每段保存源seq/eventId、覆盖范围、哈希、是否摘要、原文读取引用。
4. 超大单条约束返回 context_segment_too_large 或产物引用，不静默截断后标已消费。
5. 首版确定性提取与引用，不为“摘要”偷偷启动额外模型；若未来需要模型摘要，明确预算和授权。
6. 相关性触发覆盖任务版本、明确针对目标的接口/决定、源产物版本；无关聊天和自身进度不触发反复执行。
7. 文件读取证据记录 sourceCommit、路径哈希；数据库记录可用的行版本/快照标识；网络记录 ETag/版本/取得时间，没有版本能力则 explicitly unknown。
8. 只对受控读取工具承诺版本采集；CLI任意自行读取的数据不能伪装已冻结。
9. sourceCommit 不够保护脏工作树；必须记录本次实际文件内容基线。
10. 删掉 Worker prompt 中写死“最近40条”的说明，按实际冻结窗口与截断信息生成。

验收：关键约束在很早历史仍保留；6000字后的关键内容不被冒充已读；1000条无关聊天不无限触发补投；文件改变但room seq未变仍检出；seq增加但文件/相关输入未变不强制重跑。

### B09 — 独立轮次窗口、冻结状态与迟到结果

修改 `adaptive.ts:9–43`、`service.ts:319–321,334–365`、`worker.ts:139,267,304–343`；新增 `discussion-rounds.ts`。依赖 B03/B06。

实施顺序：
1. Run 持久 startedAt/finishedAt；硬超时仍来自用户冻结的 limits。
2. 新函数 `discussionWindowMs(samples,bucket,config)`，样本用真正执行时长，不用 createdAt和续租更新的updatedAt。
3. 分桶 provider+adapterFingerprint+model+任务类别；保存有限样本，冷启动用90秒实验值。p95采用有定义的经验分位数，EWMA用于平滑最近估计，不能把EWMA均值叫p95。
4. 窗口 clamp 到 min/max；快慢窗口不修改运行硬超时。样本量与参数可配，旧discussion不补入新的默认事实。
5. DiscussionRound 保存 openedSeq/openedAt、windowDeadline、participant slots、quorum、closedSeq/closedAt、closeReason、已结算结果ID。
6. 窗口到期仅展示已有partial，没有则显示仍运行/缺席；不生成假内容。
7. quorum/截止关闭轮次后，决策和用于汇总的结果集合冻结；不必为关闭展示窗口就取消慢Run。
8. late 结果写 discussion.round.late.received，绑定原round、run、输入版本；作为之后有授权的新输入，不插回已冻结决定。
9. publishFinalMessage之前先判断结果归属，避免先写chat/投票再发现迟到。
10. 收敛模式仍必须所有指定成员确认同一原文及版本；缺席、late、新用户要求不能冒充agree。
11. 当前Run.partial实现继续使用，第一批不另建第二套draft事实源；独立draft投影仅在明确读性能需要时增加可重建视图。

验收：慢成员窗口到期不被硬杀；已有草稿不变聊天终稿；late到达不改变上轮agreedBy/summary；两快一慢quorum推进但不宣称一致；硬超时仍实际停止/进入未知；模型/适配器版本变化不复用错误桶。


## C 批：执行安全、操作身份和恢复

### C01 — 跨 Run 的业务操作去重

负责人 Codex；Claude审事务与身份；DeepSeek测回执丢失。依赖 B01/B02。

修改 `tool-operations.ts:9–42`、`native-operations.ts:9–16`、`service.ts:225–250,309–322`、`worker.ts:530–557`、`protocol/execution.ts:9–16`、Room bridge。

新的身份必须明确：
- operationScopeId：一个被授权逻辑请求/业务流程的稳定范围，不是runId或executionId。
- operationId：范围内同一业务操作的稳定ID，由调用者保存并跨重试复用。
- operation row 的runId/generation/executionId：谁发起了原操作的不可变审计来源。
- 参数摘要：工具名、规范化参数、资源范围；不混入临时进程/attempt。

具体步骤：
1. 初始Run冻结 operationScopeId，owner run.retry/续接沿用；不相关的新请求使用新scope。改变业务含义的新操作需要新operationId。
2. 查询去重键使用 roomId+授权主体+operationScopeId+operationId，并建立唯一约束；可共享主体范围必须由owner明确授权，不能让任意Agent借用别人的回执。
3. 老记录没有scope时以legacyRunScope兼容，只能保证旧范围；不能推断历史两个Run是同一业务。
4. 已完成同键同hash返回原结果；异hash返回409 operation_conflict；started/unknown返回409 operation_outcome_unknown。
5. 返还旧结果不改变旧记录的generation，也不伪造新执行完成事件；可以追加“复用既有回执”审计。
6. 仍先校验当前调用者权限/fence，不能用幂等查询绕过已经撤销的访问权。
7. native input intent 与业务工具操作分开：开始新模型上下文不是重复业务副作用的许可；不能把整个prompt哈希当文件/支付操作ID。
8. Room bridge默认MCP请求ID只具单实例重试能力，文档/UI明确要求业务重试携带稳定operationId；不能自行声称跨CLI实例去重。
9. tool-operation projector继续校验不可变来源，新增scope后也不能借operation.reconciled改写原生产者。
10. native通知若没有可稳定映射的operationId，保留观测身份与unknown边界，不造一个“已全局去重”的结果。

验收：不同Run/不同generation同scope+operationId只执行一次；同ID不同参数拒绝；不同scope允许独立业务；回执丢失后得到原结果；unknown不调用action；伪造scope/agent/fence失败。扩展 execution-fencing、native-operations 测试并新增 operation-scope 测试。

### C02 — 将工具前置策略接入真实执行入口

新增 `apps/server/src/tool-authorization.ts`；修改 `tool-policy.ts`、`adapters.ts:343–352`、`acp.ts:21–35`、`host.ts`、相关桥接与协议。依赖 B05/C01。

实施：
1. 定义 `authorizeTool({actor,runFence,capabilityEvidence,tool,argumentDigest,resourceScope,authorizationRef})`，返回allow/deny及原因码；由服务端构造actor。
2. 保持已有roomToolPolicy/allowedRoomTools/长度限制，新增参数范围和资源路径检查；白名单只收窄既有授权。
3. 当前Codex/ACP自动accept的权限请求，凡能可靠拦截者必须调用策略；写授权记录并等待允许后才返回同意。
4. 接入当前线程/会话匹配，外来工具请求默认拒绝；取消/撤权与权限回复竞态返回拒绝。
5. 不把provider-notification当pre-tool hook。能力矩阵 preToolGate 只有全部声明范围测试通过后才支持。
6. 不能拦截的本地原生路径继续标unrestricted。若某任务要求受控写入，则不路由到未验证门禁；可在独立沙箱降级或要求owner选择兼容路径。
7. worktree和prompt均不能充当权限强制；策略必须由实际宿主/工具代理执行。
8. 记录参数摘要和决定，不落命令全文、凭据、私有推理；必要资源路径按脱敏策略保存。
9. 工具授权、业务去重、资源租约分别校验，不能有一项通过就跳过其他项。

验收：低信任正文伪装owner不能扩大权限；MCP/A2A引用内容不能获取写能力；路径越界/Windows ADS/重解析点拒绝；批准前杀进程不执行；旧generation已批准回调也不能调用新执行通道。未拦截CLI仍显示能力缺口，不把P0整体标完成。

### C03 — 未知结果只读核对与显式续接

新增 `apps/server/src/run-continuations.ts`、`tests/run-continuation.test.ts`；修改 `worker.ts:469–501`、`service.ts:225–250`、`app.ts:221–224`、SDK及运行详情。依赖 C01/B06/C04。

控制流：
1. 将 `run.retry` 的 conversation-only重试与unrestricted未知结果分流；未知副作用不允许普通按钮直接重放原始任务。
2. 新增owner命令 run.continue，参数包括 runId、expectedRunSeq、proofId、当前输入/任务版本、continuationMode。expectedRunSeq来自该Run投影水位，避免仅校验generation却遗漏同代次新状态。
3. 核对阶段只查询现有队列/线程/工具结果，不提交新模型输入；保留当前Codex完整history校验。
4. Claude/DeepSeek没有可靠历史接口时返回reconciliation_unavailable，不能由最后一条stdout推断成功。
5. 按操作生成 confirmed_success/confirmed_failure/not_executed/unknown；成功回执和业务成功分别判断，已知失败不能伪造成成功。
6. 仍有unknown时阻断自动续接；已确认not_executed也必须依据可信证据，而非“没找到日志”。
7. 续接先确认旧物理执行停止或失去资源，沿用operationScopeId；使用“已完成列表+当前增量+禁止重做列表”生成新输入。
8. 对话有新相关上下文时先补投，不重发旧原始任务；核对后的旧候选没有通过新水位检查，仍不得发布终稿。
9. 新续接Run和原Run关联标记、审计、激活预算预留在同一事务提交；相同commandId只建一个子Run。
10. 网络等待在事务外；执行前再次比对expectedRunSeq/proof/版本，过期返回409 continuation_conflict。
11. UI把“查询原结果”“继续未完成部分”“新建独立任务”分成清晰动作；未知操作不能默认勾选重做。

验收：查询不会调用turn/start或queue/add；已成功效果不再执行；tool成功但回执丢失保持unknown直到对账；proof串run/串线程拒绝；双请求只创建一次续接；上下文过期不发布旧终稿。真实CLI证明另列E02，不用fixture替代。

### C04 — 资源租约与真实进程树清理证明

新增 `apps/server/src/resource-manager.ts`、资源租约投影与注册事件；修改 `worker.ts:127–148,153–183,191–196,650起`、`host.ts:19–22,121–131,164–171`、`native-stream.ts`。C04a 在 M1 依赖 B02a，先覆盖不同成员的新执行、目录/线程互斥、房间槽位、持久资源身份和清理证据；完整 C04b 再依赖 B02/B03，补齐多 AgentSession、远端与附着模式。缺少清理证明时保留 quarantine，不能为切片交付跳过资源回收检查。

资源对象：id、kind、canonicalKey、capacity、holders、ownerRunId/executionId/generation、leaseUntil、state(active/revoked/quarantined/released)、cleanupProof。

具体步骤：
1. canonicalKey使用真实路径与平台规范化；Windows大小写和同目录别名不能绕过锁。读锁/写锁策略明确，默认写目录独占。
2. 资源申请、Run激活预留在短事务内；失败立即回滚预留，不占槽位。
3. 撤权先写revoked/拒收旧输出，再经控制通道停止；清理成功才released。
4. 无法证明旧持有者停止时quarantined，不重新分配同资源；租约到期本身不能released。
5. AppContainer已有SandboxProcess.Wait的Job清空核验保留；host的父进程exit和taskkill成功不能单独当进程树为空。
6. 需要host可靠进程树控制时，增加不附带AppContainer的Job宿主/等效原生受控进程组，启动时纳入Job；若当前环境不支持，能力为未验证且不宣称自动安全回收。
7. cleanupProof包含拥有的Job/执行标识、核验时间、剩余进程数或可信停止证据；不控制附着的第三方后端进程。
8. attached Codex只操作本次queue/turn，不能杀用户共享后端；远端cancel无确认时保持unknown。
9. 新增 maxConcurrentRunsPerRoom，Worker全局限制之外单独检查；active/dispatched计数以实际占用为准。
10. 控制取消不经过普通任务排队；Worker.close等待已拥有执行清理，有上限并记录未知结果。
11. 新持久资源表纳入replay，不用仅内存Map跨重启冒充租约。

验收：父进程先退出、子进程继续占端口时不释放；generation推进后旧进程不能写；房间A占满本房上限仍允许房间B；旧线程unknown阻断复用；重启发现孤儿资源保留quarantine；清理只针对本测试拥有的进程。

## D 批：项目映射、受控集成、验收与用量

### D01 — 明确房间到项目的映射与独立工作区

负责人Codex；Claude审权限/基线。D01a 的接口设计与 A03 在 M0 同步，运行接入依赖 B01a/B02a/C04a，在 M1 与 A03 联合验收；D01b 的完整模式覆盖依赖完整 C04。

新增 `project-bindings.ts`、project_bindings投影；修改 `protocol/index.ts:79–85,109–113`、`worker.ts:275–299`、`sessions.ts:5–12`、`workspaces.ts:12,41–66`、TaskForm/RoomForm。

实施：
1. owner用 project.bind 命令把房间绑定真实项目；保存canonical sourcePath、绑定版本、baseCommit、基线文件manifest哈希、允许执行模式、验证命令引用。
2. 新Task显式引用projectBindingId；不从worker cwd或房间空.git猜项目路径。
3. Agent提议不等于批准项目绑定/写路径，不能由普通聊天扩大projectPath。
4. 每Run冻结bindingVersion、sourceCommit、dirtyBaselineHash、workspacePath、mode。每个可写执行独立目录。
5. 优先复用当前脱敏独立Git快照；其隔离历史和排除凭据的逻辑不删除。无需为“worktree”术语重写成熟快照路径。
6. 允许host git worktree作为显式可选模式，但必须说明共用Git历史/元数据的范围；不自动复制历史凭据或把.git权限当沙箱。
7. 沙箱不能因主机登录态方便而变成host；host与sandbox各自保持能力与权限标签。
8. attach模式cwd不可随意改：新binding与expectedCwd不一致就拒绝，或owner新建绑定。不能在用户共享线程里假装隔离。
9. 房间聊天scratch目录只作聊天产物，不能显示成已绑定业务项目。已有文件保留并提供来源说明。
10. manifest包含实际文件基线，不能只靠HEAD；运行时记录依赖安装/验证环境引用，避免把node_modules凭据或缓存快照进去。
11. 新表、binding事件、snapshot和SDK一并接入；后续迁移由唯一迁移owner取得下一数据库版本。

验收：房间空.git绑定真实fixture项目后可读源码；两Run workspace不同、source不变；脏基线可追踪；路径别名/重解析点拒绝；新绑定版本使旧产物在集成时被拒；工作区映射能在UI和报告复核。

### D02 — 持久集成队列与验证后应用

新增 `apps/server/src/integrations.ts`、integrations投影；修改 `service.ts:270–273`、`worker.ts:503–515`、`workspaces.ts:84–110`、`app.ts:230`、SDK。D02a 在 M1 依赖 D01a/C04a/D03a，完整 D02b 依赖 D01/C01/C04。a 切片必须保留稳定命令去重、journal 对账和未知阻断，不能以未接入完整跨 Run 恢复为由自动重复应用。

Integration字段：id、roomId、projectBindingId、artifactId、artifactHash、runId、taskVersion、baseManifestHash、expectedTargetVersion、status、verificationId、journalId、requestActor、errorCode。
状态：queued→validating→staging→testing→ready_to_apply→applying→applied；失败分conflict/verification_failed/unknown/blocked。不得把所有失败折成failed字符串。

执行顺序：
1. artifact.apply命令只做鉴权、幂等、预检并入队，返回integrationId；新路径不在RoomService.execute的SQLite事务里运行Git/文件测试。
2. 兼容旧API时明确返回异步job状态，SDK/UI同步升级，不能假装同步已应用。
3. 按canonical source单一队列串行执行，持久租约与fence保证多连接/重启不双重应用。
4. 验证artifact绑定、内容hash、run/任务/依赖/binding版本；生成staging项目，顺序应用patch到staging。
5. 在隔离、可复现验证环境执行owner批准的命令；保存exitCode、输出摘要hash、环境版本。Agent自报“测试通过”不是此记录。
6. 测试通过后再次检查源文件before-hash及目标版本，防验证期间用户修改。
7. 入applying前提交操作意图和journal引用；然后执行现有带备份的文件应用。
8. 文件应用完成后journal写明结果/hash，再提交artifact.applied与integration.applied。数据库提交前崩溃时用journal对账，不盲目再应用。
9. rollback只恢复仍匹配本次写入after-hash的文件；用户后续修改时停止自动恢复，转blocked保留备份。
10. conflict拒绝整组应用，保留原artifact；不强推、不自动接收模型生成的冲突覆盖。
11. 集成权限默认owner或明确授权工作流；quorum/讨论agree不获得合并权。
12. 验证通过与最终应用分开记录；ready_to_apply可按授权继续自动应用，未授权则等待具体产物批准，不在未生成diff前先问权限。
13. 不把Git操作、外部文件和SQLite描述为一个原子事务；journal负责恢复可解释性。

验收：两个patch同时入队可预测排序；不同基线冲突整体拒绝；测试失败source字节不变；完成文件写入后、SQL提交前杀进程能对账；重复command不重复应用；未知journal阻止后续同源任务；用户并发改文件不被rollback覆盖。扩展artifact-application/workspaces/recovery tests。

### D03 — Task执行、交付验收与依赖分别建模

修改 `protocol/models.ts:11`、`index.ts:79–85,109`、`service.ts:113–219,278–295`、`worker.ts:164–169,401–414`、`dependencies.ts`。D03a 在 M1 依赖 B01a/B02a，先实现执行/验收分离、版本化依赖和就绪判定；其 verifier 可在独立环境验证候选产物，无需等待源项目集成。D03b 再依赖完整 D02/B08 接入 integrated 条件、动态输入和相关变更复核，避免 D02a/D03a 循环依赖。

新Task字段：objective、interfaceRefs、acceptanceChecks、allowedPaths、requiresAcceptance、requiresIntegration、acceptanceStatus、acceptedArtifactIds、verificationId、baselineRef、dependencyRequirements；projectBindingId/bindingVersion 与 D01 统一定义，旧 title/dependencies 保留。dependencyRequirements 精确绑定 taskId、taskVersion、requirement、artifactId/version/hash；只依赖任务执行的场景不强填不存在的产物。新 Task 的严格模式在命令入口显式选择，旧事件不自动转换。

实施：
1. 新代码任务显式冻结验收要求；旧Task缺字段按legacy行为，不能历史回放自动变“未验收失败”。
2. Run.completed只表示执行流程结束；产物只有独立verifier通过才acceptanceStatus=accepted。
3. task.complete外部摘要仍是交付候选，不授予验收或集成权限。
4. worker.finish不能无条件同时把新严格任务标“已验收”；UI清楚显示执行完成/待验收。
5. 新依赖边明确requirement：execution/accepted_artifact/integrated；代码依赖默认需要对应已验证接口/产物，集成依赖需要真实integration。
6. DAG校验扩展到新增/修改依赖，拒绝自依赖、跨房间、环；旧版本恢复不随意重排依赖。
7. task.revise/handoff继续使下游版本、验收和候选失效；已应用源文件不自动回滚，只标出重新验证需求。
8. 对允许变动的接口，先发布有版本artifact并由授权契约采纳；不要用任意聊天修改任务验收目标。
9. 验证命令是owner选择的argv/脚本引用，不运行Agent消息里的任意shell；不在业务源目录直接执行未验收代码。
10. 人工接受也记录actor、产物hash、范围和原因，不能省略证据来源。
11. 将依赖就绪检查提成纯函数，供 scheduler eligibility 与生产派发共同调用；同一任务版本的领取、资源/激活预留与身份分配避免重复启动。无关分支不等待全员。
12. 共同基线与已消费产物记录为输入清单；改版仅使实际依赖后继失效。独立分支继续运行，有效产物保留；重试不重置整个目标或讨论预算。

验收：Run通过但集成测试失败，下游严格依赖不启动；报告类产物可按其验收路径完成；改版后旧验收不能解锁依赖；legacy测试兼容；相同输入不同推理不自动宣称共识。

### D04 — 用量事件去重与预算预留/结算

新增 `packages/protocol/src/usage.ts`、`apps/server/src/usage.ts`、`budget-ledger.ts`、usage_samples/budget_reservations投影；修改 `codex.ts:16–19`、`adapters.ts:132–138,389–407`、`worker.ts:249`、`settings.ts:40–65`、`web/main.tsx:232–253`。依赖 B05/B03。

UsageSample字段：id、roomId、runId、executionId、provider、nativeSessionId?、turnId/requestId/itemId?、scope、counterEpoch、inputTokens?、outputTokens?、costUsd?、source、observedAt。

实现：
1. request级样本以provider+session+request身份去重；没有可靠请求ID时不得把每个通知当新请求累加。
2. 累计scope按相同session/counterEpoch做单调差分，重置/恢复时新epoch；最近请求不等同整个Run。
3. generation不能替代requestId；同Run多个请求累计，同session跨Run不能重复计总量。
4. Run.usage、usageByGeneration保留兼容展示，但都由统一usage reducer派生；预算与UI用同一聚合器。
5. 部分指标缺失分别unknown：有Token没有cost不能显示费用0；0与undefined严格区分。
6. 调度/新模型输入前原子预留可用预算，完成后按可信样本结算；并行两个Run不能各自花同一份剩余额度。
7. 估算预留记录estimate/actual来源与误差边界；未知费用提供policy：禁止自动执行，或owner明确允许按时间/激活次数限制执行。
8. 不能承诺模型调用结束后才上报的CLI精确费用硬封顶；UI区分可强制上限、尽力停止与不可测。
9. 成本预留未知结果不得自动全额退回；核对后结算或显式人工处理。
10. 预算超过已知阈值触发停止仍要等待C04清理；不能显示“已停”却留下进程。

验收：重复request通知只计一次；session总量100→130跨Run只新增30；恢复counter reset不出负数；两个并行请求原子预留；只有输入Token时输出/费用unknown；多轮对账累计不覆盖；UI总额=服务端聚合=预算账本。新增usage-ledger/budget-reservation测试并保留既有budget系列。


## E 批：可用界面、证明实验与发布

### E01 — UI与可观测性必须显示真实协作阶段

负责人Codex；Claude审可理解性。E01a 在 M1 接入最小任务/产物/集成视图，依赖 D01a/D02a/D03a；完整 E01b 再依赖 B05/B06/B09/C03/D02/D04，不以所有用量和讨论窗口完成作为并行任务可见性的前提。

修改 `apps/web/src/main.tsx:12,119–177,180–209,217–253,305起`、`run-drafts.ts`、现有CSS；新增 `apps/web/src/collaboration-view-model.ts`、必要小组件，避免顺带整页重写。

具体改动：
1. 消息详情显示source event、目标会话、输入批次、投递模式、最后阶段与证据来源。
2. 分开显示“已存储/待投递/已提供输入/回执未知”，不显示“Agent已理解”。
3. 运行卡显示排队原因：等会话、线程、项目锁、预算、依赖、能力未验证；不全部显示工作中。
4. 讨论显示暂停/结束原因、窗口与硬超时、额度余量、absent/late；意见阶段汇总与全体确认分开。
5. draft继续独立渲染，不被消息计数/全文共识统计计入；终稿supersede后只展示一个最终结果。
6. 项目面板显示source、baseline、独立workspace、host/sandbox、integration状态；聊天scratch明确标注。
7. 已知失败、未知效果、取消请求和已确认停止分别显示；操作未知时主要按钮为查询，不默认重试。
8. 用量按统一账本显示已知/未知/估算，能力矩阵显示三态与版本证据。
9. 所有新数据请求沿用RunDetail现有的单在途+房间/版本校验，避免旧房间请求覆盖当前页。
10. traceId串联command→wake→run→batch→operation→artifact→integration；日志记录身份、耗时、错误码和hash，不记录隐藏推理或凭据。
11. 指标至少包含queue depth、oldest pending age、enqueue/start/input latency、cancel cleanup duration、unknown count、integration conflict count、预算预留与未知费用数。
12. 指标标签控制基数；runId放trace/log，不做所有指标的永久label。
13. aria label、键盘焦点、移动端交付面板与现有布局保持可用。

验收：视图模型单测覆盖未知/失败/late；浏览器E2E验证取消中不显示停止成功、未验证能力不能选自动模式、draft不增chat数、旧响应不串房、集成失败可打开原因；截屏人工复核。

### E02 — 核心契约与双真实CLI实验

新增 `tests/helpers/controllable-adapter.ts`、`tests/collaboration-contract.test.ts`、`tests/collaboration-faults.test.ts`、`scripts/acceptance-collaboration.ts`；扩展现有browser-e2e与验收脚本。E02a 前移到 M1，按 §2.7 落地固定契约、不同成员、隔离工作区与真实集成的并行实验；E02b 依赖 B/C/D 完整相关切片，补执行中接口变化及副作用恢复场景。不要要求全部 B/C/D 批完成后才证明两个任务真正并行。

**模拟适配器必须提供可控barrier，不靠sleep猜执行时序：**
- waitUntilStarted、beforeTool、afterEffectBeforeReceipt、beforeInputReceipt、beforeFinalCommit、beforeApplyCommit。
- 测试控制start/finish/failure/usage；每次输入留下不可变批次hash。
- CI随机测试用固定seed，并记录seed；不以重复重跑到绿掩盖竞态。

至少覆盖以下生产入口，不只测helper：
1. 同sourceEvent多次送达，只一个待办/slot。
2. 过滤后seq间隔合法，scan cursor继续前进。
3. 单会话串行、跨会话并行、同原生thread互斥。
4. 同source目录受锁，不同工作区可并行。
5. 暂停/停止/重启后不自启，激活计数不回零。
6. 未验证能力不路由；声称支持但验证失败降级。
7. batch发出后断线，不重复注入未知输入。
8. 发言窗口不等于硬超时；late不改冻结投票。
9. 任务Run完成但产物验收失败，下游不解锁。
10. 副作用执行后、回执前崩溃，不重复action。
11. 取消/代次变化/权限撤销竞态，旧执行无提交资格。
12. 父进程退出但子进程存活，资源不released。
13. staging测试失败或source并发变化，不应用文件。
14. 应用完成SQL回执丢失，用journal对账。
15. 用量重复、累计重置、并行预算预留。
16. 每张新投影重放等价，错误事件整体回滚。

**真实双CLI最小任务fixture：**
1. 脚本创建独立小Git项目，固定外部验收测试；不使用当前业务仓库做实验。
2. 授权A定义格式化接口并产出 `src/formatter.cjs`；B实现 `src/client.cjs`，二者各有独立执行目录。
3. 初始草案是 `formatGreeting(name)`；任务明确允许A确定最终接口并通知B。A发布版本化接口 `formatGreeting({name,prefix})`，这属于原授权内接口确定，不冒充用户目标被随意改写。
4. 用可观察阶段确认B已经启动，再发布接口产物/定向事件；记录持久化、适配器投递、输入提供的时间与证据。
5. 若B适配器只支持下一轮补投，如实记录该模式；不能把一轮结束后重发当“运行中注入通过”。
6. B的成果必须消费对象参数和prefix；外部固定测试验证中文、空字符串、默认prefix及接口版本，防只输出“收到”。
7. 集成队列先staging测试，再应用到实验项目；原始业务项目字节不变。
8. 加入断线、回执丢失和取消重跑单独场景，原始Run/operationScope与证据保留。
9. 同一任务做单Agent、简单并行、完整协作三组。保存质量、总耗时、已知/未知费用、模型输入次数、人工介入数；一两次实验只用于暴露问题，不宣布显著性能收益。
10. 真CLI验证固定版本/模式/模型；能力结果逐项判pass/fail/not_run，不把“能聊天”推导为取消、恢复和副作用全通过。

脚本模式：`--check` 不发模型；`--allow-paid` 只在用户明确授权该实验时启动；参数包括所选agent IDs、独立stateRoot、fixtureRoot、maxActivations和硬时长。没有授权不启动模型，这是该脚本成本边界，不妨碍完成无模型实施。

验收报告必须包含HEAD、dirty patch hash、二进制版本/指纹、步骤、断言、seq/Run/batch/operation/artifact/integration关联、日志hash和not_run列表。禁止把此次已有三CLI讨论收敛记录当成“运行中接口变更协作”已经通过。

### E03 — CI门禁、发布证据和测试隔离

修改 `.github/workflows/ci.yml`、package.json、`scripts/release-readiness.ts`、`docs/VERIFICATION-MATRIX.md`。E03a 在 M1 依赖 A00/E02a，将已落地的并行测试接入持续门禁；完整 E03b 再依赖 E02b，不因完整发布流程尚未完成而推迟阶段测试。

改动顺序：
1. 保留Node24、Windows沙箱构建、secret scan、audit、typecheck、全量tests、replay/fault/concurrency、build。
2. 新增 `test:collaboration`、`test:collaboration:faults`、`verify:adapter-fixtures`，只调用已完成脚本和模拟适配器。
3. 能力矩阵fixture不是实际CLI通过证明；真实测试结果必须独立标注。
4. browser/production smoke使用独立临时state与port，不能连接现有日常Room。
5. 每job失败时也上传脱敏日志与报告；只上传允许清单，不上传.state整体、tokens、homes、真实模型私有原始记录。
6. readiness关联当前HEAD/dirtyHash和每项报告hash；旧HEAD结果只显示stale，不汇总为当前PASS。
7. 远端CI尚未执行就显示not_run；本地测试通过不能改成GitHub Actions通过。
8. 新数据库版本先迁移fixture与一致副本，原库升级由用户部署操作决定；发布失败不能靠旧二进制直接打开更高版本库。
9. 必要的恢复流程使用迁移前一致备份，在独立路径验证后切换；禁止自动restore覆盖日常数据。

验收：制造一个测试失败，job与readiness均失败且有报告；缺真实CLI证据时明确限制适配器能力；未运行项不会被绿灯吞掉；不因新增任务重复运行全部真实模型。

### E04 — 回写文档与能力完成定义

修改 `agent-parallel-collaboration-plan.md`、`docs/AGENT-PARALLEL-COLLABORATION-PLAN.md`、`AGENT-PARALLEL-PROGRESS.md`、`PROTOCOL.md`、`ARCHITECTURE.md`、`NATIVE-COMPATIBILITY.md`、`discussions.md`、README。依赖各已交付批次；不要提前写完成。

必须逐条写回：
1. proj_task/proj_run/proj_artifact是现有表的兼容视图，不另存相同事实。
2. baseSeq不能冻结文件/外部数据；关键读取单独版本化。
3. operationScopeId/operationId跨Run与代次稳定，generation只拒收旧执行。
4. 租约过期不证明停止；cancelled与superseded分开。
5. 数据库单写者与每房间seq；不承诺“跨房间并行SQLite写线程”。
6. AgentScope的内存MsgHub组件与Service部署能力分开比较；本批不据旧对比表发起框架迁移。
7. N个Agent反复读H长度历史是约O(N×H)输入放大，不是必然指数费用。
8. 公平算法写实际实现名称；未做真正WFQ不标完成。
9. 窗口、运行超时、unknown费用、能力证据和真实CLI验收各自边界。
10. canceled内部状态与run.cancelled线上事件映射，SDK/外部消费者不混用。
11. 老Plan勘误有版本说明；历史报告保留原观察时间，不把所有旧数字批量替换为283。

每项能力完成条件：生产入口已接入、正反例/失败路径通过、回放兼容通过、UI行为真实、报告绑定HEAD；模拟/真实/未运行分列。某CLI缺全工具门禁时按其能力限制发布，不能因此宣称整个P0绝对完成。

## F 批：P2演进，必须在前述闭环稳定后实施

### F01 — 提取实际使用的EventStore与Transport接口

新增 `apps/server/src/ports/event-store.ts`、`agent-transport.ts`；Store、Worker与适配器按小提交逐步接入。依赖E03。

EventStore只暴露核心实际所需能力：atomic append+receipt、readEvents水位分页、snapshot、projection query、subscription offset；SQLite事务能力由接口明确表达，不能虚构通用分布式事务。

Transport暴露：openExecution、outputs、provideInput、cancel、queryOutcome、close；每项都受CapabilityEvidence约束。复用现有native/attached/API/A2A适配器，不另造协议。

验收：SQLite实现和内存契约实现跑同一套核心协作测试；替换Transport fixture不修改任务状态机/投影器；生产路径确实经接口，不能仅新增未被调用的interface文件。

### F02 — 单房间导出/导入与可靠外发

依赖F01；新增room-export/import脚本及outbox投影，另行迁移审查。

具体要求：
1. 导出manifest含originInstanceId、roomId、seq范围、historyFloor、事件hash、artifact内容hash与协议版本。
2. 导入全新namespace，保留originEventId；相同来源重复导入幂等、异hash冲突拒绝。
3. 第二实例从检查点/有效floor重放，产物缺失明确报错；只复制JSON日志不算完整可恢复房间。
4. 需要外发时，事件与outbox在同一事务提交；at-least-once投递+消费者去重，不承诺网络恰好一次。
5. 多实例先按房间分区单写，不允许两个实例各自给同房间分配seq。
6. HLC只在确有跨节点因果时间需求时实现，不能替代room seq、fence或冲突裁定。

验收：实例A导出→全新实例B重放等价，重复导入无新重复事实；缺页/改字节/缺artifact失败；发送成功ACK丢失仍不重复消费。未完成此测试不宣称支持横向扩展。

### F03 — 可选AgentScope Service适配器

依赖F01/F02；保持可选，不阻塞本地协作发布。

先锁定真实目标版本与官方接口，届时再核对官方文档；本规格不基于旧讨论假定其能力。映射服务会话/任务/输入/产物/取消/恢复到Transport，记录能力证据；MCP仍管工具，A2A仍只在互操作边界。

验收沿用与本地相同的投递、取消、未知结果、断线和幂等契约；无法提供的能力显示unsupported/unverified。没有真实目标服务测试只交fixture状态，不宣布Service集成完成。

## 3. 精确执行依赖与批次验收

以下顺序取代 1.0 中“完整 B/C 批之后才做 D/E 批”的横向排期；各卡的完整交付要求继续保留。

- M0：A00 → A02；A03 与 D01a 设计同步，B05a 探针并行准备；A01 在其文件 owner 可用时独立交付。
- M1 协议：B01a → B02a，覆盖任务契约/项目/资源/验收/集成最小对象及兼容迁移。
- M1 执行：B02a → C04a；A03+B02a+C04a → D01a；B02a → D03a。
- M1 交付：D01a+C04a+D03a → D02a → E02a/E01a → E03a。固定 CLI 的启动模式证据由 B05a 提供，不启用未经验证的能力。
- M2 会话：B01/B02 剩余 schema/迁移 → B03/B05b；B03 → B04；B04+B05 → B06 → B07/B08。
- M2 恢复：B02+B05 → C01 → C02；B02+B03 → C04b；C01+B06+C04 → C03。
- M2 集成：完整 C04 → D01b；D01+C01+C04 → D02b；D02+B08 → D03b；按 E02b 增量验证相关功能。
- M3：B03+B05 → D04；B03+B06 → B09；相关生产闭环 → E01b/E02b → E03b/E04；E03 完整门禁通过后 → F01 → F02 → 可选 F03。

这里 B05 表示 a/b 合并后的完整能力卡；其余卡同理。A02 先以 legacy session scope 落地，B03 接入后改为真实 AgentSession key；两次提交均保留测试。不同切片不得先删现有守卫来“等后续补回来”。

M1 完成以 §2.7 的固定契约并行交付为准，不代表全部 P0、运行中输入、所有 CLI 工具门禁或跨 Run 副作用恢复已经完成。M2/M3 继续按下面完整批次门槛验收。

**P0可靠性批次完成门槛：**
- A批、B01–B08、C批、D01–D03的最小闭环完成。
- 旧事件/回执字节不变，新表重放一致；重复事件不重复派工；旧执行不能提交；未知副作用不自动重复。
- 运行中输入按各CLI已验证模式声明；没有这种能力可以降级，但不得宣称通过运行中注入。
- 必须有隔离项目、版本化产物和真实受控集成；仅聊天收敛不是交付验收。
- 全工具前置控制以适配器实际覆盖范围验收；未覆盖项继续列缺口。

**P1体验与调度批次完成门槛：**
- B09、D04、E01–E04完成，A02持续入队门禁通过。
- 发言窗口与硬超时分离，late不改冻结事实。
- 激活/预算不绕过，用量scope去重，未知费用不假装0或精确封顶。
- E02混合快慢真实CLI有报告；性能收益由对照数据决定。
- 参数仍可配置；未取得数据不承诺生产吞吐、p95延迟或最大并发。

**P2完成门槛：**
- F01真实替换验证与F02第二实例重放通过；F03按可选能力独立报告。
- 没有多写者设计前只支持房间单写分区，不宣称跨机强一致。

## 4. 每张任务卡固定交付格式

下一位Agent每提交一个任务都要附：

1. 基线SHA、完成SHA、dirty状态、任务ID。
2. 修改/新增文件和实际符号，迁移版本及生成schema差异。
3. 已满足不变量、保留限制、失败分支与错误码。
4. 真实执行的验收命令、退出码、测试数与报告路径/hash。
5. 模拟适配器、真实CLI、浏览器、远端CI分别pass/fail/not_run。
6. 是否产生新模型输入/实际副作用；只记录有证据的次数，未知不能写0。
7. 回滚/停用方式。数据库升版后不能用旧writer直接回退，需停用功能或验证恢复副本。
8. 下一任务的前置条件。不能只写“接口已预留”“理论支持”“所有测试应该通过”。

统一门禁，在对应新增测试已落地后执行：
```powershell
npm run typecheck
npm test
npm run test:replay
npm run test:faults
npm run test:concurrency
npm run build
npm run test:collaboration
npm run test:collaboration:faults
```
后两条为E03拟新增脚本。针对任务先跑其定向测试；最终批次再跑全套。无新改动/失败时不重复全套消耗时间。

## 5. 可以直接复制给下一位Codex的首批指令

> 你负责 Tempt Room 开发与测试。以 76632d4b4f4019722ffe8080da0ce1270b47bc0a 或其已审查后继为基线，按本版 M0/M1 主线推进：先 A00 建证据、A02 修调度；A03 与 D01a 同步明确项目映射、共同基线和每 Run 独立目录，B05a 先建立能力探针与证据格式。随后审查 B01a/B02a 最小协议与迁移，依次接通 C04a/D01a/D03a、D02a、E02a/E01a/E03a，交付“两名不同 Agent 的任务真实重叠执行、隔离产物、顺序集成、整体验收”。A01 可按文件 owner 独立修复，不为此推迟并行闭环。先用模拟适配器双启动屏障与独立 fixture 项目验证，不等待全部会话/副作用/用量重构。开始前核对 HEAD 与 AGENTS.md，保留用户修改；每批指定核心文件唯一集成者。不要重复实现已有注册表、snapshot/replay、fencing；不删除现有权限、代次、目录、预算或租约守卫。未验证能力不自动启用，未知副作用和未知应用不自动重做。此批无模型实施不启动付费模型、不迁移日常库、不重启现用房间。真实 CLI 实验按 E02 的授权模式单独执行。每项交付实际 diff、命令、版本绑定证据及 pass/fail/not_run；M1 通过后继续 M2/M3，不把 M1 冒充整个 P0 完成。

首批优先级固定：
1. A00 基线与报告。
2. A02 epoch/weight 造成的持续饥饿；补在线变更和等待老化回归。
3. A03 + D01a 目录映射/隔离设计，B05a 能力探针前移；A01 审计分页独立修复。
4. B01a/B02a 任务并行最小协议、事件、投影和兼容迁移。
5. C04a/D01a/D03a 资源准入、共同基线、独立目录、严格依赖和验收。
6. D02a/E02a/E01a/E03a 集成队列、双 Agent 并行实验、可见状态和 CI 门禁，完成 M1。
7. B03–B08、C/D 剩余切片接通持久会话、实际补投、恢复和局部重规划，完成 M2。
8. B09/D04/完整 E 批完善窗口、用量、规模与发布；F 批按需另行推进。

后续按依赖继续，不把本清单当成已经实际派工或功能完成。
