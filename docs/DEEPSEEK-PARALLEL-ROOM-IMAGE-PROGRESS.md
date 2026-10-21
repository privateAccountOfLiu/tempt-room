# DeepSeek 后续实施进展：并行交付闭环、房间管理与 Agent 图片消息

本文件是 [实施 Plan](DEEPSEEK-PARALLEL-ROOM-IMAGE-IMPLEMENTATION-PLAN.md) 的唯一进展台账。
Plan 只描述待做工作，本文件记录实际发生的事：实现 SHA、命令、退出码、证据路径与未覆盖项。

> 副本说明：仓库根目录的 `deepseek-parallel-room-image-plan-v2.md` 与 `docs/DEEPSEEK-PARALLEL-ROOM-IMAGE-IMPLEMENTATION-PLAN.md` 当前内容相同。本文件与 docs 索引以 docs 下的副本为准；两份副本的去重与同步闸门列入 V04（文档统一），在此之前不擅自删除任一份。

状态取值：`not_started / in_progress / blocked / verified`。未验证的能力不得改写为完成。

- 实施顺序：G00–G01 → P01–P06 → R01–R05 → I01–I07 → V01–V04（共 24 张卡）
- 本轮执行者：DeepSeek；此前 G00–P02 由 mavis（MiniMax Code）完成
- 基线记录：`.state/parallel-room-image/20261021-162400/baseline.json`（ignored，不进入提交）

## 批次状态总览

| 卡 | 状态 | 摘要 |
|---|---|---|
| G00 开工记录与测试隔离 | verified | 基线 SHA/状态/工具链已落盘；fixture 隔离要求写入本文件与后续卡 |
| G01 两份外部 MCP 与防漂移 | verified | 语法错误在当前 HEAD 已修复；新增契约测试 15/15 与字节级同步闸门 |
| P01 候选枚举不消耗容量 | verified | 候选不再提前占用房间容量；派发前二次校验；资源忙保持排队不判失败 |
| P02 不可变基线与 host 独立目录 | in_progress | 共享扫描器 + 不可变基线 + host-isolated + 基线 GC + 旧绑定补建已实现并验证；依赖产物叠入、attached isolated 真实模式仍未覆盖 |
| P03 按 canonical 项目互斥、异步验收 | verified | 项目锁跨房间 canonical 互斥；验收异步化并纳入超时/输出上限/进程树清理；新增 4 个并发与 HTTP 用例 |
| P04 staging 精确组合 | verified | staging 由当前已认可目标 + 候选组成；目标/候选/verifier 篡改与无关文件变化均在 apply 前拒绝；journal 记录目标前后摘要 |
| P05 双启动屏障与真实派发 | verified | 可控 adapter 由真实 Worker 派发；两个 Run 同时进入后才释放，独立工作区、真实产物、owner 验收和 integration 全链路通过 |
| P06 M1 七项可失败用例 | in_progress | 1–6 的模拟切片已覆盖（并发=1 负例、共同基线、整体组合、局部失败/重试、幂等/fence、同文件冲突保留双方 patch）；第 7 项真实 CLI 对照依赖 V03 尚未执行 |
| R01 Room schema/事件/迁移 | verified | room.ts 统一 schema/normalizeRoom；新增 room.configured/deleting/deletion.updated/deleted 与状态守卫；迁移整理为 v10→v18 有序升级；生成物更新 |
| R02 单事务保存房间设置与成员 | not_started | |
| R03 删除请求、停止执行与清理 | not_started | |
| R04 API、WebSocket、SDK 与列表语义 | not_started | |
| R05 房间设置与删除 UI | not_started | |
| I01 图片协议、工具参数与权限 | not_started | |
| I02 有界可恢复的上传临时状态 | not_started | |
| I03 解码验真、原图与安全预览 | not_started | |
| I04 托管 bridge/host/AppContainer 传输 | not_started | |
| I05 外部 MCP、插件与 SDK 发图 | not_started | |
| I06 安全内联路由与图片展示 | not_started | |
| I07 跨功能竞态 | not_started | |
| V01 开发/发布报告分模式 | not_started | |
| V02 CI/preflight 接入真实入口 | not_started | |
| V03 固定版本真实 CLI 与三组对照 | not_started | |
| V04 文档、备份导入导出与统一口径 | not_started | |

## G00 — 开工记录与测试隔离

