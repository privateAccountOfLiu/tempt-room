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
| R02 单事务保存房间设置与成员 | verified | 纯规划 + 单事件 room.configured；revision CAS、成员去重/校验、忙成员移除拒绝、闲置会话结束、legacy 命令复用；5 个用例通过 |
| R03 删除请求、停止执行与清理 | in_progress | afterCommit、短事务、finalizer、写入口拒绝、wake/input/inbox 清理、outbound delivery 在非 active 房间记录 aborted 且不再尝试；image-upload 失效由 Worker expireRoom 覆盖；全入口二次校验仍未系统覆盖 |
| R04 API、WebSocket、SDK 与列表语义 | verified | activeRooms/410/WS 终态/owner 导出/artifact 防绕过/RoomClient 命令/删除房间导入新身份 8 用例；room_wait 删除即时结束、两个真实 WS 窗口终态、两浏览器窗口删除同步均通过 |
| R05 房间设置与删除 UI | in_progress | 设置单命令/冲突保留+刷新按钮、新增 Agent 自动预选、设置内删除+二次确认、双浏览器窗口同步、最后房间空状态浏览器步骤均通过；取消删除/手机删除/忙成员细节仍待补 |
| I01 图片协议、工具参数与权限 | verified | images.ts 冻结分块/元数据/操作 ID；artifact 图片元数据；image 工具名与写权限映射；attachment-only 消息；7+3 个用例通过；真实上传实现归 I02/I05 |
| I02 有界可恢复的上传临时状态 | verified | image_uploads/parts 表 + migration 19、分块状态机、配额/TTL、原子落盘、缺失块检测、GC 与 Worker image 工具/删除房间失效接线完成；重启进程 E2E 仍由 I04 覆盖 |
| I03 解码验真、原图与安全预览 | verified | sharp 0.35.5 + 签名/结构检查 + 完整解码 + 1920 PNG 预览 + 原子落盘/稳定 artifactId；Worker 三个低层工具已接线并通过 3+3 用例；bridge/helper 归 I04 |
| I04 托管 bridge/host/AppContainer 传输 | in_progress | host pipe 固定图 smoke + AppContainer probe 已验证 bridge 在沙箱内 advertise `room_send_image`（sandbox probe 23/23 通过）；AppContainer 真图片上传仍 not_verified（`--mode sandbox` 明确不冒充） |
| I05 外部 MCP、插件与 SDK 发图 | in_progress | SDK、外部 MCP room_send_image、真实 stdio→HTTP 重试幂等、timeout/401/403/410 分类、两个独立 MCP 进程并发上传不同图通过 5 个用例；真实宿主手动发图待验证 |
| I06 安全内联路由与图片展示 | verified | 私有 `/api/artifacts/:id/image`（active/verified/hash/no-store）、缩略图、失败降级、键盘 Lightbox、纯图不渲染空 Markdown 已完成并通过 3 个接口用例与完整浏览器 E2E |
| I07 跨功能竞态 | in_progress | 9 个用例覆盖删房/移除成员/并行上传/丢回执/导出回放/删后审计/解码期间删房/托管 stale generation/最后房间 restart + 列表为空 + 旧图片 URL 410；删除与最终 project apply 并发仍未覆盖 |
| V01 开发/发布报告分模式 | in_progress | schemaVersion 2、sourceBefore/sourceAfter、tracked/working/untracked+lockfile hash、`--release --expected-head` 前置失败 not_run、source_changed 检测与 checksPassed/releaseEligible 已通过 5 个用例；CLI 入口已由 V02 preflight 接入，真实 clean release 运行待 CI |
| V02 CI/preflight 接入真实入口 | in_progress | preflight 改为 collaboration release/development 单次入口 + 连接器/并行/图片检查；外层 sourceBefore/After 与 releaseEligible/verdict；CI 传 github.sha、上传证据；本地 skip 模式 preflight PASS（development_only）；真实 release CI 运行待下次推送验证 |
| V03 固定版本真实 CLI 与三组对照 | not_started | |
| V04 文档、备份导入导出与统一口径 | in_progress | 备份/restore（水位+文件 hash+三类目录）、导出 omittedArtifacts、导入重验真/重生成 preview；10 个文档已补统一 24 卡口径与验证矩阵；真实 CI/V03 仍待 |

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

## R02 — 一个事务保存房间设置与成员

```
卡号与状态：R02 / verified
基线 SHA / 实现 SHA / dirty 与内容摘要：
  基线 c63c6d2（R01 提交）；实现见本次提交
修改文件和关键符号：
  apps/server/src/room-lifecycle.ts（新增）
    memberBusyReasons()：活动 Run / 活动 Task / 活动 Discussion / 未释放
    resource lease；纯校验，不写库
    planRoomConfiguration()：active 检查、expectedRevision CAS、成员去重与
    全局 Agent 存在校验、added/removed 计算、忙成员整体拒绝、无变化不追加事件
    retireRemovedMembers()：闲置 agent_session 发 agent_session.ended，
    相关 subscription 写 enabled=false
  apps/server/src/service.ts
    room.configure（human owner）：一次 Store.atomic 内完成规划、会话结束和
    单条 room.configured；返回 revision/changed/added/removed
    room.update / room.members.set：先构造完整输入复用同一规划与 busy/active
    校验；expectedRevision 可选，旧客户端省略时不宣传 CAS 保证
  packages/protocol/src/index.ts
    room.update / room.members.set 增加可选 expectedRevision；room.configure /
    room.delete 已在 R01 command schema 中
  apps/server/src/event-projections.ts
    生命周期守卫只在正向 live 追加时执行；rebuild 从旧事件重放时不会把已有
    新投影误判为 revision 倒退
  tests/worker-dispatch-fairness.test.ts
    该 fixture 故意跳过 R02 忙碌成员守卫，用直接事件模拟“成员在任务排队后
    消失”的场景，保留原调度断言
  tests/room-configuration.test.ts（新增）5 个用例
变更前触发条件 / 变更后行为：
  变更前：room.configure 只有 schema/事件地基，命令会 not_implemented；
  room.update/members.set 直接改投影对象，不校验 revision 与忙碌成员。
  变更后：一次配置 = 一次校验 + 一条 room.configured 事件；未知成员或忙碌
  移除会让名称/描述/成员全部回滚；聊天推进 seq 不造成 revision 假冲突；
  闲置成员移除后旧 actor 的 message.send 被拒绝。
接口/事件/迁移/兼容性：
  新事件 room.configured 携带 addedMemberIds/removedMemberIds；旧
  room.updated/room.members.updated 仍可回放，并复用同一规划（members.set
  事件附带 room 以保存 revision）。不自动 enqueue 新成员、不改现有 Discussion
  participants。room.delete 业务仍由 R03 实现。
执行命令、cwd、环境、开始结束、退出码：
  npm run typecheck                                                exit 0
  npx tsx --test tests/room-configuration.test.ts                    exit 0（5 pass / 0 fail）
  npx tsx --test tests/room-lifecycle.test.ts                        exit 0（5 pass / 0 fail）
  npm test                                                         exit 0（478 pass / 0 fail）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-21 20:35–21:05 CST
证据路径：
  .state/parallel-room-image/r02-tests-20261021.log
实际覆盖的模式和失败分支：
  名称+描述+加成员单事件成功；未知成员整体回滚；同 revision 第二窗口 409；
  聊天推进不产生假冲突；成员去重；空成员房间可保存；无变化不追加事件；
  忙成员移除拒绝且名称不变；闲置成员移除结束 session/订阅并拒绝旧 actor；
  加成员不消耗模型额度；rebuild 后名称/成员/revision 一致
尚未验证项及明确原因：
  R04 API/WebSocket/SDK 与 R05 UI 尚未接入 room.configure；
  R03 删除请求/清理；pending inbox/batch 的专用过期事件未新增，
  当前由会话/订阅终止与现有交付状态机处理
下一张卡与依赖：R03（删除请求、停止执行与持久清理）
```

## R03 — 删除请求、停止执行与持久清理（核心切片）

