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
| P02 不可变基线与 host 独立目录 | not_started | |
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