```
卡号与状态：G00 / verified
基线 SHA / 实现 SHA / dirty 与内容摘要：
  基线 bf1f722a3c74ed23990fd00b6c9f402d89a943b8（main，领先 origin/main 212，dirty=true）
  Plan 编写基线 e05a0cf6baab1ac412a11e07c45c207047c1e3e7；开工 HEAD 已推进，锚点已复核
修改文件和关键符号：
  .state/parallel-room-image/20261021-162400/baseline.json（ignored 本地工件）
  docs/DEEPSEEK-PARALLEL-ROOM-IMAGE-PROGRESS.md（本文件）
变更前触发条件 / 变更后行为：
  此前本批没有开工记录；现在每次实施都有可追溯的起点
接口/事件/迁移/兼容性：
  无业务代码改动，无协议与迁移变更
执行命令、cwd、环境、开始结束、退出码：
  git rev-parse HEAD / git status --short / node --version / npm --version / git --version
  cwd=仓库根，Windows PowerShell 5.1，2026-10-21 16:24–16:58 CST，退出码 0
报告与日志/截图路径、内容摘要：
  .state/parallel-room-image/20261021-162400/baseline.json（不含任何凭据或令牌）
实际覆盖的模式和失败分支：
  仅环境事实采集
尚未验证项及明确原因：
  无
下一张卡与依赖：G01
```

## P01 — 候选枚举不消耗容量，派发才计账

```
卡号与状态：P01 / verified
基线 SHA / 实现 SHA / dirty 与内容摘要：
  基线 bf1f722a3c74ed23990fd00b6c9f402d89a943b8；实现见下方提交
修改文件和关键符号：
  apps/server/src/worker.ts
    - dispatchCandidates(skip)：删除候选入列时的房间计数占用；新增房间 active、
      成员 enabled/成员资格、任务版本校验
    - startRun()：返回结构化 AdmissionResult（started/resource_busy/admission_denied），
      资源预留前二次校验房间、Agent、任务版本、房间容量与线程归属；
      资源忙时只释放本次取得的会话租约，运行保持 queued，不再直接判 failed
    - tick()：每轮维护 attempted 集合，准入失败的本轮跳过、下一轮可重试；
      recordServed 仍只在真正启动后调用
    - 新增 roomActive() / agentAdmissible() 辅助判定
  tests/worker-dispatch-fairness.test.ts（新增）4 个用例
变更前触发条件 / 变更后行为：
  变更前：dispatchCandidates 把每个候选计入房间占用，房间上限 1 时同房间
  A/A/B 只有第一个候选进入候选集，B 被 A 的排队吞掉直到 A 全部跑完；
  资源忙会把排队任务直接判 failed。
  变更后：三个候选同时进入候选集，由调度器按 SWRR 选择；
  资源忙返回 resource_busy，运行保持 queued，同一 tick 仍可派发其他候选。
接口/事件/迁移/兼容性：
  未新增协议命令、事件或数据库迁移；Run 状态机未变（不引入 not_started 状态，
  准入结果是调度器内部结构化返回值）
执行命令、cwd、环境、开始结束、退出码：
  npm run typecheck                       exit 0
  npx tsx --test tests/worker-dispatch-fairness.test.ts   exit 0（4 pass / 0 fail）
  npm test                               exit 0（447 pass / 0 fail）
  npm run test:replay                    exit 0（87 pass / 0 fail）
  npm run check:secrets                  exit 0（0 findings）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-21 17:00–17:25 CST
检出力验证：
  临时恢复旧逻辑（候选入列即占用房间容量）后，
  “A/A/B 公平性”用例失败、其余三个仍通过；还原后 4/4 通过。
实际覆盖的模式和失败分支：
  房间上限 1 + 并发 1 的同房间 A/A/B；房间上限 2 + 并发 3 的双房间混合；
  外部持有项目资源导致 resource_busy；成员被移出房间后不再调用适配器
尚未验证项及明确原因：
  未验证真实模型参与的派发顺序（契约测试注入确定性适配器，不调用模型）
下一张卡与依赖：P02（不可变基线与 host 独立目录）
```

## P02 — 真正冻结基线，host 项目也支持独立目录