```
卡号与状态：R03 / in_progress（核心删除闭环已验证；计划中的 wake/input-batch/
delivery/image-upload 细节与全入口 assertActiveRoom 仍待补）
基线 SHA / 实现 SHA / dirty 与内容摘要：
  基线 8688d21（R02 提交）；实现见本次提交
修改文件和关键符号：
  apps/server/src/store.ts
    新增 afterCommit(fn)：事务内排队，rollback 丢弃，commit 后才执行；
    执行异常写入 afterCommitErrors，不反向伪装成命令回滚
  apps/server/src/ports/event-store.ts
    EventStore 增加可选 afterCommit 能力
  apps/server/src/room-lifecycle.ts
    planRoomDeletion()：owner/revision 校验、重复删除返回现有状态、
    room.deleting 的 next room（status=deleting/revision+1/deletion 请求身份）
  apps/server/src/service.ts
    room.delete 短事务：追加 room.deleting；取消 queued/running Run；
    失效外部租约 Task；停止 active/paused Discussion；结束 agent_session、
    禁用 subscription；queued/ready_to_apply integration 记 blocked；
    post-commit 通知 Worker（onRoomDeleting），不在提交前杀进程
    删除后业务写入口（execute、enqueue）拒绝 room_inactive；room.delete
    本身可重复调用返回 deleting/deleted
    cancel() 默认保持原 microtask 语义；删除路径显式使用 afterCommit
  apps/server/src/worker.ts
    service.onRoomDeleting 触发 tick；finalizeDeletions() 每 tick 扫描
    deleting 房间，检查 active/unknown Run、apply journal/integration、
    resource lease、pending input；干净时发 room.deleted（revision+1、
    deletedAt），否则限频去重发 room.deletion.updated pendingReasons
  tests/room-deletion.test.ts（新增）6 个用例
变更前触发条件 / 变更后行为：
  变更前：room.delete 只有 schema，命令 not_implemented；取消/清理只能靠
  microtask，进程重启后没有持久 finalizer。
  变更后：删除先持久化 request，再在 commit 后通知 Worker；Worker 每 tick
  都能继续清理（含重启后）；有未知进程/apply journal 时不得宣称已删除。
接口/事件/迁移/兼容性：
  复用 R01 的 room.deleting/room.deletion.updated/room.deleted 事件；
  无数据库迁移。afterCommit 是可选 Store 能力，旧 EventStore 实现可缺省。
执行命令、cwd、环境、开始结束、退出码：
  npm run typecheck                                            exit 0
  npx tsx --test tests/room-deletion.test.ts                     exit 0（6 pass / 0 fail）
  npm test                                                     exit 0（484 pass / 0 fail）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-21 21:05–21:35 CST
证据路径：
  .state/parallel-room-image/r03-tests-20261021.log
  .state/parallel-room-image/r03-cleanup-tests-20261021.log
实际覆盖的模式和失败分支：
  afterCommit commit/rollback；idle 房间删除幂等并 finalizer 落 deleted；
  deleting 后 message.send 拒绝；queued 工作取消；运行中进程阻止 finalizer，
  abort 后删除；applying integration 未解决时保持 deleting 并输出稳定
  pendingReason，人工标记 blocked 后才删除；pending wake 被 suppressed、
  input batch 与 inbox delivery 被 expired
尚未验证项及明确原因：
  outbound delivery 停止、pending 图片上传失效与容量释放尚未接入删除事务；
  所有业务入口的 assertActiveRoom（upload/tool/apply/staging/外部 room_wait）
  未逐一覆盖；迟到 adapter 输出在 commit 后的二次校验仍未系统化；
  room.delete API/WS/SDK/UI 属 R04/R05
下一张卡与依赖：R04（API、WebSocket、SDK 与列表语义）
```

## R04 — API、WebSocket、SDK 与列表语义（核心切片）

```
卡号与状态：R04 / in_progress（列表/410/WS 终态/SDK 命令已通过；导入导出与部分重连语义待补）
基线 SHA / 实现 SHA / dirty 与内容摘要：
  基线 622cefa（R03 清理提交）；实现见本次提交
修改文件和关键符号：
  apps/server/src/store.ts
    rooms()/room() 保持 raw 语义；新增 activeRooms() 与 requireActiveRoom()
    （deleted→room_deleted 410、deleting→room_deleting 409）
  apps/server/src/ports/event-store.ts
    可选 activeRooms/requireActiveRoom 端口能力
  apps/server/src/app.ts
    /api/rooms 只返回 activeRooms
    /api/rooms/:id、/snapshot：deleted 返回 410 room_deleted；deleting 仍可读，
      UI 可展示清理中状态
    /events：deleted 返回 410
    /audit/export：deleted 需显式 includeDeleted=1（仍走 owner 鉴权）
    /api/artifacts/:id 与 /preview：所属房间 deleted 时 410，不能凭 artifactId 绕过
    /api/agent/tool：房间 deleted 410、deleting 409，先于工具执行拒绝；
    worker.agentTool 的 room_wait 每次轮询检查 deleted/deleting 并立即返回
    WS 握手遇 deleted 以 1008 room_deleted 关闭；订阅中持久 room.deleting/
    room.deleted 先发送，再以 1000 关闭
  packages/client/src/index.ts
    新增 configureRoom(roomId,input,commandId?) / deleteRoom(roomId,revision,commandId?)
    底层仍走 /api/commands；WS 收到 room.deleted 或 room_deleted/room_deleting
    关闭原因时停止重连；REST 补拉遇到 room_deleted/410 也关闭为终态而不是无限重连
  apps/server/src/room-import.ts
    导入时丢弃源房间 deletion/status/revision 身份，创建 revision=1、status=active
    的新房间；room.deleting/deletion.updated/deleted 事件不进入导入事件流
  tests/room-api.test.ts（新增）7 个用例
  tests/room-import.test.ts（扩展）tombstone 导入身份用例
变更前触发条件 / 变更后行为：
  变更前：/api/rooms 返回 deleted/deleting 房间；snapshot/events/artifact URL
  对已删除房间仍可读；WS 删除后无限重连；客户端没有房间设置/删除方法。
  变更后：侧栏只列 active 房间；已删除房间普通读取 410；owner 历史导出需
  显式 includeDeleted；WS 先收到终态事件再停止；客户端停止对终态房间重连。
接口/事件/迁移/兼容性：
  复用 R01/R03 生命周期事件；无迁移。deleted 的 audit 导出仍需 owner 显式参数，
  Agent token 不因此获得历史读权限。
执行命令、cwd、环境、开始结束、退出码：
  npm run typecheck                                            exit 0
  npx tsx --test tests/room-api.test.ts                          exit 0（7 pass / 0 fail）
  npx tsx --test tests/room-import.test.ts                       exit 0（5 pass / 0 fail）
  npm test                                                     exit 0（492 pass / 0 fail）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-21 21:35–22:05 CST
证据路径：
  .state/parallel-room-image/r04-tests-20261021.log
  .state/parallel-room-image/r04-final-tests-20261021.log
实际覆盖的模式和失败分支：
  active 列表过滤；deleting snapshot/events 可读、deleted 410；owner audit
  includeDeleted；artifact 下载/预览防绕过；最后房间删除后重启不重建 seed；
  RoomClient configure/delete 命令；WS 收到 room.deleting 后关闭不重连；
  已删除房间导出再导入后是新 active 身份，删除事件不随导入保留
尚未验证项及明确原因：
  /api/agent/tool 中 room_wait 在等待期间房间被删除时立即结束（当前等待逻辑
  尚未监听删除事件）；RoomClient 的 REST gap 遇 410 停止重连仅对直接 events
  抛错可感知，未做端到端故障注入；
  room-import/export 的 lifecycle 与图片引用映射（R04 #13/#14）未实现；
  房间设置/删除 UI 属 R05
下一张卡与依赖：R05（房间设置和删除 UI）
```

## R05 — 房间设置和删除 UI（核心切片）

```
卡号与状态：R05 / in_progress（设置单命令、错误保留、删除确认、空状态通过现有浏览器 E2E）
基线 SHA / 实现 SHA / dirty 与内容摘要：
  基线 77dc1b1（R04 收尾提交）；实现见本次提交
修改文件和关键符号：
  apps/web/src/main.tsx
    RoomForm 保存 existing.revision；打开/切换房间时重置 name/description/members
    设置保存改为单条 room.configure（不再顺序 room.update + room.members.set）
    revision_conflict / member_busy / 其他错误保留表单并在 Modal 内展示
    成员区显示已选人数、provider、connectionMode、启用状态；提供“新增 Agent”
    设置底部增加删除区：明确说明“从列表移除、停止后续活动、历史保留审计”，
    二次确认显示房间名与当前活动数；删除期间禁用按钮
    新增 afterRoomDeleted()：递增 generation、注销旧订阅、清 snapshot/streaming/
    draft/mentions/reply/attachments，重新获取 activeRooms，选择下一房间并更新 URL；
    无剩余房间时进入空状态与“创建房间”，不渲染旧消息
  tests/browser E2E
    沿用现有房间设置/邀请/移除成员流程并通过；UI 设置保存现在走 room.configure
变更前触发条件 / 变更后行为：
  变更前：设置保存是两个顺序命令，失败会留下半更新；没有删除 UI；删除后页面
  可能继续渲染旧房间并异步切回。
  变更后：设置一次命令提交、失败保留表单；删除有明确确认与活动提示；删除响应后
  清空旧状态并切到剩余房间，最后房间显示空状态。
接口/事件/迁移/兼容性：
  只改 Web UI；命令通过 R02 的 room.configure 与 R03 的 room.delete。
执行命令、cwd、环境、开始结束、退出码：
  npm run typecheck                                            exit 0
  npm run test:browser                                        exit 0（现有 45 项 UI/浏览器步骤全部通过）
  npm test                                                    exit 0（492 pass / 0 fail）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-21 22:10–22:40 CST
证据路径：
  .state/parallel-room-image/r05-browser-20261021.log
  .state/parallel-room-image/r05-tests-20261021.log
实际覆盖的模式和失败分支：
  房间改名/邀请/移除成员后设置保存；Modal 错误提示路径（代码保留表单）；
  删除确认 UI 与 activityCount；删除后切房间/空状态代码路径；
  现有移动端房间设置与手风琴布局通过
尚未验证项及明确原因：
  “新增 Agent 后自动把新 ID 加入待保存 members”未实现（当前新增 Agent 会关闭
  设置，需重新打开设置并勾选）；
  删除流程未加入 browser-e2e 自动断言；双窗口同时打开的删除同步未做浏览器级
  验收；revision_conflict/member_busy 的真实双窗口交互未自动化；
  设置/删除的完整浏览器验收（取消删除、最后房间、手机删除）仍待补
下一张卡与依赖：I01（图片协议、工具参数与权限）
```

## I01 — 冻结协议、工具参数与统一权限

