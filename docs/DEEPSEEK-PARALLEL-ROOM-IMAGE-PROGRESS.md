# DeepSeek 后续实施进展：并行交付闭环、房间管理与 Agent 图片消息

本文件是 [实施 Plan](DEEPSEEK-PARALLEL-ROOM-IMAGE-IMPLEMENTATION-PLAN.md) 的唯一进展台账。
Plan 只描述待做工作，本文件记录实际发生的事：实现 SHA、命令、退出码、证据路径与未覆盖项。

> 副本说明：仓库根目录的 `deepseek-parallel-room-image-plan-v2.md` 与 `docs/DEEPSEEK-PARALLEL-ROOM-IMAGE-IMPLEMENTATION-PLAN.md` 当前内容相同。本文件与 docs 索引以 docs 下的副本为准；两份副本的去重与同步闸门列入 V04（文档统一），在此之前不擅自删除任一份。

状态取值：`not_started / in_progress / blocked / verified`。未验证的能力不得改写为完成。

- 实施顺序：G00–G01 → P01–P06 → R01–R05 → I01–I07 → V01–V04（共 24 张卡）
- 本轮执行者：mavis（MiniMax Code）
- 基线记录：`.state/parallel-room-image/20261021-162400/baseline.json`（ignored，不进入提交）

## 批次状态总览

| 卡 | 状态 | 摘要 |
|---|---|---|
| G00 开工记录与测试隔离 | verified | 基线 SHA/状态/工具链已落盘；fixture 隔离要求写入本文件与后续卡 |
| G01 两份外部 MCP 与防漂移 | verified | 语法错误在当前 HEAD 已修复；新增契约测试 15/15 与字节级同步闸门 |
| P01 候选枚举不消耗容量 | verified | 候选不再提前占用房间容量；派发前二次校验；资源忙保持排队不判失败 |
| P02 不可变基线与 host 独立目录 | in_progress | 共享扫描器 + 不可变基线 + host-isolated 已实现并验证；基线 GC、旧绑定补建、依赖产物叠入、UI 选择仍未覆盖 |
| P03 按 canonical 项目互斥、异步验收 | not_started | |
| P04 staging 精确组合 | not_started | |
| P05 双启动屏障与真实派发 | not_started | |
| P06 M1 七项可失败用例 | not_started | |
| R01 Room schema/事件/迁移 | not_started | |
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
  未覆盖：基线 GC 接线（gc() 已实现但未接入清理流程）；
  未覆盖：旧绑定缺内容快照时按摘要一致性补建或返回 baseline_unavailable
  （当前仍回退为扫描当前源目录）；
  未覆盖：依赖产物叠入工作区前的冻结版本/hash 校验；
  未覆盖：附着线程 + isolated 的 workspace_mode_unsupported（有代码分支，
  但真实附着模式需要 Codex 线程，本轮无该环境）
下一张卡与依赖：P03（按 canonical 项目互斥与异步集成验收）
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