```
卡号与状态：P02 / in_progress（核心路径已验证，卡内仍有未覆盖项，见下）
基线 SHA / 实现 SHA / dirty 与内容摘要：
  基线 078201e（G01+P01 提交）；实现见下方提交
修改文件和关键符号：
  apps/server/src/project-files.ts（新增）共享扫描器 scanProjectFiles()
    版本化算法 tempt-room-manifest-v2；稳定排序（码点序，不用 localeCompare）；
    更严格的排除清单；ADS/保留设备名/尾随点空格/大小写冲突显式报错；
    扫描期间文件变化返回 source_changed_during_snapshot
  apps/server/src/immutable-baselines.ts（新增）受管不可变基线存储
    .state/baselines/<id>/{files,manifest.json,complete}；prepare/record/verify/list/gc
  apps/server/src/command-executor.ts（新增）命令执行器
    project.bind 先异步准备基线再进事务；幂等摘要仍只绑定原请求
  apps/server/src/service.ts
    execute/dispatch 增加 prepared 入参；project.bind 缺基线时拒绝
    task.create 把契约的 workspaceMode 冻结到 Task
  apps/server/src/workspaces.ts
    snapshot() 改用共享扫描器；新增 snapshotFromBaseline()
  apps/server/src/worker.ts
    绑定存在时用冻结基线摘要，不再重扫源目录
    host + isolated：独立工作区 + patch；host + source：保留旧行为
    host-isolated 不再占用真实源目录的资源锁
  apps/server/src/project-manifest.ts：buildProjectManifest 复用同一扫描器
  packages/protocol：RoomBinding 增 baselineId/manifestAlgorithm；
    TaskContract 增 workspaceMode；Task/Run 增 workspaceMode、baselineId
  apps/server/src/app.ts：/api/commands 走执行器
  scripts/acceptance-parallel-tasks.ts、tests/project-binding.test.ts：改用同一异步执行器
  tests/host-isolated-workspace.test.ts（新增）2 个用例
变更前触发条件 / 变更后行为：
  变更前：project.bind 只保存摘要；运行时每次重新扫描可变源目录；
  本机直连任务直接在真实项目里改文件，无法并行。
  变更后：绑定会冻结一份受管基线；运行从基线物化独立目录；
  源目录在绑定后的改动不影响已冻结输入；host-isolated 产出可审阅的 patch。
接口/事件/迁移/兼容性：
  未新增事件类型或数据库迁移；ProjectBinding/Room 投影为可选字段，旧事件仍可重放
  旧绑定（无 baselineId）保持旧行为：运行时扫描当前源目录
执行命令、cwd、环境、开始结束、退出码：
  npm run typecheck                                   exit 0
  npx tsx --test tests/project-binding.test.ts        exit 0（6 pass / 0 fail）
  npx tsx --test tests/host-isolated-workspace.test.ts exit 0（2 pass / 0 fail）
  npm test                                           exit 0（451 pass / 0 fail）
  npm run acceptance:parallel -- --check             exit 0（全部检查通过）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-21 17:30–18:30 CST
实际覆盖的模式和失败分支：
  绑定冻结基线；绑定后改源目录不影响运行输入（新增用例直接断言工作区内容）；
  同一基线的两个 host-isolated 运行目录不同、源目录只读、产出 patch；
  legacy host-source 仍在真实目录执行并给出观察清单；
  未经准备基线的 project.bind 被拒绝
尚未验证项及明确原因：
  未覆盖：依赖产物叠入工作区前的冻结版本/hash 校验（当前 dependencyInputs
  已冻结依赖任务版本与 inputArtifacts，但尚未把产物内容叠入工作区；
  附件路径使用运行目录下的副本，不承诺工作区组合）；
  未覆盖：附着线程 + isolated 的 workspace_mode_unsupported（代码已显式拒绝，
  但真实附着模式需要 Codex 线程，本轮无该环境）
P02 后续补充（第 5 轮已覆盖）：
  基线 GC：ImmutableBaselines.gc(referenced, minAgeMs) 增加年龄下限；
  Worker.collectBaselines() 汇总 binding/run 引用并在 tick 中限频调用，
  新准备基线受年龄下限保护，避免与绑定提交竞态；
  旧绑定补建：Worker.repairLegacyBinding() 仅在当前 source 的 manifestHash
  与旧绑定一致时 prepare 基线并持久化 baselineId，否则抛 baseline_unavailable；
  执行命令：npx tsx --test tests/baseline-gc-repair.test.ts exit 0（3 pass / 0 fail）；
  npm test exit 0（468 pass / 0 fail）；2026-10-21 20:05–20:35 CST
下一张卡与依赖：P03（按 canonical 项目互斥与异步集成验收）
```

## P03 — 按 canonical 项目互斥与异步验收