```
卡号与状态：I01 / verified（真实上传状态机与连接器便利工具分别归 I02/I05）
基线 SHA / 实现 SHA / dirty 与内容摘要：
  基线 dbc61c0（R05 提交）；实现见本次提交
修改文件和关键符号：
  packages/protocol/src/images.ts（新增）
    IMAGE_CHUNK_BYTES=192 KiB、base64 上限 262144、单图 1 B–10 MiB；
    imageUploadBegin/Chunk/Complete 严格 schema；规范 base64 + 解码字节校验；
    imageMetadataSchema（verified=true/width/height/alt/preview hash+size）；
    roomSendImageArgsSchema 仅连接器本地使用，不接受 actor/roomId/pathToWrite；
    imageOperationIds(root) 派生 begin/part:index/complete/post 四类稳定 ID；
    begin/complete result 类型
  packages/protocol/src/index.ts
    导出 images 协议与类型；roomToolNames/agentToolNameSchema 增加
    image_upload_begin/chunk/complete；message.send 允许空 text，
    superRefine 要求非空正文或至少一个附件
  packages/protocol/src/models.ts
    artifactSchema 增加可选 contentHash/image；Artifact 接口同步
  apps/server/src/tool-authorization.ts
    image 三个低层工具加入 writeTools（与 room_post 同一写权限）；
    dataBase64 不进入通用 path 检查，避免把 base64 当路径
  apps/server/src/service.ts
    message.send 使用 payloadSchemas 的 attachment-only 规则；
    附件必须同房间；已验真图片附件检查；纯图片 @ 唤醒使用“图片消息”prompt
  apps/server/src/worker.ts
    room_post 允许 attachments/replyTo/空 text（superRefine 非空正文或附件）；
    image 三个低层工具在当前阶段返回明确 image_upload_unavailable(503)，
    等 I02 接上真实状态机
  apps/web/src/main.tsx
    roomToolLabels 增加三个图片工具显示名
  scripts/schema.ts + packages/protocol/schema/**
    新增 image-metadata/image-upload-*/room-send-image-args schema；
    artifact/agent-tool-call/command 等重新生成
  tests/image-protocol.test.ts（新增 7 个用例）
  tests/image-message.test.ts（新增 3 个用例）
变更前触发条件 / 变更后行为：
  变更前：没有图片上传协议、图片 artifact 元数据或 image 工具权限；
  message.send 必须有非空正文，纯图片消息无法表达。
  变更后：低层图片操作有严格 bounded schema 和稳定 operation ID；
  image 写权限与 room_post 一样受 preToolGate/run fence 约束；
  artifact 可携带 verified 图片元数据；纯图片消息可发布。
接口/事件/迁移/兼容性：
  不新增表/迁移或 image message kind；仍用 artifact.created +
  chat.message.created；旧 artifact 无新字段可回放；旧 text-only 消息兼容。
执行命令、cwd、环境、开始结束、退出码：
  npm run typecheck                                            exit 0
  npx tsx --test tests/image-protocol.test.ts                    exit 0（7 pass / 0 fail）
  npx tsx --test tests/image-message.test.ts                     exit 0（3 pass / 0 fail）
  npm test                                                     exit 0（502 pass / 0 fail）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-21 22:40–23:10 CST
证据路径：
  .state/parallel-room-image/i01-final-tests-20261021.log
实际覆盖的模式和失败分支：
  文件大小/哈希/不安全文件名/保留设备名；规范 base64/分块上限/index 越界；
  complete 不接受新参数；稳定操作 ID 长度与唯一性；artifact 旧/新元数据；
  image 工具写权限拒绝未验证能力；attachment-only / 空消息 / 跨房间附件；
  纯图片消息正文保持空字符串
尚未验证项及明确原因：
  低层上传的真实分块状态机、解码验真与落盘属 I02；
  room_send_image 连接器便利工具、外部 MCP/插件属 I05；
  讨论运行中图片消息的完整副作用（只允许总结人发布文本报告的限制）
  仍需在 I02/I04 后做端到端回归
下一张卡与依赖：I02（有界、可恢复的上传临时状态）
```

## I02 — 有界、可恢复的上传临时状态

```
卡号与状态：I02 / in_progress（上传状态机与持久临时状态已完成；工具/API 接线与定时 GC 待补）
基线 SHA / 实现 SHA / dirty 与内容摘要：
  基线 406a977（I01 提交）；实现见本次提交
修改文件和关键符号：
  apps/server/src/image-uploads.ts（新增）ImageUploads
    .state/uploads/<uploadId>/parts/ 原子写入（tmp + rename），不 append；
    begin：room active / agent enabled、external operation_key（room+agent+root）、
      metadata_hash 冲突 409、每 Agent 2 / 每房间 4 个 pending、房间 32MiB /
      全局 128MiB 待传字节硬顶、30 分钟 TTL、uploadId 不含用户路径
    chunk：严格重查 room/agent/run fence/state/TTL；index/size/hash 校验；
      相同 index+hash+len 幂等、不同内容 409；DB/文件两侧不一致分别
      补记或返回 chunk_missing；每 upload 内存互斥
    complete：全部块存在且逐块 hash/长度校验、总字节与整图 SHA256 校验；
      状态条件更新为 completed；不在此步解码图片（I03）
    abort/expire 释放 pending 配额；gc 清理过期/终态上传目录，
      completed receipt 不随 pending parts 过早删除；删除前检查 canonical 根
  apps/server/src/store.ts
    DATABASE_VERSION 18→19；新增 migration 19 image_uploads /
    image_upload_parts operational 表与 expiry 索引；不进入可回放投影
  tests/image-uploads.test.ts（新增 5 个用例）
变更前触发条件 / 变更后行为：
  变更前：图片上传只有协议和 503 占位，没有可恢复的服务器端状态。
  变更后：服务器持有有界、可恢复的 pending 上传记录与分块元数据；
  崩溃后可按 uploadId 补块；配额与 TTL 在 begin/chunk 重查并只能释放一次。
接口/事件/迁移/兼容性：
  新增两张 operational 表，不属于 event-sourced projection；不新增事件类型；
  重放 artifact/message 不依赖 pending 上传；completed 上传保留可恢复 receipt。
执行命令、cwd、环境、开始结束、退出码：
  npm run typecheck                                            exit 0
  npx tsx --test tests/image-uploads.test.ts                     exit 0（5 pass / 0 fail）
  npm test                                                      exit 0（507 pass / 0 fail）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-21 23:10–23:40 CST
证据路径：
  .state/parallel-room-image/i02-tests-20261021.log
实际覆盖的模式和失败分支：
  begin 幂等/元数据冲突；chunk 顺序/长度/hash/index/重复；complete 缺块/
  整图摘要不一致；跨 Agent/跨 room/fence 变化；quota 上限与 abort/过期释放；
  DB 有记录文件缺失；文件存在 DB 未记账的补记
尚未验证项及明确原因：
  Worker 的 image_upload_* 工具与 owner HTTP 上传路由尚未接线（当前仍返回
  503）；定时 GC 尚未接入 Worker tick；I03 的图片解码/验真/预览落盘未实现；
  重启后完整恢复流程只覆盖模块级件，未做进程重启 E2E
下一张卡与依赖：I03（实际解码验真、原图与安全预览落盘）
```

## I03 — 实际解码验真、原图与安全预览落盘

```
卡号与状态：I03 / in_progress（解码/验真/预览/落盘主路径完成；Worker/API 接线与 I02 GC 待补）
基线 SHA / 实现 SHA / dirty 与内容摘要：
  基线 c9d5ee1（I02 提交）；实现见本次提交
修改文件和关键符号：
  package.json / package-lock.json
    新增 sharp@0.35.5（libvips 8.18.7）；提交 lockfile，不手改依赖图
  apps/server/src/image-validation.ts（新增）
    detectStaticImageType：PNG 签名 + 标准 chunk 遍历（拒绝 acTL）、JPEG SOI、
      RIFF/WEBP（拒绝 VP8X 动画位与 ANIM/ANMF）、拒绝 SVG/XML/HTML；
    validateAndPreview：sharp({failOn:'warning', limitInputPixels:16M})，
      完整解码 metadata + 实际像素解码，格式必须与签名一致，pages<=1，
      width/height 正整数且最长边<=8192；生成最长边<=1920 的静态 PNG 预览
      （rotate 应用方向、不放大），限制预览字节；最多 2 个并发解码、队列上限
  apps/server/src/artifact-files.ts（新增）
    artifact/preview 受管路径；tmp+rename 安装原图与预览；已存在同 ID 文件
    只按 SHA256 复用，不同内容 409；删除前检查 canonical 根
  apps/server/src/image-uploads.ts
    complete 保存 complete.bin 并支持已完成幂等返回；
    finalize：校验完成文件 hash，await 解码/预览，await 后重查 room active/
    agent enabled/member，稳定 artifactId（uploadId+contentHash 派生），
    安装原图+预览文件后在短 Store.atomic 内写 artifact.created 并记账
  tests/image-validation.test.ts（新增 3 个用例）
变更前触发条件 / 变更后行为：
  变更前：I02 只验证分块和整图 hash，不确认字节是真实静态图片，也没有预览。
  变更后：服务端用真实解码器验真，拒绝动画/伪装/损坏/超像素；原图和
  安全预览以受管文件名落盘，artifact 只引用服务端计算的 hash 与尺寸。
接口/事件/迁移/兼容性：
  无新事件/迁移；artifact.created 继续使用既有事件，新增 contentHash/image
  可选元数据；pending 上传完成前不产生可见 artifact。
执行命令、cwd、环境、开始结束、退出码：
  npm run typecheck                                            exit 0
  node -e "require('sharp')"                                    exit 0（libvips 8.18.7）
  npx tsx --test tests/image-validation.test.ts                   exit 0（3 pass / 0 fail）
  npm test                                                      exit 0（510 pass / 0 fail）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-21 23:40–00:10 CST
证据路径：
  .state/parallel-room-image/i03-tests-20261021.log
实际覆盖的模式和失败分支：
  静态 PNG/JPEG/WebP 真解码；原图+PNG 预览落盘与 hash 一致；重复 finalize
  复用同一 artifactId 且只发一次 artifact.created；APNG acTL、动画 WebP、
  截断 PNG、SVG 文本均被拒绝；解码期间房间进入 deleting 时拒绝提交
尚未验证项及明确原因：
  Worker image_upload_begin/chunk/complete 工具与 owner HTTP 上传路由仍未接线；
  I02 的定时 GC 尚未接入 Worker tick；并发解码队列/磁盘满/SQL rollback 的
  失败注入未做；I04/I05 的托管/外部传输与房间消息发布仍待实现
下一张卡与依赖：I04（托管 bridge、host 和 AppContainer 传输）
```

