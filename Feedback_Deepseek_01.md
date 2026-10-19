# Feedback_Deepseek_01

**主题：DeepSeek Harness（DSH）接入 Tempt Room 的问题反馈**

| 项目 | 内容 |
|---|---|
| 日期 | 2026-10-17（Asia/Shanghai） |
| 反馈者 | DeepSeek Harness 会话（本机 DeepSeek Harness Desktop 0.2.0-rc.2） |
| 审阅对象 | Tempt Room 当前工作区代码（含 17:00–17:34 期间的沙箱/工具链改动） |
| 方法 | 只读代码审阅 + 本机隔离实验（未修改任何项目源码） |
| 结论 | **ACP 协议层兼容性良好，但当前不能端到端接入。** 阻塞分两类：① 沙箱宿主与 Node/Electron 运行时存在硬性不兼容（DSH 启动即崩溃，或启动后卡住）；② Tempt Room 的启动器、staging、会话/工作区语义与 DSH Desktop 发行形态不匹配。此外沙箱探针当前未就绪（2 项失败），本地执行入口本身仍是关闭的。 |

---

## 0. 摘要

1. **好消息：协议对得上。** 用本机 DSH 的真实 ACP server 实测：`initialize`（protocolVersion 1）、`session/new`（含 Tempt Room 同款 stdio MCP 声明与 `env` 数组）、`session/close`、`session/resume` 均按 Tempt Room 适配器的假设工作；`DEEPSEEK_API_KEY` 通过启动环境注入有效；临时 `DSH_HOME` 会自动初始化 `profiles/acp`；stdout 只输出 JSON-RPC（无噪声）。
2. **硬阻塞 1：DSH 在 AppContainer 内无法启动。** 宿主的 AppContainer 令牌使 Node 的 `fs.realpathSync` 对**任何绝对路径**返回 `EPERM`（根因：`lstat` 卷根被拒绝）。DSH Desktop CLI 第一段启动代码 `installOfficeEngineResolution()` 就调用 `realpathSync(runtimeDir)`，因此进程立即 `exit 1`。D:、C: 两处 managed state 均复现。已实测一个 `-r <shim>.cjs` 预载缓解方案可越过该崩溃。
3. **硬阻塞 2：越过 realpath 后，DSH 又卡在 AppContainer 私有临时目录缺失。** `dsh-spill-local` 需要 `%LOCALAPPDATA%\Packages\temptroom.<...>\AC\Temp`，宿主把 `LOCALAPPDATA` 重定向到隔离 home 却没有预建该目录；随后 `fs-sandbox` 导入失败、多个 bundle pending，ACP server 在 180 秒内未响应 `initialize`。
4. **启动器形态不匹配。** 本机**不存在** `dsh.exe`；DSH Desktop 的 CLI 是 `dsh.cmd` + `ELECTRON_RUN_AS_NODE=1` + `DeepSeek Harness.exe --expose-internals ...\app.asar\dsh\...\cli.js`。Tempt Room 适配器固定 `['--profile','acp']`，没有启动参数/环境注入字段，`stageRuntime` 又只接受 `.exe`，所以按 README 现在的配置方式无法启动 DSH。
5. **其他必修项：** 模型配置值必须是序列化的 `["deepseek-official","deepseek-v4-flash"]`（填普通模型名会报 `unknown model option`）；`session/resume` 要求 cwd 完全一致，而聊天模式每轮新建工作区，第二次 `@DSH` 必然失败；staging 拷贝语义（无原子性/无完整标记/指纹只取 exe）与体积上限（完整安装仅剩约 9 MiB 余量）需要加固；provider 错误原文含密钥掩码片段，不应直接写入房间事件。
6. **先决条件：** 最新探针 `ready:false`（`node-toolchain` 超时、`git-toolchain` 无法创建 `.git/HEAD`），`SandboxHost.launch()` 会直接 503。所有真实 Agent 接入都必须先让探针全绿。

---

## 1. 实测环境与对象

### 1.1 本机 DSH 安装（已核实）