```
卡号与状态：P03 / verified（P03 新增并发/异步用例全部通过；未覆盖项见下）
基线 SHA / 实现 SHA / dirty 与内容摘要：
  基线 03a5cb0（P02 提交）；实现见本次提交
修改文件和关键符号：
  apps/server/src/integration-runner.ts（新增）
    IntegrationRunner.tick()：按 createdAt 排队逐项尝试准入，一个项目忙不阻塞其它项目
    项目键使用 canonicalProjectKey()（realpath + Windows 大小写/分隔符规范化）
    验收命令改为异步 spawn：windowsHide、120s 超时、1 MiB 输出上限、AbortSignal
    超时/取消/正常退出都调用 killProcessTreeWithProof()；剩余进程 >0 或无证据时
    不释放项目租约，改为 quarantine
    update() 使用期望状态做短事务 CAS；apply 前重新读取 integration/room/artifact
    验收期间事件循环不被占用；Worker.close() 等待本 Runner 的 verifier
  apps/server/src/resource-manager.ts
    新增 canonicalProjectKey()；项目容量与 quarantine 检查改为全 store 范围，
    因此不同 room/binding 指向同一 source 时仍然互斥
  apps/server/src/worker.ts
    processIntegrations() 删除全局 active 阻塞，交给 IntegrationRunner；
    staging 清理保护 in-flight 与持久 validating/testing/applying/unknown/ready_to_apply 目录；
    hostProjectKey() 改用 canonicalProjectKey()
  scripts/acceptance-parallel-tasks.ts
    验收等待改为异步让出事件循环，避免同步 tick 循环饿死 verifier
  tests/integration-queue.test.ts
    11 个既有用例改为等待异步 integration 状态；覆盖原同步实现的全部语义
  tests/parallel-integration-runner.test.ts（新增）
    - 无关项目被阻塞时，另一个项目的 integration 照常完成
    - 两个不同项目的 verifier 在并发上限内真实重叠
    - 同一 source 跨 room 的 verifier 不重叠（项目锁全局互斥）
    - verifier 运行期间 HTTP 命令仍可正常返回
变更前触发条件 / 变更后行为：
  变更前：processIntegrations() 在 active.size>0 时直接 return；同一时间只跑一个
  集成且验收 spawnSync 阻塞 tick；资源租约查找只看单房间。
  变更后：tick 只做项目准入并立即返回；不同项目可并行验收，上限默认 2；
  同源跨房间仍然串行；验收进程超时/取消会清理整棵进程树并留下 proof。
接口/事件/迁移/兼容性：
  未新增协议事件或数据库迁移；integration 状态机沿用既有枚举。
  资源租约的跨房间查询会改变“同 key 不同房间可同时占用”的旧行为，属于 P03
  要求的修正；acquire/release/quarantine 事件结构不变。
执行命令、cwd、环境、开始结束、退出码：
  npm run typecheck                                         exit 0
  npx tsx --test tests/integration-queue.test.ts            exit 0（11 pass / 0 fail）
  npx tsx --test tests/parallel-integration-runner.test.ts   exit 0（4 pass / 0 fail）
  npm run acceptance:parallel -- --check                    exit 0（全部检查通过）
  npm test                                                  exit 0（455 pass / 0 fail）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-21 18:49–19:20 CST
证据路径：
  .state/parallel-room-image/p03-tests-20261021.log
  .state/parallel-room-image/p03-acceptance-20261021.log
实际覆盖的模式和失败分支：
  无关项目长时间占用；两个 verifier 并发重叠；同项目跨 room 串行；
  verifier 运行期间 HTTP 命令可返回；验收失败/拒绝后源目录不变；
  无 acceptance 的 quick path 直接 ready_to_apply；waiting 授权后再 apply；
  重复 integrate 幂等；daemon 重启时 applying/unknown 恢复
尚未验证项及明确原因：
  未覆盖：verifier argv/清单的冻结 manifest hash（计划归入 P04 的 verifierManifestHash）
  未覆盖：verifier 进程尚未纳入统一 CLI 进程硬顶，只由 maxConcurrentVerifications=2 限流
  未覆盖：进程树清理对“父进程已退出、子进程被重新挂接”的场景只能尽力扫描；
  失败时租约保持 active/quarantined，不会伪报 released
下一张卡与依赖：P04（staging 精确组合）
```

## P04 — staging 必须等于“当前受认可目标 + 本次候选”