## I04 — 托管 bridge、host 和 AppContainer 传输（核心切片）

```
卡号与状态：I04 / in_progress（Worker 低层工具与托管/外部身份已接通；bridge helper/toolchain/pipe smoke 待补）
基线 SHA / 实现 SHA / dirty 与内容摘要：
  基线 ea006e2（I03 提交）；实现见本次提交
修改文件和关键符号：
  apps/server/src/worker.ts
    新增 imageUploads（ImageUploads 实例）；tick 每 5 分钟调用 imageUploads.gc()；
    finalizeDeletions 对 deleting 房间调用 expireRoom() 立即失效 pending 上传；
    managed executeTool 新增 image_upload_begin/chunk/complete：
      复用现有 active/run fence/tool policy/authorization/consumeToolCall 检查；
      begin 的 rootOperationId/identity 由服务端 run/fence 派生，客户端不能覆盖；
      chunk 用 imageUploadChunkSchema 解析 base64 后交给公共 ImageUploads；
      complete 走 finalize（解码/落盘/短事务 artifact.created）；
    external agentTool 新增同样三个低层工具，identity 为 token 绑定的
      room+agent，不接收 run/generation/path；
    低层成功/失败都记录 run.tool.completed（不写 base64）
  tests/managed-image-tools.test.ts（新增 3 个用例）
变更前触发条件 / 变更后行为：
  变更前：image 工具只有 503 占位；I02/I03 的上传/解码能力不能被 Agent 调用。
  变更后：托管运行和外部连接器都可按 begin→chunk→complete 发图；
  身份/fence 由服务器绑定，重复 complete 返回同一 artifact 且不重复事件。
接口/事件/迁移/兼容性：
  仅使用 I02 的 operational 表与 I03 的 artifact 文件/元数据；无新迁移；
  bridge/MCP 的 room_send_image 便利编排尚未实现（I05）。
执行命令、cwd、环境、开始结束、退出码：
  npm run typecheck                                            exit 0
  npx tsx --test tests/managed-image-tools.test.ts              exit 0（3 pass / 0 fail）
  npm test                                                      exit 0（513 pass / 0 fail）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-22 00:10–00:35 CST
证据路径：
  .state/parallel-room-image/i04-wire-tests-20261021.log
实际覆盖的模式和失败分支：
  外部 Agent 三段式上传成功并产出 verified artifact；错误 chunk hash 拒绝；
  换 Agent 复用 uploadId 拒绝且不产 artifact；重复 complete 幂等；
  managed 分支代码复用 run fence 与工具权限检查
尚未验证项及明确原因：
  scripts/room-image-transfer.mjs 尚未新增；room-bridge/toolchain/Claude
  插件副本未包含 helper；真实 HostRoomPipe/AppContainer 分块 smoke 未跑；
  managed executeTool 的端到端 pipe 调用未做自动化（代码路径已接线）；
  room_post 的 attachments/replyTo 便利编排与消息发布仍归 I05/D04
下一张卡与依赖：I05（外部 MCP、Claude 插件与浏览器可用 SDK）
```

## I05 — 外部 MCP、Claude 插件与浏览器可用 SDK（SDK 切片）

```
卡号与状态：I05 / in_progress（SDK 上传/发图完成；外部 MCP 便利工具与插件同步待补）
基线 SHA / 实现 SHA / dirty 与内容摘要：
  基线 9ebe3b4（I04 提交）；实现见本次提交
修改文件和关键符号：
  packages/client/src/image-upload.ts（新增）
    uploadImage(send, bytes, options)：浏览器/Node 通用 Uint8Array，
      Web Crypto SHA-256、分块 base64（无 String.fromCharCode(...spread)）、
      begin→chunk→complete，stable commandId 由 imageOperationIds 派生，
      支持 AbortSignal；错误保留 stage/commandId，可按阶段重试
    sendImage：上传成功后再用 attachments 调 room_post；成功返回 posted 阶段
      与 artifactId/messageId；room_post 失败保留 artifactId 供补发
  packages/client/src/index.ts
    export uploadImage/sendImage/ImageUploadError 与类型；
    RoomAgentClient 新增 uploadImage()/sendImage()，内部复用同一 sender，
    不引入 node:fs/node:path，不暴露本地 path
  packages/client/README.md
    浏览器 File.arrayBuffer 发图最小示例
  tests/sdk-image-upload.test.ts（新增 4 个用例）
变更前触发条件 / 变更后行为：
  变更前：浏览器 SDK 与 Agent 客户端只能发文本/附件 ID，不能上传图片字节。
  变更后：浏览器或外部连接器可将 Uint8Array 按 192 KiB 分块上传，服务端
  负责解码验真；同一 operationId 重试使用完全相同的 commandId，不重复发图。
接口/事件/迁移/兼容性：
  仅 client 包接口与类型；协议沿用 I01 的低层工具；无服务端迁移。
执行命令、cwd、环境、开始结束、退出码：
  npm run typecheck                                            exit 0
  npx tsx --test tests/sdk-image-upload.test.ts                 exit 0（4 pass / 0 fail）
  npm test                                                      exit 0（517 pass / 0 fail）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-22 00:35–01:00 CST
证据路径：
  .state/parallel-room-image/i05-sdk-tests-20261021.log
实际覆盖的模式和失败分支：
  begin/分块/complete 顺序；分块长度与 sha256；同一 operationId 跨调用稳定
  commandId；sendImage 只发一条 attachment 消息；complete 失败 stage/commandId；
  AbortSignal 提前取消；浏览器不传 path/owner token
尚未验证项及明确原因：
  scripts/room-image-transfer.mjs 与 room-agent-mcp 的 room_send_image 便利
  工具尚未实现；Claude 插件副本与 sync-room-agent-plugin --check 未包含 helper；
  真实 stdio→HTTP→Worker SDK 并发/丢回复 e2e 未做；I06 的图片展示路由仍待实现
下一张卡与依赖：I06（安全内联路由与图片消息展示）
```

## I06 — 安全内联路由与图片消息展示

```
卡号与状态：I06 / verified
基线 SHA / 实现 SHA / dirty 与内容摘要：
  基线 03cf6fe（I05 SDK 提交）；实现见本次提交
修改文件和关键符号：
  apps/server/src/app.ts
    新增 GET /api/artifacts/:id/image：
      owner cookie/bearer 鉴权不变；仅该精确 GET 豁免 Room-Protocol-Version；
      房间必须 active（deleting/deleted 410）；artifact.image.verified 必需；
      只读受管 <id>.preview.png，校验 previewSize + SHA256；
      Content-Type:image/png、nosniff、inline、same-origin、
      Cache-Control: private,no-store；不读客户端 previewPath
    原图下载保持 octet-stream + attachment
  packages/protocol/src/images.ts
    imageOperationIds 改为内置同步 SHA-256，移除 node:crypto，
    解决浏览器 Vite 将 node:crypto 外置导致应用壳空白
  apps/web/src/attachments.tsx（新增）
    MessageAttachments：按 artifactId 查 metadata；verified image 渲染
    lazy/async 缩略图；非图片或预览失败仍走原文件按钮；onError 降级为
    “预览不可用”文件卡且不重复设 src
    ImageLightbox：role=dialog、Escape、焦点返回、下载原图、关闭；
    img 使用 /api/artifacts/<encoded-id>/image，width/height 保留比例
  apps/web/src/main.tsx
    接入 MessageAttachments；纯图片消息不渲染空 Markdown 段；图文先正文再附件
  apps/web/src/workbench.css
    缩略图最大边距/比例、移动端不溢出、lightbox 居中布局
  tests/artifact-image.test.ts（新增 3 个用例）
变更前触发条件 / 变更后行为：
  变更前：图片只能作为附件下载，不能内联展示；协议模块在浏览器构建失败。
  变更后：已验真图片可通过私有同源路由内联展示、放大和下载；
  deleting/deleted 房间、未验真/预览损坏均明确失败；浏览器应用恢复可用。
接口/事件/迁移/兼容性：
  新增只读 HTTP 路由；无事件/迁移；旧 owner image/* 无 verified 元数据继续
  显示下载卡片；CSP 仍只允许 self 图片。
执行命令、cwd、环境、开始结束、退出码：
  npm run typecheck                                            exit 0
  npx vite build                                               exit 0
  npx tsx --test tests/artifact-image.test.ts                    exit 0（3 pass / 0 fail）
  npm test                                                      exit 0（520 pass / 0 fail）
  npm run test:browser                                         exit 0（全部 UI 步骤通过）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-22 01:00–01:35 CST
证据路径：
  .state/parallel-room-image/i06-final-tests-20261022.log
  .state/parallel-room-image/i06-browser-20261022c.log
实际覆盖的模式和失败分支：
  私有 PNG 响应头/无协议头请求；匿名 401；未验真 415；deleting 房间 410；
  预览损坏 410 且原图下载仍为 attachment；Vite 生产构建；完整浏览器回归
尚未验证项及明确原因：
  浏览器 E2E 尚未自动构造已验真图片消息来点击缩略图/Lightbox/键盘关闭；
  cookie 过期与伪图文件降级未做浏览器级断言；多图/透明/竖图布局未做视觉快照
下一张卡与依赖：I07（跨功能竞态）
```