| 项目 | 值 |
|---|---|
| 产品/版本 | DeepSeek Harness Desktop **0.2.0-rc.2**（`dsh.cmd --version`） |
| 安装目录 | `D:\Program Files\Deepseek Harness` |
| 主程序 | `DeepSeek Harness.exe` = 244,481,512 B（约 233 MiB） |
| 核心归档 | `resources\app.asar` = 115.7 MiB |
| 解包资源 | `resources\app.asar.unpacked` = 242.7 MiB / 1,497 files（含 LibreOffice 182.0 MiB / 731 files） |
| 支持运行时 | `resources\runtime` = 290.0 MiB / 8,194 files（Node/pnpm/Python/CLI 载体） |
| 顶层文件 | 317.9 MiB / 20 files（exe、DLL、pak、dat 等） |
| 完整安装 | **1,015.0 MiB / 9,772 files** |
| 命令行载体 | `resources\runtime\cli\bin\dsh.cmd`：设 `ELECTRON_RUN_AS_NODE=1`，执行 `DeepSeek Harness.exe --expose-internals "<app.asar>\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*` |
| PATH | 未发现已安装的 `dsh` / `dsh.cmd`（WindowsApps、npm 全局均无） |
| 现有 profiles | `web`、`desktop`（`acp` 尚未初始化；首次 `--profile acp` 会自动创建，已实测） |
| 凭据优先级（官方文档） | 启动环境变量 > `$DSH_HOME/.credentials.yaml` > `.env`；实测 launch env 的 `DEEPSEEK_API_KEY` 生效 |

**结论：项目 README / 错误文案中的“官方 Windows runtime 的 `dsh.exe`”在本机不存在，应以 Desktop CLI 的实际形态为准。**

### 1.2 Tempt Room 当前状态

- 最新探针（`.state/diagnostics/sandbox.json`，2026-10-17T09:34:17Z）：17 项检查，`ready:false`。
  - 通过：AppContainer token、Job、工作区读写、宿主文件/进程拒绝、**room-ipc**、IPv4/IPv6 loopback 拒绝、私有网拒绝、公网 HTTPS、子进程隔离、npm、shell、取消进程树、宿主退出进程树。
  - 失败：`node-toolchain`（15 s 超时，无更多信息）、`git-toolchain`（`unable to create directory for ...\workspace\.git\HEAD`）。
- 数据库中 `deepseek` 成员仍未配置：`enabled:false, executable:""`，因此此前从未走到过真实 DSH 启动。
- `.state/runtimes/tools` 已由 `toolchain.ts` 原子 staging（369.5 MiB / 2,565 files），说明工具链方案已在推进。
- `.state` 中没有任何 DSH 运行文件 staging；本次反馈中的沙箱实验为诊断目的临时创建并已清理。

---

## 2. P0 阻塞问题

### P0-1 AppContainer 内 Node/Electron 的 `realpath` 全部 EPERM，DSH 启动即崩溃

**现象（两处 managed state 均复现）：**

1. 在 `.state`（D:）内 stage 精简 DSH runtime 后，通过 `RoomSandbox.exe` 直接 launch：
   - 进程正常收到 `sandbox.started`（appContainer/job 均为 true）
   - stderr 立即出现：
     ```
     Error: EPERM: operation not permitted, lstat 'D:\'
         at realpathSync (node:fs:2745:25)
         at installOfficeEngineResolution (...\dsh-desktop-host\lib\cli.js:38:15)
         at runDesktopCli (...\cli.js:92:2)
     Node.js v24.18.1
     ```
   - `sandbox.exit exitCode=1`，ACP `initialize` 永远无响应。
2. 将 managed state 换到 C: 盘再试，同样崩溃，仅路径变为 `lstat 'C:\'`。
3. 对照实验：在 AppContainer 内直接运行 `node.exe -e`：
   ```json
   {"realCwdErr":"EPERM","lstatRootErr":"EPERM","realHomeErr":"EPERM","realExeErr":"EPERM","realTmpErr":"EPERM"}
   ```
   即使 cwd、`USERPROFILE`、`TEMP`、exe 本身都已被显式授权，`realpathSync` 仍然全部失败。