```
卡号与状态：P04 / verified（4 个关键探针全部通过；未覆盖项见下）
基线 SHA / 实现 SHA / dirty 与内容摘要：
  基线 82ded5c（P03 提交）；实现见本次提交
修改文件和关键符号：
  apps/server/src/integration-staging.ts（新增）
    prepareIntegrationStaging()：扫描当前 source 目标 → 校验每个候选 change 的 before
    hash → 把目标完整文件集写入 staging → 叠候选 → 重新扫描得到 stagedManifestHash；
    allowedPaths 外的修改、before 不一致、越界路径显式拒绝
    targetManifestHash()/assertTargetUnchanged()/verifierManifestHash()/
    artifactSetHash()/workspaceManifestHash()
  apps/server/src/integration-runner.ts
    验证前：任务版本、候选 changes 摘要、当前目标摘要与可认可目标（最近 applied 的
    appliedTargetManifestHash 或 integration.baseManifestHash）比对；
    staging 由目标 + 候选组成，不再使用候选自己的旧 manifest 装配；
    持久化 verifiedTargetManifestHash / stagedManifestHash / appliedArtifactSetHash /
    verifierManifestHash；验证后 apply 前重新校验 source 目标、候选摘要、任务版本与
    verifier 声明；apply 后重算 source 摘要并与 stagedManifestHash 对账；
    applied 时写 appliedTargetManifestHash
  packages/protocol/src/integration.ts
    integrationSchema 增加可选 verifiedTargetManifestHash / stagedManifestHash /
    appliedTargetManifestHash / appliedArtifactSetHash / verifierManifestHash；
    旧事件缺字段仍可重放，新路径要求字段齐全
  apps/server/src/service.ts
    artifact.integrate 冻结 taskVersion / projectBindingId / baseManifestHash
  apps/server/src/worker.ts、workspaces.ts
    apply 接受 targetBeforeHash/targetAfterHash；journal.json 写入两摘要；
    artifact.applied 事件仍保持原有结构
  tests/parallel-task-integration.test.ts（新增）
    - A 先应用 a=1；B 在包含 A 的目标上验证“a=1,b=1”被冻结 verifier 拒绝，源目录 b 保持 0
    - 正常组合（verifier 接受 a=1,b=1）仍可应用，防止“一概禁止集成”
    - 验证后篡改 source 无关文件 → source_changed，不应用
    - 验证后篡改候选 changes → stale_artifact，不应用
    - 验证后篡改任务 verifier/version → stale_artifact，不应用
变更前触发条件 / 变更后行为：
  变更前：staging 用候选自己的旧 manifest 装配文件；只检查 touched paths；
  无法发现“A 已应用后 B 仍按旧目标验证”的组合错误。
  变更后：staging 以当前已认可目标为底，验证的是真正会应用的整体组合；
  源目录、候选、任务版本或 verifier 在验证后变化都会在 apply 前被拒绝。
接口/事件/迁移/兼容性：
  integrationSchema 仅新增可选字段，不新增事件类型或数据库迁移；
  旧 integration 无新字段时仍可读取，但应用前要求目标摘要齐全。
执行命令、cwd、环境、开始结束、退出码：
  npm run typecheck                                           exit 0
  npx tsx --test tests/parallel-task-integration.test.ts       exit 0（4 pass / 0 fail）
  npm run acceptance:parallel -- --check                      exit 0（全部检查通过）
  npm test                                                    exit 0（459 pass / 0 fail）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-21 19:00–19:40 CST
证据路径：
  .state/parallel-room-image/p04-tests-20261021.log
  .state/parallel-room-image/p04-acceptance-20261021.log
实际覆盖的模式和失败分支：
  单任务应用；A 后 B 的互斥组合失败；正常组合通过；应用后目标摘要与 journal 前后
  摘要一致；source/候选/verifier 三种验证后篡改；allowedPaths 外修改拒绝；
  before hash 冲突拒绝；artifact set hash 随应用集合变化
尚未验证项及明确原因：
  未覆盖：rollback 的完整目标摘要复核（当前 rollback 仍按 touched files 检查；
  下一步补齐 appliedTargetManifestHash 回滚链路）
  未覆盖：journal complete 与 SQLite applied 两份内容证据的崩溃对账（P04 #17）
  未覆盖：旧 integration 缺目标摘要时从有序 applied/rolled_back 记录补证
  （当前返回 recovery_required，要求重新验证）
  未覆盖：verifier 内容文件本身不可变副本（当前冻结并复核声明 hash；
  verifier 命令由 owner 提供的 argv 执行）
下一张卡与依赖：P05（双启动屏障和真实 Worker 派发）
```

## P05 — 双启动屏障和真实 Worker 派发