## I07 — 图片链路跨功能竞态

```
卡号与状态：I07 / in_progress（6 类竞态 + 本地验收通过；剩余组合待补）
基线 SHA / 实现 SHA / dirty 与内容摘要：
  基线 87f2292（I06 提交）；实现见本次提交
修改文件和关键符号：
  apps/server/src/image-uploads.ts
    assertUsable 增加 Agent enabled、当前房间 member 检查；expireRoom 直接
    条件更新 pending 状态并释放配额，不依赖旧 uploadId 绕过权限变化
  tests/room-image-races.test.ts（新增 6 个用例）
    1) begin 后 room.deleting：chunk 拒绝、expireRoom 释放预约、无图片消息；
    2) 移除上传成员：旧 uploadId 的 chunk 被 forbidden 拒绝；
    3) 两个成员并行上传：块/artifact/hash 不串线；
    4) message.send 丢回执后同 commandId 重试：只一条消息；
    5) 事件导出/回放：含 artifact 图片元数据与 message 引用，无 base64、
       本地 state root、complete.bin；preview hash 与文件一致；
    6) 完成上传后删除房间：artifact 审计元数据保留，房间进入 deleting
  scripts/acceptance-room-images.ts（新增）
    --check：固定 PNG，本地 Store + ImageUploads，零模型/零网络，
    验证 artifact/verified 元数据/分块/预览 hash/attachment 消息/
    事件无 base64 与本地路径/新 schema 存在
  package.json
    新增 `acceptance:room-images` 脚本
变更前触发条件 / 变更后行为：
  变更前：上传开始后删除房间、移除成员或并行上传缺少系统化回归；
  没有独立的图片验收命令。
  变更后：权限变化在每次 chunk/complete 重查并立即生效；并行上传隔离；
  本地一条命令可重复验证图片消息主链路且不请求模型。
接口/事件/迁移/兼容性：
  无新事件/迁移；仅加强 operational 上传检查与测试/验收脚本。
执行命令、cwd、环境、开始结束、退出码：
  npm run typecheck                                            exit 0
  npx tsx --test tests/room-image-races.test.ts                 exit 0（6 pass / 0 fail）
  npm run acceptance:room-images                               exit 0（ok=true, modelRequests=0）
  npm test                                                      exit 0（526 pass / 0 fail）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-22 01:35–02:05 CST
证据路径：
  .state/parallel-room-image/i07-tests-20261022.log
实际覆盖的模式和失败分支：
  删房后 pending 上传拒绝与配额释放；成员移除后旧 uploadId 失效；双成员并行；
  post 丢回执幂等；audit 导出无敏感/二进制；删房后 artifact 元数据保留；
  固定图本地验收
尚未验证项及明确原因：
  complete 解码 await 期间删除（I03 已覆盖单例，但未做可控延迟注入）；
  托管 Run 取消/任务版本/generation 变化的端到端图片提交未测；
  删除与最终 project apply 并发、最后房间删除后 restart/重建列表未纳入本卡；
  host/sandbox 真管道与 external stdio transport 证据仍由 I04/I05 补
下一张卡与依赖：V01（开发/发布报告分模式）
```

## V01 — 开发报告与发布报告分模式

```
卡号与状态：V01 / in_progress（报告模型/CLI/校验完成；真实 release 命令入口待接 preflight）
基线 SHA / 实现 SHA / dirty 与内容摘要：
  基线 5417ef3（I07 提交）；实现见本次提交
修改文件和关键符号：
  scripts/verify-collaboration-baseline.ts（重构）
    SourceSnapshot：head/dirty/status/gitOk/gitError/trackedTreeHash/
    workingContentHash/untrackedManifestHash/lockfileHash/generatedAt；
    使用 git ls-files -z / --others --exclude-standard -z，按路径+类型+字节数+
    SHA256 生成 manifest，不使用空格拆文件名；Git 失败记录 source_unknown；
    VerificationReport schemaVersion 2：mode/sourceBefore/sourceAfter/
    sourceStable/checksPassed/releaseEligible/releaseBlockers；
    `--release --expected-head <40hex>`：HEAD 缺失/格式错误/不匹配、dirty、
    git 失败时所有命令记录 not_run 且 exitCode=null，不把“没跑”当通过；
    命令结束后重新 capture，HEAD/tracked/working/untracked/lockfile 任一变化
    则 releaseEligible=false/exit 1；development 模式允许 dirty，
    但 checksPassed/ok 仍严格根据命令结果；
    parseVerifyArgs 拒绝未知参数和缺失 expected-head
  tests/verification-report.test.ts（重写 5 个用例）
变更前触发条件 / 变更后行为：
  变更前：报告只有 statusHash，无法区分 git 失败与 clean；dirty 树也可生成
  单一 ok；没有 release 模式或 expected-head，命令 not_run 无法表达。
  变更后：开发/发布两套明确判定；release 绑定完整 HEAD、干净树和执行前后
  源码内容一致；not_run/失败/源码变化都使 release 失败。
接口/事件/迁移/兼容性：
  新报告 schemaVersion=2；保留 schemaVersion 1 的 source 兼容字段；
  CLI 默认仍是 development，不带 --release 时不要求 clean/expected-head。
执行命令、cwd、环境、开始结束、退出码：
  npm run typecheck                                            exit 0
  npx tsx --test tests/verification-report.test.ts              exit 0（5 pass / 0 fail）
  npm test                                                      exit 0（529 pass / 0 fail）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-22 02:05–02:30 CST
证据路径：
  .state/parallel-room-image/v01-tests-20261022.log
实际覆盖的模式和失败分支：
  开发模式成功/失败；release clean+expected-head 成功；dirty 失败并 not_run；
  expected-head 不匹配；repo 内容执行后变化；未知/缺失 CLI 参数
尚未验证项及明确原因：
  真实 `--release` 命令集（typecheck/test/replay）未在本轮执行，因为当前树
  仍 dirty 且 release 要求 clean；expected-head 参数尚未接入 npm preflight
  脚本/CI；schemaVersion 1 旧报告读取兼容路径未做读取器测试
下一张卡与依赖：V02（CI/preflight 接入真实入口）
```

## V02 — CI/preflight 接入真实入口

```
卡号与状态：V02 / in_progress（preflight/CI/依赖接线完成；真实 GitHub CI release job 未推送验证）
基线 SHA / 实现 SHA / dirty 与内容摘要：
  基线 960f61e（V01 提交）；实现见本次提交
修改文件和关键符号：
  scripts/preflight.ts（重构）
    合并重复的 typecheck/unit-tests 为单次 collaboration 入口：
      --expected-head / ROOM_EXPECTED_HEAD 存在时调用
      verify:collaboration:release --expected-head <sha>，否则 development；
    后续依次 secret-scan、check:room-plugin、test:mcp-connectors、
    acceptance:parallel --check、acceptance:room-images、job-launcher、build、
    sdk-consumer、browser-e2e、production-smoke；
    外层 capture sourceBefore/sourceAfter 并比较 tracked/working/untracked/
    lockfile；跳过 sdk/browser 或 --with-native 缺失进入 notVerified；
    report 新增 mode/expectedHead/sourceStable/releaseEligible/verdict；
    未知参数直接报错，不再静默忽略；不调用 preflight 自身、不递归
  package.json
    build 的 tsup 增加 --external sharp；新增
    verify:collaboration:release 脚本；acceptance:room-images 写入
    .state/acceptance-room-images/latest.json 证据
  scripts/acceptance-room-images.ts
    --check 结果落 latest.json 供 CI evidence 上传
  .github/workflows/ci.yml
    verify job 增加 connector/plugin、并行任务与图片验收步骤；
    release-preflight job 注入 ROOM_EXPECTED_HEAD=${{ github.sha }}，
    调用重构后的 test:preflight；
    evidence 上传 preflight、collaboration-baseline、browser、图片与并行验收，
    if:always；不上传 tokens/用户原图/完整数据库
变更前触发条件 / 变更后行为：
  变更前：preflight 重复执行 typecheck+全量测试+replay，和 CI verify job 重复；
  没有 release expected-head 入口、图片/连接器验收、外层 source 稳定性检查。
  变更后：一次 collaboration 入口提供 typecheck/test/replay，preflight 只追加
  其他 required 检查；CI 用 checkout SHA 作为 release 目标；跳过/缺失项
  只能得到 development_only 或非发布 verdict。
接口/事件/迁移/兼容性：
  preflight report 新增字段，旧字段保留；package scripts 向后兼容；
  native image pipe 仍为模式矩阵中的 not_verified，不把 skip 算 supported。
执行命令、cwd、环境、开始结束、退出码：
  npm run typecheck                                            exit 0
  npm run acceptance:room-images                               exit 0（latest.json 写入）
  npm run test:preflight -- --skip-browser --skip-sdk          exit 0
    verdict=development_only releaseEligible=false sourceStable=true
  npm test                                                      exit 0（529 pass / 0 fail）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-22 02:30–03:20 CST
证据路径：
  .state/parallel-room-image/v02-preflight-20261022b.log
  .state/parallel-room-image/v02-tests-20261022.log
  .state/preflight/latest.json
实际覆盖的模式和失败分支：
  preflight 真实入口一次跑通 collaboration+secret+plugin+mcp+parallel+images+
  build+production（skip sdk/browser）；外层 sourceStable=true；
  development_only/releaseEligible=false 判定；V02 前发现并修复了 dev preflight
  误用 release 脚本的问题
尚未验证项及明确原因：
  真实 GitHub Actions 尚未推送运行，expected-head/PR merge SHA 行为只有本地
  逻辑与单测证据；完整 browser+sdk+production release preflight 未在本轮全跑；
  native-image-pipe smoke 仍需要 Windows sandbox 环境；evidence 路径中的
  acceptance-parallel 实际输出目录需以 CI 首跑确认
下一张卡与依赖：V03（固定版本真实 CLI 与三组对照）
```