**根因：** Windows 上 `fs.realpathSync` 会从卷根逐级 `lstat`。AppContainer 令牌没有卷根（`C:\`、`D:\`）的读属性权限，因此**任何绝对路径的 realpath 都失败**——与该路径本身是否被 ACL 授权无关。这不是 Tempt Room 授权写错，而是 AppContainer 与“从根开始解析路径”的 Node 行为的结构性冲突。

**影响：** DSH Desktop CLI 在 `runDesktopCli()` 的第一步 `installOfficeEngineResolution()` 就调用 `realpathSync(runtimeDir)`（`cli.js` 第 36–38 行，`runtimeDir` 为 `<runtime>\resources\app.asar\dsh`），因此**必然**启动失败。任何依赖 realpath 的 Node 工具（包括 DSH 的会话/凭据/插件路径解析）都会受同一问题影响。

**已验证的缓解方向：** 用 `-r <shim>.cjs` 在入口前预载补丁（不能走 `NODE_OPTIONS`，见 P0-3），把 `realpathSync` / `realpathSync.native` / `fs.promises.realpath` 的 `EPERM` / `EACCES` / `ENOENT` 降级为 `path.resolve(...)`。沙箱内实测：

- `globalThis` 补丁在 ESM main 之前生效；
- ESM 具名导入 `import { realpathSync } from 'node:fs'` **也会拿到补丁后的函数**；
- 补丁后 `realpathSync('C:\\')`、`realpath(process.cwd())` 均恢复正常；
- 用它启动 DSH 后，进程**越过了该崩溃**，进入下一阶段（见 P0-2）。

**建议：**

- 在 Node 侧把 shim 写入 staged runtime（`stageRuntime` 返回后可写同目录），launch args 注入 `-r <staged shim>`；
- shim 只在 `EPERM/EACCES/ENOENT` 时降级，其他错误照常抛出；
- 必须做安全评审：realpath 的语义被放宽后，符号链接/重解析点的约束需由外层沙箱与 staging 的“拒绝重解析点”规则兜底（项目已有此规则）；
- 长期看，更稳的路线是 DSH 上游对未打包/AI 沙箱环境提供“realpath 失败可降级”的开关；本反馈建议把 shim 作为兼容层并记录版本约束。

### P0-2 修复 realpath 后，DSH 卡在 AppContainer 私有临时目录缺失，ACP 未就绪

**现象：** 使用 `-r` shim 后 DSH 能继续启动，stderr 显示：

```
spill-local (@deepseek-ai/dsh-spill-local): Error: ENOENT: no such file or directory,
  mkdtemp 'D:\...\.state\dsh-sandbox-shim-...\home\AppData\Local\Packages\temptroom.<guid>\AC\Temp\dsh-spill-XXXXXX'
    at privateRoot (...\dsh-spill-local\lib\index.js:35:18)