```
卡号与状态：P05 / verified
基线 SHA / 实现 SHA / dirty 与内容摘要：
  基线 507e949（P04 提交）；实现见本次提交
修改文件和关键符号：
  tests/helpers/controllable-adapter.ts（新增）
    createControllableAdapter()：deferred Promise 屏障，不使用 sleep 推测；
    adapter 被真实 Worker 调用时登记 runId/agentId/taskId/workspace/prompt/
    baselineHash；release()/fail()/releaseAll()；waitForEntered(count, timeout)
    由实际 adapter 进入事件 resolve；timeline 使用 hrtime ns
  tests/parallel-task-execution.test.ts（新增）
    - project.bind 冻结基线；两个任务经正常 task.create 入队
    - worker.tick() 后等待两个真实 adapter 进入；进入前断言没有 completed 任务、
      没有 artifact、两个 Run 都处于活动区间
    - 两个 cwd 不同且 baselineHash 相同；源目录未被修改
    - release 后 Worker 生成两个 patch artifact、Run 完成、任务 pending 验收
    - owner 依据实际 artifact 字节计算 SHA256 并 task.verification.record
    - artifact.integrate 经真实 integration queue 应用；最终源目录同时包含两份产物
  scripts/acceptance-parallel-tasks.ts（重写核心路径）
    删除 materialize() 伪执行主路径；改用同一可控 adapter 走真实 Worker 派发；
    报告记录 modelRequests:0、tasks/workspaces/timeline/artifacts/verifierHash、
    binding manifest hash 与 integration 结果
  tests/parallel-task-acceptance.test.ts（保持契约，验证新 fixture 全链路）
变更前触发条件 / 变更后行为：
  变更前：验收 fixture 直接调用 workspaces.snapshot()/publishArtifact() 模拟执行，
  只证明端到端拼装，不证明 Worker 真的并行派发。
  变更后：两个任务由真实 Worker 的 tick/execute 路径进入 adapter；只有两个
  adapter 都被进入后测试才释放，源码与工作区事实均由 Worker 产出。
接口/事件/迁移/兼容性：
  仅新增测试 helper 与验收路径；无协议、事件或迁移变更。
执行命令、cwd、环境、开始结束、退出码：
  npm run typecheck                                             exit 0
  npx tsx --test tests/parallel-task-execution.test.ts           exit 0（1 pass / 0 fail）
  npx tsx --test tests/parallel-task-acceptance.test.ts          exit 0（1 pass / 0 fail）
  npm run acceptance:parallel -- --check                        exit 0（全部检查通过）
  npm test                                                      exit 0（460 pass / 0 fail）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-21 19:40–20:05 CST
证据路径：
  .state/parallel-room-image/p05-tests-20261021.log
  .state/parallel-room-image/p05-acceptance-20261021.log
实际覆盖的模式和失败分支：
  两个 adapter 同时进入屏障；进入前无提前完成/产物；独立 isolated 工作区；
  源目录在运行期间不可见变化；owner 使用真实 artifact hash 验收；
  integration 队列应用两份 patch；--check 无模型请求
尚未验证项及明确原因：
  未覆盖：并发上限=1 时必须失败的反向检出力（列入 P06 第 1 项）
  未覆盖：真实 CLI/API 模型参与的双运行（本 fixture 使用确定性 adapter，
  modelRequests=0，符合本卡范围）
下一张卡与依赖：P06（M1 七项可失败用例）
```

## P06 — 将原 M1 七项逐一变成可失败的用例

