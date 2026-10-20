# E02 真实双 Agent 实验报告

日期：2026-10-20（Asia/Shanghai）
授权：用户明确选择「授权执行完整双 Agent 实验」
执行脚本：npm run experiment:real -- --execute
原始报告：[docs/evidence/e02-real-dual-agent-report.json](evidence/e02-real-dual-agent-report.json)

## 参与者

| 角色 | Agent | provider | 入口 |
| --- | --- | --- | --- |
| A 基线实现 | DeepSeek | deepseek | DeepSeek Harness.exe |
| B 复核验收 | Claude | claude | %USERPROFILE%\\.local\\bin\\claude.exe（修复后） |

## 结果

| Run | Agent | 状态 | 耗时 | 清理证明 | 用量 |
| --- | --- | --- | --- | --- | --- |
| run_44067f96b4f4436c8a30ba368e6ff3cd | deepseek | completed | 463.2s | taskkill-tree-scan, 0 remaining | 不可用（provider 未上报） |
| run_464dbed2e5ed410989303c0b44bfbe0e | claude | completed | 469.0s | taskkill-tree-scan, 0 remaining | $2.708936 / 100435 in / 89041 out |

房间：room_76aca6ae43a748c29412b145d344e293
任务：task_d1c7f9358eee448690c2dc7943a44d5a → task_785be63f052f4754801f7b871a580098

## 交付物

共 27 个 artifacts：

- DeepSeek：baseline/CONTRACT.md、src/formatter.cjs、test/cases.cjs、package.json、README.md、EVIDENCE.md、MANIFEST.md、evidence/*.log
- Claude：review/REVIEW.md、review/DELIVERY.md、review/acceptance/*.cjs、review/evidence/*.log

## 真实成本

Claude run 记录 costUsd=2.708936（输入 100435 / 输出 89041 tokens）。DeepSeek Harness 未上报 usage，因此总成本至少为 Claude 记录值。

## 观察与缺口

- 两个真实 host 进程均产生 cleanupProof=taskkill-tree-scan 且 remainingProcesses=0，验证了 C04b 的 native 清理证据路径。
- DeepSeek usage=false，成本不能完整归集；这是 adapter 能力缺口，已在能力矩阵中保留。
- Claude 初始 executable 指向不存在的版本目录，修复为 C:\\Users\\35151\\.local\\bin\\claude.exe 后成功。
- 实验任务未绑定 projectPath，属于会话级双 Agent 协作；项目型实验可在后续用两种 CLI 再跑。
- 实验房间保留在本地 .state/room.sqlite 供追溯。