...
fs-sandbox (@deepseek-ai/dsh-fs-sandbox): failed to import
tool-workflow (...): pending (waiting for service: workflowEngine)
```

继续等待 180 s，ACP `initialize` 仍无响应（进程未退出，但 app boot 未完成）。

**分析：** DSH 在检测到 AppContainer 后，按 Windows AppContainer 的 `GetTempPath2` 语义把私有临时根定位为 `%LOCALAPPDATA%\Packages\<package-moniker>\AC\Temp`。Tempt Room 把 `LOCALAPPDATA` 重定向到隔离 home（`home\AppData\Local`），但该 Packages 目录树不存在；真实用户 `C:\Users\...\AppData\Local\Packages\...` 里的目录不会也不能被用到。于是 DSH 的私有 spill 根创建失败，并可能级联导致 `fs-sandbox` 等 bundle 加载失败。

**建议：**

1. C# 宿主在 `CreateAppContainerProfile` + 授权 home 之后，预建隔离 home 下的相应目录树（ACL 继承自 home 的可写授权），至少：
   `home\AppData\Local\Packages\<profileName.ToLowerInvariant()>\AC\Temp`
   并顺带创建 `AC\INetCache`、`AC\INetCookies`、`AC\LocalCache` 等常见子目录（以 DSH 实际需要的为准）。
2. 与 DSH 确认是否有环境变量/配置可直接指定 spill/temp 根（若有，优先用配置，免去目录猜测）。
3. 修复后重跑本实验，确认 `fs-sandbox` 导入失败是否只是级联；若仍失败，需要 DSH 侧给出该 bundle 的失败原因（当前 stderr 信息不足）。
4. 建议把沙箱子进程的 stderr 尾部纳入 Run 诊断（现在只有进程退出时才概括性给出 `sandbox.error`），否则现场无法定位。

> 说明：P0-2 的实验是绕过 Node 侧探针门禁、直接向 `RoomSandbox.exe` 发送 `launch` 完成的，仅用于定位；产品路径仍要求探针全绿（见 P0-4）。

### P0-3 启动器形态、参数与环境注入不匹配

**代码现状：**

- `apps/server/src/adapters.ts` L113：deepseek 分支固定 `args=['--profile','acp']`；L102–103 只注入凭据变量；L118 的 `launch` 没有启动参数/环境扩展。
- `apps/server/src/sandbox.ts` L70：`stageRuntime` 只接受 `.exe`，错误文案还指向不存在的 `dsh.exe`。
- `packages/protocol/src/index.ts` L16–25 的 `AgentDescriptor` 没有 `launchArgs` / 启动环境字段；`apps/web/src/main.tsx` 的 Agent 表单也没有对应输入项。
- `sandbox/RoomSandbox/SandboxProcess.cs` L64：宿主自己设置保留的 `NODE_OPTIONS="--preserve-symlinks --preserve-symlinks-main"`；L67–72 拒绝 spec 覆盖任何已存在变量（`PATH` 完全禁止）。**因此预载补丁不能通过 `NODE_OPTIONS` 注入，只能通过命令行 `-r`。**

**本机实际可用的启动方式（已实测）：**

```text
<runtime>\DeepSeek Harness.exe
  --expose-internals
  -r <runtime>\tempt-realpath-shim.cjs
  <runtime>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js
  --profile acp
env: ELECTRON_RUN_AS_NODE=1
```

直接把 `DeepSeek Harness.exe` 当作 `executable`、只传 `--profile acp` 会以 **GUI 模式**启动 Electron，不会提供 ACP；缺 `ELECTRON_RUN_AS_NODE=1` 时也不会进入 Node CLI 模式。`ELECTRON_RUN_AS_NODE` 不在宿主的保留变量表中，可经 `LaunchSpec.environment` 注入；`NODE_OPTIONS` 不行。

**建议（二选一）：**

- **方案 A（推荐，改动小且语义清晰）：** 在协议/UI 增加可选 `launchArgs: string[]` 与 `launchEnv: {name,value}[]`（密钥仍只存变量名）；适配器 deepseek 分支优先使用它们；或直接做“DSH Desktop 形态自动识别”：当 `basename(executable) === 'DeepSeek Harness.exe'` 且同目录存在 `resources\app.asar` 时，自动使用上述完整 argv 与环境。这样用户只需在 UI 里选一次可执行文件。
- **方案 B（零改项目代码，但更重）：** 自建 `dsh.exe` 原生 shim（接收 `--profile acp`，内部组装上述 Electron 命令），再把 `executable` 指向它；仍需自备 curated runtime 目录（见 P1-5）。方案 B 仍要求宿主修 P0-1/P0-2，否则 shim 只是把同样的崩溃延后。

### P0-4 沙箱探针未就绪（先决条件，与 DSH 无关但必须先行）

最新诊断（`.state/diagnostics/sandbox.json`）：

- `ready:false`；
- `node-toolchain`：15 s 超时（只有 `The operation has timed out.`，没有子进程输出）；
- `git-toolchain`：`git version 2.55.0.windows.2` 能跑，但 `git init` 失败于 `unable to create directory for ...\workspace\.git\HEAD`。

当前 `SandboxHost.launch()`（`sandbox.ts` L56–60）在 `ready:false` 时直接返回 503，因此**在探针全绿之前，任何 DSH 接入验证都无法在正式路径上完成**。

**建议：**

1. `node-toolchain`：超时后保留部分 stdout/stderr（现在 `RunTool` 在 `WaitForExitAsync` 超时后 kill，输出丢失）；先确认是否首次冷启动/杀毒扫描导致，再加一次重试与更长的首跑超时；若可复现，缩小到“直接运行 node.exe + 单行脚本”定位。
2. `git-toolchain`：单独在探针 workspace 复现 `git init`，检查 `.git` 目录的创建/继承 ACL、低完整性标签继承与 `AppContainer` 对“目录内再建目录/文件”的权限；同时确认不是 `.git/HEAD` 的 ref 模板逻辑问题。
3. 探针通过后再按第 6 节的顺序做 DSH 冒烟。

---

## 3. P1 兼容性问题

### P1-5 模型配置值格式：直接填模型名必失败

**实测（`session/new` 返回的 `configOptions`）：**

```json
{"id":"model","category":"model","type":"select",
 "currentValue":"[\"deepseek-official\",\"deepseek-v4-flash\"]",
 "options":[{"value":"[\"deepseek-official\",\"deepseek-v4-flash\"]","name":"deepseek-v4-flash"}, ...]}