```
卡号与状态：P06 / in_progress（1–6 的模拟切片已通过；第 7 项真实 CLI 对照待 V03）
基线 SHA / 实现 SHA / dirty 与内容摘要：
  基线 87485e6（P05 提交）；实现见本次提交
新增/修改文件：
  tests/parallel-task-dependencies.test.ts（新增）
    - 并发上限=1 时两次 adapter 进入必须失败：waitForEntered(2) 明确拒绝，
      同一时刻只有一个 Run 活动；释放后才串行进入第二个
    - 共同基线与隔离：两个 isolated 运行的 workspace 不同、baselineHash 相同，
      源目录 manifest 在运行前/后保持不变，A 的文件不出现在 B 的工作区
    - 局部失败/依赖：A 失败后其后继 C 不完成，独立 B 完成后 D 可推进；
      retry A 后 C 可重新推进；B 的 Run ID 与 artifact ID 保持不变
    - 相同 commandId 幂等；相同 commandId 不同内容明确报错
  tests/parallel-task-integration.test.ts（扩展）
    - 两个候选修改同一文件：A 应用成功，B 返回 apply_conflict；
      源文件保留 A 的结果，两份 patch 文件都保留，B 不标记 applied
  P04/P03/integration 既有用例提供：
    - 整体组合：正常组合可通过、互斥组合在 Worker verifier 路径失败
    - fence：旧任务版本/generation、目标变化、未知 journal 均不可 applied
    - 恢复：restart/incomplete journal/资源租约隔离
变更前触发条件 / 变更后行为：
  变更前：M1 的七项只有一次性验收脚本；没有“把并发调小/依赖失败/同文件冲突”
  这类反向探针，无法证明测试本身有检出力。
  变更后：至少 1/2/3/4/5/6 六项都有可失败断言或既有失败用例可追溯；
  第 7 项真实实验仍需按 V03 固定 CLI 执行，当前不作为已完成声明。
执行命令、cwd、环境、开始结束、退出码：
  npm run typecheck                                                exit 0
  npx tsx --test tests/parallel-task-dependencies.test.ts           exit 0（4 pass / 0 fail）
  npx tsx --test tests/parallel-task-integration.test.ts            exit 0（5 pass / 0 fail）
  npm test                                                         exit 0（465 pass / 0 fail）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-21 19:39–20:05 CST
证据路径：
  .state/parallel-room-image/p06-tests-20261021.log
实际覆盖的模式和失败分支：
  并发上限=1 反向检出力；共同基线/隔离/源目录不变；整体组合与互斥组合；
  A 失败/后继阻塞/B 独立推进/D 后继推进；A 修复后 B 的 Run/产物 ID 稳定；
  commandId 幂等与内容冲突；同文件冲突保留双方 patch；重启与未知 journal 恢复
尚未验证项及明确原因：
  第 7 项“真实实验与对照”未执行：需要按 V03 固定两个真实 CLI 版本并记录
  可观察执行区间；本卡当前只关闭模拟切片，不能宣称 P06 全量完成
下一张卡与依赖：V03（固定版本真实 CLI 与三组对照）；P06 剩余第 7 项依赖它
```

## R01 — Room schema、事件和迁移先定义清楚

```
卡号与状态：R01 / verified（schema/事件/迁移/生成物完成；R02/R03 的业务命令实现不在本卡）
基线 SHA / 实现 SHA / dirty 与内容摘要：
  基线 6af0d53（P02 补充提交）；实现见本次提交
修改文件和关键符号：
  packages/protocol/src/room.ts（新增）
    roomStatusSchema / roomDeletionSchema / roomSchema / normalizeRoom；
    roomConfigurePayloadSchema（name/description/members/expectedRevision）；
    roomDeletePayloadSchema（expectedRevision）
  packages/protocol/src/index.ts
    删除手写 Room 接口，改为从 room.ts 推导/导出；payloadSchemas 增加
    room.configure、room.delete
  packages/protocol/src/events.ts
    room 局部 schema 改为统一 roomSchema；注册 room.configured（携带完整
    room + addedMemberIds/removedMemberIds）与 room.deleting/deletion.updated/
    deleted（均为 room projector 的状态事件）
  apps/server/src/event-projections.ts
    room 投影加入前后状态检查：禁止 deleted→active、删除后接受配置、
    revision 倒退、deletion 请求身份变化；room.configured 的成员差集必须
    与 added/removedMemberIds 一致；旧事件仍按当时 payload 回放
  apps/server/src/service.ts
    room.create 显式写入 revision=1/status=active 并去重 members；
    room.configure/room.delete 已进入 command schema，但业务实现保留为
    显式 not_implemented（R02/R03 负责）
  apps/server/src/store.ts
    DATABASE_VERSION 16→18；修复 v11–v16 迁移嵌在 if(version<10) 内的问题，
    改为 v10/v11/.../v16/v17/v18 独立有序迁移；每步事务成功后推进 user_version
  scripts/schema.ts + packages/protocol/schema/**
    新增 room.schema.json 与 room.configured/deleted/deleting/
    deletion.updated 事件 schema；重新生成 command/event-registry 及相关事件 schema
变更前触发条件 / 变更后行为：
  变更前：Room 形状在 index.ts、events.ts、store 读取三处分散；没有状态事件，
  无法表达删除中/已删除；v11–v16 迁移在 v10 条件内，v10 数据库无法补齐新表。
  变更后：一个 roomSchema + normalizeRoom 读取默认；生命周期是独立状态事件；
  v10/v11/v16 数据库都能沿有序迁移到达 v18；旧事件字节不被重写。
接口/事件/迁移/兼容性：
  新字段 revision/status/deletion 均为可选，旧事件仍可重放；normalizeRoom
  只用于读取，不写旧事件。新增事件 schema、命令 schema；DATABASE_VERSION=18；
  旧客户端未传 expectedRevision 的 room.update/members.set 兼容行为保留到 R02。
执行命令、cwd、环境、开始结束、退出码：
  npm run typecheck                                             exit 0
  npx tsx --test tests/room-lifecycle.test.ts                    exit 0（5 pass / 0 fail）
  npx tsx --test tests/event-replay.test.ts                      exit 0（16 pass / 0 fail）
  npx tsx scripts/schema.ts                                     exit 0
  npm test                                                      exit 0（473 pass / 0 fail）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-21 20:05–20:35 CST
证据路径：
  .state/parallel-room-image/r01-tests-20261021.log
实际覆盖的模式和失败分支：
  旧 room 缺省字段 normalize；新房间 revision=1/status=active/成员去重；
  room.configured/停删/已删状态事件；deleted→active、删除后配置、revision 倒退、
  deletion 身份变化、成员差集不一致均被拒绝；snapshotAt 旧水位仍为 active；
  v10 fixture 升级到 v18；重复打开；较新版本拒绝；历史 room 事件字节不变
尚未验证项及明确原因：
  room.configure/room.delete 的真实事务行为、API/WS/SDK 语义与 UI 在 R02–R05；
  本卡只保证 schema/事件/迁移地基可用，不宣称房间设置/删除已对用户开放
下一张卡与依赖：R02（一个事务保存房间设置与成员）
```

