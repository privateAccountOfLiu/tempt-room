# Job Launcher 构建与回退

## 作用

`tools/job-launcher` 是 Windows Job Object 启动器：

- 创建 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` job
- 子进程启动后加入 job
- 退出/被杀时内核关闭 job handle，终止整棵子进程树
- 透明代理 stdin/stdout/stderr，HostChannel 协议不变

Host 模式在 `.state/tools/job-launcher.exe` 存在时自动使用；证明写入 `Run.cleanupProof=job-object-kill-on-close`。

## 自动构建

`npm run build` 与 `npm run test:preflight` 已包含 `job-launcher` 步骤：

- `npm run build:job-launcher` → 调用 `scripts/build-job-launcher.mjs`
- 有 dotnet SDK：`dotnet publish tools/job-launcher -c Release -o .state/tools`
- 无 dotnet SDK：打印警告并以 0 退出，Host 模式回退 `taskkill + CIM tracked PID` 清理证明

preflight 报告中的 `job-launcher` 步骤会显示具体模式：

- `job-launcher: built (...)`
- `job-launcher: fallback to taskkill+CIM (...)`

## 手动命令

```powershell
npm run build:job-launcher      # 尝试构建；失败/缺 SDK 时仅警告
npm run check:job-launcher      # 检查是否可用（不构建）
```

严格环境可要求必须构建：

```powershell
$env:ROOM_JOB_LAUNCHER_REQUIRED='1'
npm run build:job-launcher      # 缺少 dotnet 或构建失败时 exit 1
```

## 回退语义

- 未构建：Host 模式仍可用，cleanupProof 为 `taskkill-tree-scan`
- 已构建：cleanupProof 为 `job-object-kill-on-close`
- 回退不影响其余租约/清理语义；`tests/job-launcher.test.ts` 在未构建时自动跳过
- dotnet 仅在构建期需要，运行时不需要

## 验证

- 本地构建：`job-launcher: built (... 173177 bytes)`
- 模拟缺 dotnet：`fallback to taskkill+CIM`，exit 0
- `ROOM_JOB_LAUNCHER_REQUIRED=1` 且缺 dotnet：exit 1
- 真实 Codex 经 launcher：completed，cleanupProof=job-object-kill-on-close，remaining=0