## I04/I05 — 连接器 room_send_image 与共享 helper

```
卡号与状态：I04/I05 补充切片 / 仍 in_progress（bridge/MCP 便利工具已接线；真实 pipe/stdin e2e 未跑）
基线 SHA / 实现 SHA / dirty 与内容摘要：
  基线 45e45cd（V02 提交）；实现见本次提交
修改文件和关键符号：
  scripts/room-image-transfer.mjs（新增，无第三方依赖）
    readLocalImage：拒绝 URL/UNC/设备/备用数据流、必须绝对路径、只能在
      ROOM_IMAGE_ROOTS 或 cwd 内、检查 raw 路径每级 symlink、open+fstat+
      完整读取+fstat/hash 二次校验；单文件 1B–10MiB
    uploadImage/sendImage：begin→逐块 192KiB base64→complete→room_post，
      稳定 imageOperationIds；错误保留 stage/commandId/artifactId，不打印
      base64 或本地源路径；room_post 兼容 Receipt 包装
    roomSendImage：MCP 便利入口，只读取 bytes 后再走低层工具
  scripts/room-bridge.mjs
    tools/list 增加 room_send_image（path/text/alt/mentions/replyTo/operationId）；
    room_post 增加 attachments/replyTo、text 可选；tools/call 便利编排，
    错误 isError + 稳定 code；低层调用仍一帧一块
  scripts/room-agent-mcp.mjs
    同样增加 room_send_image/room_post 参数；commandId 由显式 operationId 或
    稳定请求派生；REAL/非图片工具错误维持原有 JSON-RPC 错误通道
  scripts/sync-room-agent-plugin.mjs
    MANIFEST 增加 scripts/room-image-transfer.mjs → 插件 server 副本；
    --check 同时检查两个文件
  apps/server/src/toolchain.ts
    helper 来源加入 fingerprint 与复制清单：runtimes/tools/<fp>/node/room-image-transfer.mjs，
    防旧 helper 继续运行
  plugins/tempt-room-claude/server/*
    同步后的 room-agent-mcp.mjs + room-image-transfer.mjs
  tests/room-image-transfer.test.ts（新增 3 个用例）
  tests/room-mcp-server.test.ts（工具数 13→14，新增 room_send_image）
变更前触发条件 / 变更后行为：
  变更前：connectors 只有 room_post 文本，不能本地读图/分块上传；MCP host
  无法发图；toolchain 不识别 helper。
  变更后：托管 bridge 与外部 MCP 都以 room_send_image 读取允许根内的本地
  图片，分块上传后发一条纯图片/图文消息；插件副本与 toolchain 指纹一致。
接口/事件/迁移/兼容性：
  连接器工具面新增 room_send_image；服务端协议不变，仍走 image_upload_* +
  room_post；无迁移；旧 room_post 文本调用兼容。
执行命令、cwd、环境、开始结束、退出码：
  node --check scripts/room-agent-mcp.mjs / room-bridge.mjs          exit 0
  node scripts/sync-room-agent-plugin.mjs --check                     exit 0（2 files in-sync）
  npx tsx --test tests/room-image-transfer.test.ts                     exit 0（3 pass / 0 fail）
  npm run test:mcp-connectors                                         exit 0（15 pass / 0 fail）
  npm test                                                             exit 0（532 pass / 0 fail）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-22 03:20–04:10 CST
证据路径：
  .state/parallel-room-image/i04-i05-connectors-tests-20261022b.log
实际覆盖的模式和失败分支：
  允许根内读取→三段式上传→一条附件消息；缺失/越界/URL/UNC/symlink 拒绝；
  两个 connector 的 room_send_image schema 一致；插件副本 byte-identical；
  toolchain fingerprint 包含 helper；room_post Receipt 解包
尚未验证项及明确错误：
  真实 HostRoomPipe/AppContainer 管道分块 smoke 与外部 stdio→HTTP 端到端
  （包括丢回复同 ID 重试、并发两张图）未跑；ROOM_IMAGE_ROOTS 各宿主注入
  仍由 adapter 配置工作；真实连接器发图需用户运行环境验证
下一张卡与依赖：V03（固定版本真实 CLI 与三组对照，需付费授权）
```

## I04/I05 — 原生管道与外部 stdio 图片证据

```
卡号与状态：I04/I05 证据切片（host pipe smoke 已通过；AppContainer 明确 not_verified）
基线 SHA / 实现 SHA / dirty 与内容摘要：
  基线 8418ac0（连接器 room_send_image 提交）；实现见本次提交
修改文件和关键符号：
  scripts/smoke-agent-images.ts（新增）
    --mode host：真实 HostRoomPipe + spawn room-bridge.mjs MCP 进程；
      固定 24×16 PNG，经 bridge room_send_image 分块上传；
      校验 bridge initialize/tools/list、artifact.image verified、预览 hash、
      只一条附件消息；零模型、零网络；
    --mode sandbox：若 RoomSandbox exe 缺失则 ok=true/verified=false，
      notVerified 明确写“不把缺失当 supported”，不伪造通过
  tests/external-image-tools.test.ts（新增 2 个用例）
    真实 createApp.listen + issueAgentToken + spawn room-agent-mcp.mjs；
    initialize/tools/list/room_send_image 经真实 stdio→HTTP→Worker；
    同一 operationId 丢回复重试：同一 artifactId/messageId、一条消息、
    一个 artifact.created
  scripts/preflight.ts
    --with-native 增加 native-image-pipe host smoke（不再只跑旧 sandbox）；
  package.json
    新增 test:room-images-native；
  .github/workflows/ci.yml
    新增独立 native-image-pipe job（continue-on-error，真实 named pipe 固定图，
    上传 .state/room-images-native 证据，不影响普通模拟 CI）
变更前触发条件 / 变更后行为：
  变更前：只有模块级测试，没有真实 named pipe 或外部 MCP stdio 证据。
  变更后：host bridge 与外部 MCP 两条真实入口都有可重复、零模型的固定图
  上传证据；AppContainer 缺失单列 not_verified，不混入 supported。
执行命令、cwd、环境、开始结束、退出码：
  npx tsc --noEmit                                                   exit 0
  npm run test:room-images-native -- --mode host                     exit 0（verified=true）
  npm run test:room-images-native -- --mode sandbox                  exit 0（verified=false, not_verified）
  npx tsx --test tests/external-image-tools.test.ts                   exit 0（2 pass / 0 fail）
  npm test                                                            exit 0（534 pass / 0 fail）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-22 04:10–04:50 CST
证据路径：
  .state/parallel-room-image/i04-native-i05-e2e-tests-20261022.log
  .state/parallel-room-image/i04-i05-final-tests-20261022.log
  .state/room-images-native/latest.json
实际覆盖的模式和失败分支：
  host named pipe：bridge initialize/tools/list/room_send_image，verified artifact，
  预览 hash，一条消息；外部 MCP：真实 stdio+HTTP，丢回复同 operationId 重试幂等；
  sandbox 模式缺失明确 not_verified
尚未验证项及明确原因：
  AppContainer true pipe smoke 尚未实现（需要 RoomSandbox 运行环境）；
  外部 MCP 网络超时/401/403/410 分类与并发双图 e2e 未补；CI native job 未实际
  推送运行；V03 真实付费 CLI 实验仍未获授权
下一张卡与依赖：V03（需明确付费授权）或 I07 剩余竞态
```

## I05 — 外部 MCP 超时与错误分类补充

```
卡号与状态：I05 补充切片 / in_progress
基线 SHA / 实现 SHA / dirty 与内容摘要：
  基线 a9e5fa0（原生/外部 e2e 提交）；实现见本次提交
修改文件和关键符号：
  scripts/room-agent-mcp.mjs
    call() 增加 ROOM_AGENT_HTTP_TIMEOUT_MS（默认 30s，限 1–120s），
    AbortController 超时返回 room_timeout/retryable=true；
    连接失败 room_unreachable；非 JSON invalid_room_response；
    HTTP 错误保留 body.code/status，429/5xx retryable=true，401/403/410
    retryable=false；不做自动无限重试
  scripts/room-image-transfer.mjs
    image 阶段包装保留 status/retryable，图片错误可判断是否需要重试
  scripts/room-bridge.mjs / scripts/room-agent-mcp.mjs
    image isError 小对象增加 retryable/status，不返回 base64 或本地路径
  plugins/tempt-room-claude/server/*
    同步后的 MCP 与 helper
  tests/external-image-tools.test.ts（+2 个用例）
    非法 token 的 room_send_image → isError code=invalid_agent_token、
      retryable=false、零 artifact；
    挂起 HTTP 服务 + ROOM_AGENT_HTTP_TIMEOUT_MS=1000 → 请求在 5s 内以
      room_timeout 失败
变更前触发条件 / 变更后行为：
  变更前：外部 MCP fetch 无超时、HTTP 错误只保留 message，图片工具错误
  不携带 retryable/status，客户端无法安全决定是否重试。
  变更后：超时与 5xx/429 标记可重试，401/403/410 明确不可重试；
  中途失败不重放低层请求，客户端用同 operationId 精确恢复。
接口/事件/迁移/兼容性：
  仅 connector 环境变量与错误字段；room HTTP 协议不变；无迁移。
执行命令、cwd、环境、开始结束、退出码：
  node --check scripts/room-agent-mcp.mjs                         exit 0
  node scripts/sync-room-agent-plugin.mjs --check                  exit 0（2 in-sync）
  npx tsx --test tests/external-image-tools.test.ts                 exit 0（4 pass / 0 fail）
  npm test                                                           exit 0（536 pass / 0 fail）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-22 04:50–05:15 CST
证据路径：
  .state/parallel-room-image/i05-timeout-tests-20261022.log
实际覆盖的模式和失败分支：
  HTTP 挂起 1s 超时；invalid agent token 非重试 isError；插件副本一致
尚未验证项及明确原因：
  并发双图通过同一 connector 的 JSON-RPC 顺序仍为单请求串行；真实宿主
  （Claude Code/Codex/DeepSeek）手动发图未跑；V03 付费实验未授权
下一张卡与依赖：I07 剩余竞态或 V03（等待授权）
```