## G01 — 修复两份外部 MCP，并防止副本漂移

```
卡号与状态：G01 / verified
基线 SHA / 实现 SHA / dirty 与内容摘要：
  基线 bf1f722a3c74ed23990fd00b6c9f402d89a943b8；实现见下方提交
修改文件和关键符号：
  scripts/sync-room-agent-plugin.mjs（新增）固定清单同步器，支持 --check
  tests/mcp-connector-contract.test.ts（新增）真实 stdio 契约测试
  package.json（新增 sync:room-plugin / check:room-plugin / test:mcp-connectors）
变更前触发条件 / 变更后行为：
  计划记载 scripts/room-agent-mcp.mjs:34 缺少逗号导致 SyntaxError。
  当前 HEAD 复核：两份文件 `node --check` 均 exit 0，语法缺陷已由既有提交修复；
  两份副本 SHA-256 当前一致（e6211aa908531e8c…）。
  但此前没有机制阻止再次漂移，也没有覆盖失败分支的契约测试。
  变更后：插件副本由同步脚本唯一产生；--check 在漂移时 exit 1；
  契约测试真实 spawn 两份 .mjs，覆盖 initialize/tools/list/ping、未知方法、未知工具、
  非法 JSON、超过帧上限、缺少 token，并断言 stdout 每行都是合法 JSON-RPC、stderr 不污染协议流。
接口/事件/迁移/兼容性：
  未改工具 schema、未改工具语义、未改服务端协议；同步器不读取任何用户 token
执行命令、cwd、环境、开始结束、退出码：
  node --check scripts/room-agent-mcp.mjs                                exit 0
  node --check plugins/tempt-room-claude/server/room-agent-mcp.mjs        exit 0
  npm run test:mcp-connectors                                             exit 0（15 pass / 0 fail）
  npm run check:room-plugin                                               exit 0
  漂移负例：人为追加一行后 `node scripts/sync-room-agent-plugin.mjs --check` exit 1，
            还原后再次 --check exit 0
  npm run typecheck                                                       exit 0
  cwd=仓库根，Windows PowerShell 5.1，2026-10-21 16:40–16:58 CST
报告与日志/截图路径、内容摘要：
  测试输出见上文命令；同步器输出 in-sync / drift / missing 状态与 SHA-256
实际覆盖的模式和失败分支：
  两份真实入口的 stdio 握手；未知方法 -32601；未知工具 -32603；
  非法 JSON 与 >1 MiB 帧不产生半写协议行、后续 ping 仍可应答；
  缺 token 明确失败且不泄露 fixture token；诊断只进 stderr
尚未验证项及明确原因：
  未验证真实房间服务上的 tools/call 往返（需要有效房间令牌，契约测试按设计不触网）
下一张卡与依赖：P01（依赖 P02 的不可变基线定义，本卡无前置）
```