```

`session/set_config_option` 的行为：

- `value: "deepseek-flash"` → `error -32602 Invalid params: unknown model option: deepseek-flash`
- `value: "[\"deepseek-official\",\"deepseek-flash\"]"`（JSON 序列化的 provider/model 对）→ **成功**

**问题：** `adapters.ts` L156 把 `agent.model` 原样提交；UI 只有“模型名称”输入框且无说明。按 README 让用户填 `deepseek-flash` 之类的名字会直接导致 run 失败。

**建议：**

- 默认让 `model` 留空（实测默认即 `deepseek-v4-flash`）；
- 或适配器在 `session/new` 后从 `configOptions.options[].name` 匹配用户输入，再提交对应的 `value`；
- 或在 UI 中把该字段说明为“ACP 广告的序列化值”，并提供下拉。

### P1-6 `session/resume` 的 cwd 约束与“每轮新工作区”冲突

**实测：**

- 相同 cwd、进程被 SIGTERM 终止后再启动 → `session/resume` 成功（idle 会话可恢复）；
- 不同 cwd → `error -32602 Invalid params: session cwd does not match: <path>`；
- `session/close` 返回 `{}`，可正常关闭。

**问题：** `apps/server/src/worker.ts` L89 每次 run 都新建 `...\sandboxes\<runId>\workspace`；而 L95–104 对聊天运行持久保存 `nativeSession`（`room:agent:chat`）。于是第二次 `@DeepSeek` 会带同一个 sessionId、却用新的 workspace 路径去 resume，DSH 必然拒绝。

**建议：**

- 聊天（无任务）会话固定 workspace（如 `sandboxes\chat\<roomId>_<agentId>`），任务仍使用独立快照工作区；
- 或在适配器里对 resume 失败做一次 `session/new` 回退（会丢失 DSH 侧会话历史，需在能力说明中标注）；
- 两者可同时做：先固定 workspace，回退作为兜底。

### P1-7 运行目录 staging：体积余量、必须包含的 unpacked 包、拷贝语义

**体积（实测）：**

| 方式 | 大小 | 文件数 | 与 `stageRuntime` 上限（1,024 MiB / 20,000） |
|---|---|---|---|
| 完整安装目录 | **1,015.0 MiB** | 9,772 | 仅剩约 **9 MiB** 余量，DSH 一次升级就可能超限 |
| 精简 runtime（本实验采用，沙箱外 ACP 已验证） | **676.3 MiB** | 1,518 | 余量充足 |

精简 runtime 组成（均可从安装目录复制）：

```text
runtime\
  DeepSeek Harness.exe  + 全部顶层 DLL/pak/dat/bin/json（317.9 MiB / 20）
  resources\app.asar                                  （115.7 MiB / 1）
  resources\app.asar.unpacked\                        （242.7 MiB / 1,497）