## I07 — 解码期间删房与托管 generation 补充

```
卡号与状态：I07 补充切片 / in_progress
基线 SHA / 实现 SHA / dirty 与内容摘要：
  基线 a22443f（I05 超时提交）；实现见本次提交
修改文件和关键符号：
  apps/server/src/image-uploads.ts
    finalize 增加测试注入 beforeCommit()（仅可选回调，生产调用不传）；
    解码/预览完成后、权限复核前执行，用于证明 await 期间房间删除仍会
    阻止 artifact.created
  tests/room-image-races.test.ts（+2 个用例）
    1) beforeCommit 内写 room.deleting：finalize 抛房间错误，artifact 0；
    2) 真实 Worker 托管 run：adapter 内经 executeTool 执行
       image_upload_begin，随后 run.updated generation+1，再用旧 fence 调
       image_upload_chunk → executeTool 返回 Stale run generation 错误，
       artifact 0
变更前触发条件 / 变更后行为：
  变更前：I03 只有一个“房间已 deleting”的单例，无解码 await 窗口注入；
  managed executeTool 的 generation 变化未纳入图片测试。
  变更后：证明解码完成后权限复核仍获胜；托管旧 generation 不能继续上传。
接口/事件/迁移/兼容性：
  仅测试钩子与测试；生产行为不变；无迁移。
执行命令、cwd、环境、开始结束、退出码：
  npx tsc --noEmit                                              exit 0
  npx tsx --test tests/room-image-races.test.ts                  exit 0（8 pass / 0 fail）
  npm test                                                       exit 0（538 pass / 0 fail）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-22 05:15–05:40 CST
证据路径：
  .state/parallel-room-image/i07-remaining-tests-20261022.log
实际覆盖的模式和失败分支：
  解码 await 期间删房；托管 fence/generation 失效；均不产生 artifact
尚未验证项及明确错误：
  Run 取消而不是 generation 变化、任务版本变化、删除与最终 project apply
  并发、最后房间删除后 restart/重建投影仍待补；host/sandbox 真管道证据在
  I04 已单列
下一张卡与依赖：V03（等待付费授权）或最后房间 restart 竞态
```

## I07 — 最后房间删除后 restart / 重建投影

```
卡号与状态：I07 补充切片 / in_progress
基线 SHA / 实现 SHA / dirty 与内容摘要：
  基线 bcea651（I07 前次提交）；实现见本次提交
修改文件和关键符号：
  tests/room-image-races.test.ts（+1 个用例）
    用 Store/RoomService/ImageUploads/Worker 完成图片上传 → room.delete →
    tick 到 deleted → 关闭并重新打开 Store 重建投影：
      房间 tombstone 保留、activeRooms() 为空、artifact.created 只一个；
      再用同一 root 创建 createApp 注入 /api/rooms（空数组）与
      旧 /api/artifacts/<id>/image（410）
变更前触发条件 / 变更后行为：
  变更前：没有覆盖“最后房间删除后重启/重建投影+旧图片 URL”的组合。
  变更后：删除事实跨 restart 持久；旧图片不会因为文件仍在而被内联读取。
执行命令、cwd、环境、开始结束、退出码：
  npx tsc --noEmit                                              exit 0
  npx tsx --test tests/room-image-races.test.ts                  exit 0（9 pass / 0 fail）
  npm test                                                       exit 0（539 pass / 0 fail）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-22 05:40–06:00 CST
证据路径：
  .state/parallel-room-image/i07-last-room-tests-20261022.log
实际覆盖的模式和失败分支：
  最后房间 deleting→deleted、Store 重开投影重建、active room 列表为空、
  旧 artifact 文件仍在但 inline image 410
尚未验证项及明确原因：
  “房间删除与最终 project apply 并发”仍无专门测试（属项目 apply/集成锁
  交叉域）；真实 CI release job 仍未推送
下一张卡与依赖：V03（等待付费授权）或项目 apply 删除竞态
```

## V04 — 备份/恢复与统一完成口径（备份切片）

```
卡号与状态：V04 / in_progress（备份/恢复完成；文档统一与图片导入导出重验真待补）
基线 SHA / 实现 SHA / dirty 与内容摘要：
  基线 bcea651（I07 前次提交）；实现见本次提交
修改文件和关键符号：
  scripts/backup-state.mjs
    备份 SQLite（VACUUM INTO）+ artifacts + baselines + apply 三类目录；
    pending image uploads 明确不恢复，只记录 omittedPendingUploads；
    一致性：复制文件前后记录 events MAX(seq)，最多重试 3 次，必须相等；
    manifest 记录 watermarkEventSeq/filesCopiedEventsThrough/consistent、
      每文件 path/size/SHA256、fileCount/fileBytes、restoredDataDirs；
    失败清理目标目录；保留 5 个最新备份
  scripts/restore-state.mjs
    恢复 artifacts/baselines/apply；读取 manifest 对每个文件重新 SHA256 校验，
    缺失/hash 不匹配 exitCode=1；继续拒绝运行中服务
  tests/backup-restore.test.ts
    在 DB 外写入 artifact 原图/预览、baseline、apply journal；
    断言 manifest 水位一致、三类文件均出现；恢复后文件内容一致
变更前触发条件 / 变更后行为：
  变更前：只备份 room.sqlite + artifacts，丢失 baselines/apply journal；
  没有事件水位或文件 manifest，DB 与文件可能跨时刻仍被当作完整。
  变更后：备份包含三类文件与每文件 hash；事件序列前后不一致会重试/失败；
  restore 重新校验文件，不把不完整备份假称为完整。
接口/事件/迁移/兼容性：
  备份 manifest 向后兼容增加字段；现有 restore 命令参数不变；
  未完成上传不恢复，完成 artifact 必须恢复；无 DB 迁移。
执行命令、cwd、环境、开始结束、退出码：
  node --check scripts/backup-state.mjs / restore-state.mjs       exit 0
  npx tsx --test tests/backup-restore.test.ts                      exit 0（1 pass / 0 fail）
  npm test                                                         exit 0（539 pass / 0 fail）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-22 06:00–06:35 CST
证据路径：
  .state/parallel-room-image/v04-backup-tests-20261022.log
实际覆盖的模式和失败分支：
  DB + artifacts + baselines + apply 备份；manifest 文件 hash；恢复后 hash 校验；
  pending upload 计数 omitted；restore 仍拒绝 live lock
尚未验证项及明确原因：
  V04 文档统一（AGENT-PARALLEL-PROGRESS/NEXT-AGENT/CAPABILITY/PLAN-CLOSURE/
  VERIFICATION-MATRIX/ACCEPTANCE、PROTOCOL/EXTERNAL-MCP/UI 文档）尚未批量重写；
  图片二进制导出 8 MiB 单件/32 MiB 总量限制与 omittedArtifacts 报告未实现；
  导入图片重新生成 preview 的流程仍待 I07/导入路径补；release 文档口径未定
下一张卡与依赖：V03（需用户明确付费模型/CLI 授权）
```

## V04 — 图片导出/导入边界

```
卡号与状态：V04 补充切片 / in_progress
基线 SHA / 实现 SHA / dirty 与内容摘要：
  基线 249895a（V04 备份提交）；实现见本次提交
修改文件和关键符号：
  apps/server/src/app.ts
    GET /api/rooms/:id/export?includeArtifacts=1
      返回 omittedArtifacts：file_missing / single_item_over_8MiB /
      total_over_32MiB，并记录 artifactId/name/size/reason，不再静默丢弃；
    POST /api/rooms/import 改为 async prepare + 短 Store.atomic：
      客户端 image.verified 不可信；对 image/* 重新 validateAndPreview，
      服务端重算 contentHash/width/height/预览 hash/size；
      伪造尺寸会被实际解码结果覆盖；无效伪图降级为普通文件元数据
      （删除 image 字段），不 inline；安装原图+preview 后才写事件；
      返回 revalidatedImages/invalidImages/artifactIntegrityFailures
  tests/room-import.test.ts（+2 个用例）
    9MiB artifact 导出 omittedArtifacts 且不出现 contentBase64；
    合法 PNG 导出后篡改 image width/height=9999，导入后重新验真为 7×3，
    预览文件存在、inline image 返回 200
变更前触发条件 / 变更后行为：
  变更前：导出超过 8MiB/32MiB 的文件静默消失；导入直接信任源 image.verified
  与尺寸并只写原图，无 preview；伪图可造成 inline 不一致。
  变更后：省略项可审计；导入图片由服务端重新解码验真并生成安全预览，
  旧 hash/尺寸/verified 不可作为可信证明。
接口/事件/迁移/兼容性：
  export 新增 omittedArtifacts；import 新增结果字段；无 DB 迁移；
  非法图片保留为文件引用/文件卡，不生成伪造 image 元数据。
执行命令、cwd、环境、开始结束、退出码：
  npx tsc --noEmit                                              exit 0
  npx tsx --test tests/room-import.test.ts                      exit 0（7 pass / 0 fail）
  npm test                                                       exit 0（541 pass / 0 fail）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-22 06:35–07:05 CST
证据路径：
  .state/parallel-room-image/v04-import-tests-20261022.log
实际覆盖的模式和失败分支：
  超单件导出 omitted；图片导入重验真/重生成权限内预览/inline；伪造尺寸覆盖
尚未验证项及明确原因：
  V04 #1–7 文档统一（AGENT-PARALLEL-PROGRESS、CAPABILITY-COMPLETION、
  PLAN-CLOSURE、VERIFICATION-MATRIX、ACCEPTANCE、PROTOCOL、EXTERNAL-MCP、
  UI-WORKBENCH）未批量改写；总量 32MiB 与多件导出省略的专门断言未加；
  无二进制导入时 UI 缺失卡片未做浏览器断言；V03 仍等待付费授权
下一张卡与依赖：V03（需明确付费模型/CLI 授权）
```

