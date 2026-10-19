# Next Agent 实施进度（v1.1 / M0 波次）

本文件记录 `next-agent-implementation-plan-v1.1.md` 的实际实施状态，不能替代计划本身或验收证据。目标仍是 M0–M1 的完整闭环；当前完成的是 M0 中可独立验收的一波：A00 基线证据、A01 审计分页、A02 调度公平。

## 本次完成

### A00 — 协作基线证据

- 新增 `scripts/verify-collaboration-baseline.ts`、`tests/verification-report.test.ts`
- `package.json` 新增 `verify:collaboration`
- 顺序运行 `npm run typecheck`、`npm test`、`npm run test:replay`，保存：
  - cwd、HEAD、dirty 状态、Node/npm/Git 版本
  - 每条命令 argv、开始/结束时间、exitCode、stdout/stderr 文件、SHA256
  - report schemaVersion、source、test totals、`modelRequests: 0`
- 任一命令失败时脚本退出非 0；报告仍会写入证据目录
- 测试使用成功/失败假 runner，验证 totals、exit code、dirty/HEAD 区分、输出哈希

本次真实运行：

```text
collaboration baseline: PASS
source HEAD: 76632d4b4f4019722ffe8080da0ce1270b47bc0a (dirty)
typecheck: passed
test: passed
replay: passed
report: .state/collaboration-baseline/run-2026-10-19T14-57-39-975Z-2d9106e3/report.json
```

### A01 — 审计导出分页

- `Store.scanEvents(roomId,{afterSeq,throughSeq,pageSize})`：
  - 每页最多 1000 条
  - 只读取 `seq <= throughSeq`
  - 游标不前进或中间断号时报错，不把截断结果标成功
- `/api/rooms/:id/audit/export`：
  - 先冻结 `throughSeq = room.seq`
  - 通过 NDJSON 流输出，使用 Node `Readable` 背压
  - 增加 `x-audit-history-floor`、`x-audit-through-seq` 响应头
  - 保持 owner 鉴权；新增事件不混入已冻结水位
- 扩展 `tests/audit-export.test.ts`：
  - 0 / 500 / 501 / 2501 条追加事件的完整导出
  - 事件 seq 连续
  - 非 owner token 返回 401
  - scan watermark 冻结与后续增量读取

### A02 — 调度公平与 anti-starvation

- 新增 `ReadyScheduler`：
  - 房间 round-robin
  - 房间内按 Agent flow 做 smooth weighted round-robin
  - credit 改变时重置（集合/权重变化），等待次数保留
  - `maxBypassDispatches` 保证低权重/新加入 flow 的服务上界
  - 只有 `run.started` 成功后才 `recordServed`
- Worker 调度改为：
  - 先构造就绪候选（状态、活动 Run、线程、同成员房间、host 项目目录、依赖完成）
  - `ReadyScheduler.pick` 选一个候选
  - `startRun` 提交短事务并启动进程
  - `recordServed` 在启动成功后记账
- 设置新增 `maxBypassDispatches`（默认 5），UI 与浏览器 E2E 断言同步
- `fairOrder` 保留为无权重 stateless 兼容排序，不再参与 Worker 派发
- 新增 `tests/ready-scheduler.test.ts`，覆盖：
  - 真实 epoch 时间、持续 3000 次、2:1 权重长期份额
  - 100 Agent 稳定集合无饥饿
  - 高权重 + 低权重时 bypass 等待上界
  - 多房间轮询与阻塞房间不拖累
  - 新 flow 加入时 credit 重置但不丢等待

回归修复：房间轮询后，`codex-attach` 原先假定“第一个 Run 一定是原生执行”的测试改为等待并选择真实挂载 codex 状态的 Run；取消断言接受 `cancel_requested`/`canceled` 的合法竞态。

## 验证结果

- `npm run verify:collaboration`：PASS（typecheck / test / replay）
- `npm test`：292/292
- `npm run test:preflight -- --with-native`：9/9 通过（`.state/preflight/run-Dta6d5/report.json`，269.2s）
- `npm run test:replay`：通过（随 verify 记录）
- `npx tsc --noEmit`：通过
- 浏览器 E2E：45/45 通过（`.state/browser-e2e/run-63djst/report.json`）
- 本轮未运行 `--allow-paid` 真实模型，未启动模型请求

证据：

- `.state/collaboration-baseline/run-2026-10-19T14-57-39-975Z-2d9106e3/report.json`
- `.state/collaboration-baseline/run-2026-10-19T14-57-39-975Z-2d9106e3/typecheck.stdout.txt`
- `.state/collaboration-baseline/run-2026-10-19T14-57-39-975Z-2d9106e3/test.stdout.txt`
- `.state/collaboration-baseline/run-2026-10-19T14-57-39-975Z-2d9106e3/replay.stdout.txt`

## 未完成 / 下一波

- A03 host 变更归因与共享提交
- B05a 能力探针与三态结果格式（M0 前移切片）
- B01/B02 会话协议对象与迁移
- M1 双 Agent 固定契约任务闭环：Task 契约、独立工作区、验收/集成分离、并行验收脚本

## 约束提醒

- 本波次未迁移日常数据库，未启动真实模型，未修改账号或模型配置。
- `maxBypassDispatches` 是派发次数上界，不是 CPU/Token/完成时间 WFQ；真正的加权资源份额仍需后续立项。
- 审计导出从 seq 0 开始读取当前 event log；historyFloor 以响应头展示，不重写旧事件。
