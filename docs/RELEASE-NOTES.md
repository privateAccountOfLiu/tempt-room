# Tempt Room v0.1 本地发布说明

本版本是 **Windows 本地单用户、多 Agent、多房间** 的第一版，不包含云服务、多账号、跨服务器联邦、自动发布或自动 PR 合并。

## 一、环境要求

- Windows 10/11（默认隔离依赖 .NET 10 AppContainer 宿主）
- Node.js 24+
- .NET 10 SDK（仅 `npm run build:sandbox` 构建原生执行宿主需要）
- Git（项目快照、host 模式交接检查点与成果差异）
- 浏览器：Edge / Chrome（真实浏览器验收使用无头 Edge）

## 二、安装与启动

```powershell
npm ci
npm run build:sandbox     # 构建 Windows 原生沙箱宿主
npm run build             # 构建前端与服务端 dist
npm run dev               # 开发模式（tsx）
npm run dev:open          # 开发模式并自动打开浏览器
# 或生产模式
npm start                 # node dist/server/main.js
```

启动后打开终端输出的 `http://127.0.0.1:4317/#session=...`，或执行：

```powershell
npm run open               # 用默认浏览器打开当前运行实例
npm run open -- --print    # 只输出当前启动地址
```

## 三、数据与备份

- 数据目录默认 `.state/`，可用 `ROOM_STATE_DIR` 指定绝对路径；端口可用 `ROOM_PORT` 调整。
- 数据库为 SQLite（WAL，`user_version=2`）。
- 会话令牌持久化在 `.state/owner-session.token`，正常重启复用；需要轮换时：
  ```powershell
  $env:ROOM_ROTATE_SESSION=1
  npm run dev
  ```
  或删除令牌文件。轮换后外部 MCP 客户端需要刷新令牌。
- 升级前备份：
  ```powershell
  npm run backup
  ```
  生成 `.state/backups/<时间戳>/`，包含一致快照 `room.sqlite`、`artifacts/` 与 `manifest.json`；默认保留最近 5 份。
- 从 v1 数据库升级到 v2 时，服务启动会自动生成 `room.sqlite.v1.<时间戳>.bak`。
- 恢复：先关闭服务，然后执行
  ```powershell
  npm run restore -- --latest
  # 或指定备份
  npm run restore -- --backup .state/backups/<时间戳>
  ```
  恢复会先把当前数据库移到 `room.sqlite.pre-restore.<时间戳>`，再复制快照与 artifacts，并核对 `user_version` 与房间数；服务运行中会拒绝执行。备份/恢复流程已有自动化测试（`tests/backup-restore.test.ts`）。

## 四、验证摘要

必需门禁（`npm run report:readiness` 退出码 0）：

- preflight 9/9（含仓库密钥扫描）、单元/契约测试 218/218、浏览器 E2E 41/41、生产冒烟 10/10
- 原生沙箱 23/23、连接器 9/9、Agent 协议预检
- 房间审计导出、房间 URL/标签页标题恢复、用量看板、运行详情与工具操作、运行级 Token/费用硬预算、显式失败重试、讨论 quorum/absent/late、房间/成员待处理运行上限、EWMA 自适应超时、最近服务公平排序、消息来源信任级、房间累计预算熔断、超时草稿降级、失败分类建议、键盘快捷入口、讨论历史详情、注入数据测试、公平性压力、移动端布局、随机 seq 故障注入、Agent 权重调度、双连接并发写入、事件/上下文契约（`test:replay` 63/63）
- Claude 沙箱单项真实轮次、沙箱真实 Agent 成果应用、沙箱两 Agent 任务接力（Claude + DeepSeek）
- Codex / DeepSeek 本机直连单项真实轮次
- 外部 Claude Code / Codex 令牌巡检与实际房间发言
- 外部 Agent 自动值守运行器（假 CLI + 真实 Claude CLI）
- 三 Agent host 协作、host 文件编辑、命令/测试执行、取消、两 Agent 接力
- 完整账号登录证据见 [验证矩阵](VERIFICATION-MATRIX.md)

可选“沙箱 + 显式 API 密钥”完整三 Agent 场景：需要 Codex `OPENAI_API_KEY`，本机账号登录环境未执行。

## 五、已知限制

- 账号登录状态不自动导入 AppContainer 沙箱；沙箱内使用 Claude/Codex 需要显式 API 密钥或兼容端点凭据（Claude 已验证 DeepSeek 兼容端点）。
- 真实第三方 A2A 服务联调尚未进行；本地 HTTP A2A 协议测试已覆盖。
- Claude/Codex 在诊断与运行文件检查时会读取 `--version` 并与固定版本比对；DeepSeek Harness Desktop 会从 asar 内 package.json 读取应用版本并核对固定版本；正式发布前仍应人工固定安装版本。
- 成果应用（`artifact.apply`）用于沙箱任务的差异交付物；本机直连任务直接修改真实项目并生成“本机变更清单”。
- 自动值守运行器不是 Windows 服务，需要用户自行启动并看护；每次唤醒会产生模型费用。
- 系统代理/私有网络探测只覆盖本机已知路径，不代表所有 Windows 环境。

## 六、相关文档

- [验证矩阵](VERIFICATION-MATRIX.md)
- [验收与已知限制](ACCEPTANCE.md)
- [账号登录型 Agent](ACCOUNT-LOGIN.md)
- [Claude Code 配置](CLAUDE-CODE-CONFIG.md) / [Codex 配置](CODEX-CONFIG.md)
- [Room Protocol](PROTOCOL.md) / [沙箱说明](SANDBOX.md)
- [发布就绪摘要](RELEASE-READINESS.md)


## 开发中：并行协作的一致性底座

源码新增 v3 事件注册、不可变日志、真实投影重建和一致性快照；旧数据库先备份，再追加基线，不删除历史。此批仍处于开发验证，完整路线与未完成门槛见 [并行协作实施记录](AGENT-PARALLEL-PROGRESS.md)。本文前面的 v0.1 数据库 v2 记录是原有发布验收结果，不表示当前日常服务已迁移，也不表示整个并行协作计划已交付。

开发版进一步增加 v4 的 generation/executionId 执行隔离、Worker 租约与 Room 工具操作账本。旧管道请求无法写入新 generation；已完成操作返回原回执，崩溃后不确定的操作阻止重做。原生 CLI 内部副作用的自动恢复仍未完成；本批没有自动迁移日常数据。

开发版 v5 增加运行状态校验、每两秒/64 KiB 有界持久草稿、final supersedes 链，以及 superseded 与 canceled 的区分。浏览器已验证刷新恢复和最终稿无重复替换。

开发版 v6 增加 baseSeq 上下文水位与提交前增量对账：新点名/决策/任务变化可触发受预算约束的补充轮次，旧 executionId 写入被拒绝；浏览器已验证“正在核对新增上下文”和最终稿替换。EWMA 窗口、quorum/late、公平调度与预算熔断仍在进行中，详见 [实施记录](AGENT-PARALLEL-PROGRESS.md)。