## V04 — 文档统一补充

```
卡号与状态：V04 补充切片 / in_progress
基线 SHA：e3f6d9e；实现见本次提交
修改文件：AGENT-PARALLEL-PROGRESS、NEXT-AGENT-PROGRESS、CAPABILITY-COMPLETION、
PLAN-CLOSURE、VERIFICATION-MATRIX、ACCEPTANCE、PROTOCOL、EXTERNAL-MCP、
UI-WORKBENCH、plugins/tempt-room-claude/README
内容：统一 24 卡口径（G00–G01/P01–P06/R01–R05/I01–I07/V01–V04）；
五类状态（机制/M1 模拟/M1 真实/本批新功能/发布证据）；
引用同一验证矩阵与证据路径，不复制另一份完成状态；
PROTOCOL 增加 room lifecycle/revision/image 低层操作/私有路由；
EXTERNAL-MCP 与 plugin README 增加 room_send_image path/roots/operationId/恢复；
UI-WORKBENCH 增加原子设置、删除状态、图片缩略图/Lightbox；
验收 541/541 测试；secret-scan PASS（0 finding）。
未验证：真实 AppContainer 图片管道、真实宿主手动发图、CI release 首跑、
V03 付费真实 CLI 实验。
证据：.state/parallel-room-image/v04-import-tests-20261022.log、
.state/secret-scan/latest.json
下一张卡：V03（等待付费授权）
```

## R03/I04 — outbound 终止与 AppContainer bridge 工具发现

```
卡号与状态：R03/I04 补充切片 / in_progress
基线 SHA：7534373（V04 文档提交）；实现见本次提交
修改文件和关键符号：
  apps/server/src/worker.ts
    deliverOutbound 对 normalizeRoom(room).status !== 'active' 的房间：
      不发起任何 webhook 请求；对未 delivered 的 enqueue 写一次
      audit.recorded action=outbound.aborted:<deliveryId>:room_<status>，
      重启/下一 tick 仍不会继续外发尝试。
  sandbox/RoomSandbox/Program.cs
    AppContainer probe 的 bridge tools/list 期望更新为
    room_read,room_post,room_send_image,task_propose,artifact_publish，
    修复新增图片工具导致的 sandbox probe 失败。
  tests/room-deletion.test.ts（+1 个用例）
    outbound.enqueued 后立即 room.delete；deliverOutbound() 不产生
    outbound.attempted，只留下稳定 outbound.aborted 审计原因。
执行命令、cwd、环境、开始结束、退出码：
  npm run build:sandbox                                           exit 0
  npm run test:sandbox -- --probe                                exit 0（23/23 通过）
  npx tsc --noEmit                                               exit 0
  npx tsx --test --test-name-pattern=outbound tests/room-deletion.test.ts  exit 0
  npm test                                                        exit 0（542 pass / 0 fail）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-22 07:05–07:40 CST
证据路径：
  .state/parallel-room-image/r03-i04-tests-20261022.log
  .state/parallel-room-image/sandbox-build-20261022.log
实际覆盖：
  删除后未发外发请求且审计终止原因；AppContainer 沙箱内 bridge 列出
  room_send_image 并完成原有 scoped room_read。
尚未验证：
  AppContainer 内真实图片字节/分块上传仍是 not_verified；
  “正在外发请求”本身的中断（已发出 payload 不声称收回）未做故障注入。
下一张卡：V03（等待付费授权）或 AppContainer 真图片 smoke
```

## R04/R05 — room_wait 删除测试与新增 Agent 自动预选

```
卡号与状态：R04/R05 补充切片 / in_progress
基线 SHA：a7af572（R03/I04 提交）；实现见本次提交
修改文件和关键符号：
  tests/room-deletion.test.ts（+1 用例）
    agentTool room_wait(timeoutMs=10000) 等待中执行 room.delete：
    以“房间”错误在 <3s 内结束，不消耗完整 timeout。
  apps/web/src/main.tsx
    RoomForm 增加 preselectMemberId；新增 Agent 流程（addAgentToRoom）保存后
    自动回到 room-settings，并把新 agent.id 预先勾选为房间成员；关闭/保存后
    清空 pending/preselect 状态，避免跨房间残留。
    AgentForm 普通新增仍保留原“已添加成员，请邀请”提示。
  scripts/browser-e2e.ts（+1 步）
    房间设置 → 新增 Agent → 保存 → 断言自动回到设置且新 Agent 复选框
    checked=true；随后恢复 Agent 列表状态，既有流程继续通过。
执行命令、cwd、环境、开始结束、退出码：
  npx tsc --noEmit                                               exit 0
  npm run test:browser                                          PASS（新增 ui-add-agent-from-settings 步骤）
  npm test                                                        exit 0（543 pass / 0 fail）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-22 07:40–08:20 CST
证据路径：
  .state/parallel-room-image/r04-r05-tests-20261022.log
  .state/parallel-room-image/r05-browser-20261022c.log
实际覆盖：
  room_wait 在删除开始时即时返回；新增 Agent 自动返回设置并预选；完整浏览器回归
尚未验证：
  双窗口同时打开时的删除同步/重连仍无浏览器级断言；房间设置保存时新 Agent
  是否在房执行成员校验由服务端已覆盖，但此 UI 流程只验证了预选。
下一张卡：V03（等待付费授权）或双窗口浏览器竞态
```

## R04 — 两个真实 WebSocket 窗口的删除终态

```
卡号与状态：R04 补充切片 / in_progress
基线 SHA：9899598（R04/R05 提交）；实现见本次提交
修改文件和关键符号：
  tests/room-api.test.ts（+1 用例）
    对同一 room 建立两个真实 WebSocket 连接（room.v0.1 + room-token），
    各自发送 subscribe after=0 并等待 subscribed；执行 room.delete 后：
      两个窗口都收到 durable room.deleting 帧；
      两个窗口都以 code=1000 reason=room_deleting 关闭；
      不存在一个窗口先关闭导致另一个收不到终态的情况。
执行命令、cwd、环境、开始结束、退出码：
  npx tsc --noEmit                                               exit 0
  npx tsx --test --test-name-pattern='two websocket windows' tests/room-api.test.ts  exit 0
  npm test                                                        exit 0（544 pass / 0 fail）
  cwd=仓库根，Windows PowerShell 5.1，2026-10-22 08:20–08:45 CST
证据路径：
  .state/parallel-room-image/r04-ws-tests-20261022.log
实际覆盖：
  两个真实 WS 客户端的删除事件广播与终态关闭
尚未验证：
  浏览器两个真实页面窗口的 UI 同步仍无断言（当前是协议层真实 WS）；
  客户端收到 room.deleting 后停止重连由 client SDK 代码覆盖，未做双窗口浏览器
  断线重连计时断言。
下一张卡：V03（等待付费授权）或 AppContainer 真图片 smoke
```

## I05 — 两个外部 MCP 进程并发图片

```
基线 SHA：f4790b7；实现见本次提交
修改：tests/external-image-tools.test.ts（+1 用例）
两个独立 room-agent-mcp.mjs 进程、各自 stdio/HTTP、并发 room_send_image
上传不同 PNG；断言 artifactId/messageId 不同、尺寸/hash 不串线、只产生
两个 artifact.created 与各自一条附件消息。
npm test 545/545；证据 .state/parallel-room-image/i05-concurrent-tests-20261022.log。
未验证：真实 Claude/Codex/DeepSeek 宿主手动发图。
下一张卡：V03（等待付费授权）或 AppContainer 真图片 smoke
```

## R04/R05 — 双浏览器窗口删除同步

```
基线 SHA：5f7e932；实现见本次提交
修改：scripts/browser-e2e.ts（+1 步 two-window-delete-sync）
在当前视觉房间建立第二个真实浏览器 target/session，导航同一 room；
第一个窗口通过房间设置“删除房间…”→“确认删除”走真实 UI；
第二个窗口等待 room.deleting 终态后不再显示“实时连接”，2 秒后仍不重连。
验证：npm run test:browser PASS（含 two-window-delete-sync）；npm test 545/545。
证据：.state/parallel-room-image/r05-two-window-browser-20261022.log。
未验证：最后房间删除后的空状态浏览器断言。
下一张卡：V03（等待付费授权）或 AppContainer 真图片 smoke
```

## R05 — 最后房间空状态与冲突刷新

```
基线 SHA：523db59；实现见本次提交
修改：apps/web/src/main.tsx、scripts/browser-e2e.ts
a) RoomForm 冲突错误增加“刷新房间数据”按钮：onReload 调 refresh，成功后清错；
b) 浏览器在删除所有 active rooms 后 reload，断言“还没有房间”与“创建房间”。
验证：npm run test:browser PASS（two-window-delete-sync、last-room-empty-state）；
       npx vite build exit 0；npx tsc --noEmit exit 0。
证据：.state/parallel-room-image/r05-empty-browser-20261022.log。
未验证：取消删除、手机端删除、忙成员停止/交接入口的浏览器步骤。
下一张卡：V03（等待付费授权）或 AppContainer 真图片 smoke
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