```

**重要的坑：`resources\app.asar.unpacked` 不能只挑 `dsh-desktop-host`。** DSH 启动时会枚举安装 scope 的包清单；只复制部分 `@deepseek-ai` 包会在 boot 阶段直接失败：

```
Error: ENOENT: ...resources\app.asar.unpacked\dsh\node_modules\@deepseek-ai\libreoffice-kit\package.json
```

带完整 `app.asar.unpacked` 的精简 runtime（676.3 MiB）在沙箱外实测 `initialize` / `session/new` / `session/close` 全部成功，说明可以排除 `resources\runtime`（290.0 MiB / 8,194 files，主要给 Office/插件包管理用，ACP 编码会话不依赖）、`locales` 与卸载器。**如需在沙箱内使用 Office 技能，需要另行验证 `resources\runtime`。**

**拷贝语义问题（`sandbox.ts` L76–88）：**

- 没有临时目录/`complete.json`/原子 rename：中断会留下“半套 runtime”，下次直接复用；
- 只复制**不存在**的文件：runtimeDirectory 更新后旧文件不刷新，且不校验内容；
- 指纹只取 `executable` 的哈希：DSH 升级只换 asar/plugin 时不会换目录，可能静默使用陈旧运行文件。

**建议：** 直接照搬 `apps/server/src/toolchain.ts` L48–61 的成熟模式（`.preparing-<uuid>` 临时目录 + `complete.json` + `rename`），并把 DSH 版本/`app.asar` 哈希纳入指纹；同时把“精简 runtime 复制”做成脚本或文档步骤，避免用户直接指向 Program Files（会因体积/文件数超限失败）。

**磁盘/耗时提示：** 现有 `.state\runtimes\tools` 已 369.5 MiB / 2,565 files；再加一份 DSH runtime 约 +676 MiB；首次 staging 实测约 3–4 秒（本机 SSD）。

### P1-8 凭据注入可行，但错误信息会带出密钥掩码片段

**已验证：**

- 在 launch env 中放 `DEEPSEEK_API_KEY=sk-invalid-probe-key`，`session/prompt` 返回：
  `-32603 Internal error: turn failed: Authentication Fails, Your api key: ****-key is invalid (request_id: ...)`
  说明 **launch env 被 DSH 凭据层采用**，不需要复制 `.credentials.yaml`，隔离 home 是正确方向。
- 但该错误文本会经 `worker.ts` L126 写入 `run.error`（截断 2000 字符）并随 `run.updated` 事件进入房间/UI。密钥末 4 位 + request_id 属于不该公开的运维信息。

**建议：** 适配器对 provider 错误做统一脱敏（去掉 `****` 片段、`Authorization`、URL 查询参数、request_id 等），或至少不把原始 provider 文本广播到房间，只在服务端日志保留。

### P1-9 stdout 解析的容错与诊断

**已验证：** 临时 `DSH_HOME` 下，DSH ACP 的 stdout **只有** JSON-RPC 行（无 banner/日志），所以 `NativeChannel` L47–53 的“任何非 JSON 行即 kill”在当前 DSH 上没有误伤。但这是“尚未安装任何插件/补丁”的干净 profile；用户 profile 若装插件、或 DSH 版本更新改变输出，仍可能触发 kill。同时 stderr 只在进程退出时被概括成 `sandbox.error`，现场诊断很弱（P0-2 就是例子）。

**建议：**

- 启动期容忍 N 行非 JSON（记录而非立即失败），或与 DSH 明确“stdout 仅协议”的契约并在诊断里显式检查；
- 把 stderr 尾部（例如最近 8 KiB）附到 Run 诊断/错误中，便于定位 boot 失败。

---

## 4. P2 行为与工程问题

| # | 问题 | 说明与建议 |
|---|---|---|
| P2-10 | 取消/结束只用 Job kill，未用 ACP `session/cancel` / `session/close` | `adapters.ts` L78/L81–83 通过 `host.cancel` 杀进程树；实测 SIGTERM 后 idle 会话可 resume，但流式/推理中被杀是否留下不可恢复的 active 会话未验证。建议先发 ACP cancel/close（有超时兜底）再 kill，保留“进程树已归零”的证据。 |
| P2-11 | 无中途补充输入、无 token/费用统计 | `capabilitiesFor('deepseek')` 已声明 `input:false, usage:false`，与 DSH ACP 实际一致（单 prompt、无 usage 字段）。建议在 UI/文档明确说明，避免用户把 `run.input` 用在 DSH 上。 |
| P2-12 | 双上下文：房间快照 + DSH 自身会话历史 | `worker.ts` L59–66 把最近 40 条消息/决策拼进 prompt；chat 模式 resume 又让 DSH 保留自己的历史，两者可能重复或冲突。建议：聊天模式精简 prompt 或固定“房间快照为唯一事实”；任务模式用新 session。 |
| P2-13 | 文档/文案与实测不一致 | README L56 仍写“官方 Windows runtime 的 `dsh.exe`”；ACCEPTANCE L20 写“DeepSeek 可执行文件缺失”；`sandbox.ts` L70 错误文案同样指向不存在的 `dsh.exe`；SANDBOX.md 仍描述“11 项基础检查”，而当前探针已 17 项且 2 项失败。 |
| P2-14 | 缺少 ACP 模拟测试 | `tests/adapters.test.ts` 只覆盖 A2A 与 NativeChannel；建议加 mock ACP server，覆盖 `initialize`、`session/new`（含 MCP 声明）、`set_config_option` 的值匹配、`session/prompt` 流、`request_permission` 应答、`session/cancel`/`close`、resume cwd 校验。 |
| P2-15 | `diagnose()` 不做 ACP 握手 | 现在只查“可执行文件存在 + 沙箱探针”；建议加一次无模型调用的 `initialize`（甚至 `session/new`）握手，零 token 成本，能把 P0-1/P0-2 这类问题提前到配置界面暴露。 |
| P2-16 | PATH 中没有 `dsh` 命令 | Desktop 提供命令安装功能（`runtime\cli\command-manager.js`），但本机未安装到 PATH。文档需要写明“用 Desktop 设置安装命令，或直接使用安装目录路径”，不能让用户以为 `dsh` 一定可用。 |
| P2-17 | runtime 匹配错误信息误导 | `sandbox.ts` L70 的“DeepSeek 可使用官方 Windows runtime 的 dsh.exe”会引导用户找不存在的文件；应改为“Desktop CLI = DeepSeek Harness.exe + app.asar cli.js（需要适配器支持启动参数）”。 |

---

## 5. 已实测通过的 ACP 兼容性事实（供实现直接参考）

实验方式：用本机 Desktop CLI 在**沙箱外**、隔离 `DSH_HOME`（临时目录）下直接说 ACP v1；不调用模型、不产生费用（唯一一次 prompt 使用无效密钥，认证失败，无 token 计费）。

| 场景 | 请求 | 结果 |
|---|---|---|
| `initialize` | `{protocolVersion:1, clientCapabilities:{}, clientInfo:{name:"tempt-room",version:"0.1.0"}}` | `protocolVersion:1`，`agentInfo {name:"deepseek-harness-acp",version:"0.0.1"}`，`agentCapabilities {mcpCapabilities.http:true, sessionCapabilities:{close,list,resume}, promptCapabilities.image:false}`，`authMethods:[]` |
| `session/new` + room MCP 声明 | `{cwd:<abs>, mcpServers:[{name:"room", command:<node>, args:[room-bridge.mjs], env:[{name:"ROOM_PIPE",value:"..."}]}]}` | 成功返回 `sessionId` + `configOptions`（`model`、`reasoning_effort`），说明 Tempt Room 的 MCP 声明形状兼容 |
| `session/set_config_option` | 普通模型名 | `-32602 unknown model option` |
| `session/set_config_option` | 序列化对 `["deepseek-official","deepseek-flash"]` | 成功，返回完整 configOptions |
| `session/close` | `{sessionId}` | `{}` |
| `session/resume` | 同 cwd、进程 SIGTERM 后 | 成功（含 configOptions） |
| `session/resume` | 不同 cwd | `-32602 session cwd does not match` |
| `session/prompt` | 无效 `DEEPSEEK_API_KEY` | `-32603 Internal error: turn failed: Authentication Fails...`（证明 launch env 凭据生效） |
| 隔离 `DSH_HOME` | 全新空目录 | 自动创建 `profiles/acp`、`sessions`、`storages`，无需复制用户配置；stdout 无噪声 |

**结论：ACP 层不需要改协议；需要改的是“怎么把 DSH 启动起来”（P0-1/2/3）与“怎么使用它”（P1-5/6/7 等）。**

---

## 6. 建议的最小改动顺序

1. **修探针（P0-4）**：先让 `npm run test:sandbox` 17/17 通过；否则正式路径不会 launch。
2. **沙箱宿主兼容层（P0-1/P0-2）**：
   - 支持向子进程命令行注入 realpath shim（由 Node 侧写入 staged runtime，`-r` 预载）；或上游 DSH 提供降级开关；
   - 预建 AppContainer 私有 `Packages\<moniker>\AC\Temp` 等目录（隔离 home 下，继承可写 ACL）；
   - 补 stderr 诊断输出。
3. **启动器与配置（P0-3 + P1-5 + P1-8）**：
   - `AgentDescriptor` 增加 `launchArgs`/`launchEnv`（或 DSH Desktop 自动识别）；
   - `adapters.ts` deepseek 分支注入 `ELECTRON_RUN_AS_NODE=1`、`-r shim`、完整 cli.js 参数；
   - 模型值按 configOptions 匹配/留空；provider 错误脱敏；`diagnose()` 加 ACP 握手。
4. **会话与工作区（P1-6）**：聊天固定 workspace，任务用快照；resume 失败回退 new session。
5. **staging 加固（P1-7）**：atomic + complete 标记 + 指纹含 DSH 版本；提供精简 runtime 准备脚本/文档。
6. **文档与验收（P2-13/14/16）**：更新 README/ACCEPTANCE/SANDBOX 与错误文案，补 ACP mock 测试。
7. **验收顺序（建议）**：
   - 沙箱外 ACP 握手（本反馈已通过）；
   - 沙箱内 ACP 握手（P0-1/P0-2 修复后，无模型调用）；
   - 房内 MCP 工具（`room_read`/`room_post`/`task_propose`/`artifact_publish`）；
   - 取消、resume、重启恢复；
   - 显式付费的真实 prompt 冒烟（`npm run test:agents -- --allow-paid` 需先关闭同 `.state` 服务）；
   - 任务快照 → 文件修改 → diff → 应用。

---

## 7. 安全边界（接入过程中不可退让）

- 启动令牌绝不交给 Agent；外部 TS 客户端只是人类客户端，不能作为 Agent 身份。
- DSH 必须使用隔离 `DSH_HOME`（宿主已设置 `<home>/dsh`），不复制用户 `.credentials.yaml`、不复制安装目录之外的配置；密钥只走启动环境变量。
- 沙箱未通过时不得以无沙箱模式兜底（当前 `launch()` 的 503 是正确的，不要为了“先跑起来”绕开）。
- realpath shim 属于“放宽运行时语义”的兼容层，需要安全评审并固定 DSH 版本；不得用它绕过工作区/路径边界（外层 AppContainer 仍是唯一真实边界）。
- 真实模型测试必须由用户显式触发，普通测试不消耗模型额度。

---

## 8. 附录：本次实验记录与清理

| 实验 | 目的 | 结果 |
|---|---|---|
| 沙箱外 ACP 握手（Desktop CLI，临时 `DSH_HOME`） | 验证 initialize/new/close/resume/prompt 错误路径、凭据 env、stdout 洁净性 | 全部符合预期（见第 5 节） |
| 精简 runtime（676.3 MiB）沙箱外启动 | 验证可裁剪 `resources/runtime` 与 LibreOffice | 握手成功 |
| D: managed state 内 launch DSH | 验证 AppContainer 内可行性 | `EPERM lstat 'D:\'`，exit 1（P0-1） |
| C: managed state 内 launch DSH | 排除盘符 ACL 偶发因素 | `EPERM lstat 'C:\'`，exit 1（P0-1） |
| AppContainer 内 node 直接测 realpath | 定位根因 | cwd/home/exe/tmp 全部 `EPERM`（P0-1） |
| `-r` 预载 realpath shim 测试 | 验证缓解方案 | ESM 具名导入生效；realpath 恢复；DSH 越过崩溃进入 boot（P0-2） |
| 沙箱外 ACP 契约细节测试 | 确认 MCP 声明、configOptions、resume cwd | 见第 5 节 |

- 本次反馈只读代码并做隔离实验，**未修改任何项目源码**；
- 实验产生的 `DSH_HOME`、runtime 副本、临时 JSON 与 `.state` 下测试目录已全部清理；
- 所有命令执行环境：Node v24.14.0、npm 11.9.0、`RoomSandbox.exe` 为 17:33:40 构建版本；
- 若需要，我可以按第 6 节顺序开始实现修改（先修探针与沙箱兼容层，再改适配器），并把每一步的验证结果追加到本文件。
