# DeepSeek 第一轮反馈处理记录

来源为项目根目录 `Feedback_Deepseek_01.md`，保留原反馈不修改。本记录描述代码与验证状态，不表示 v1 正式验收通过。

最新状态见[2026-10-18 房间联调](ROOM-CHAT-TEST-20261018.md)和[当前原生兼容层](NATIVE-COMPATIBILITY.md)。下文按发生顺序保留历史故障；20/22、Clang 缺失等旧记录不表示默认 MSVC 兼容方案仍被阻塞。

## 已实施

- **P0-3 / P2-16 / P2-17：启动形态。** 识别 Desktop 的 `DeepSeek Harness.exe`，添加 `ELECTRON_RUN_AS_NODE=1`、`--expose-internals` 与 asar 内 CLI 入口；也支持经过 manifest 核对的官方 npm JS 入口。不会执行或解析 `.cmd`，不要求 PATH 中存在 dsh。
- **P1-5：模型选项。** 从 ACP 返回的选项按完整值或唯一名称匹配，提交 opaque value；无匹配或名称歧义时拒绝，空配置使用默认模型。
- **P1-6：会话 cwd。** 同一房间/成员的聊天工作区固定。会话缓存绑定程序、模型、配置与工作区；旧缓存及新任务快照不误用旧 cwd。不会在恢复失败后静默丢弃历史。
- **P1-7：运行文件。** 指纹覆盖全部选定文件内容；临时复制后重新核对内容，写完整标记再原子发布。Desktop 复制顶层文件、asar、完整 unpacked，保留反馈中指出的插件包清单。限额调整为 30,000 文件/2 GiB，不复制用户配置。依赖改变而 exe 不变也会产生新缓存。
- **P1-8 / P1-9：诊断。** 收集最多 8 KiB stderr 尾部；公开前去掉实际密钥、常见密钥格式、掩码片段、认证头、URL 查询凭据和 request_id。维持 stdout 仅协议 JSON 的契约，不把日志行当作协议继续执行。
- **P2-10：生命周期。** ACP 优先发送 `session/cancel`，最多等待 1.5 秒后仍由 Job 终止确认进程树归零；正常结束时尝试 `session/close`。Codex 也先尝试轮次中断。协议取消受理本身不构成已停止证明。
- **P2-14：模拟测试。** 新增 ACP v1 初始化、MCP env 数组、模型映射、输出、权限、close/resume/cancel、会话作用域、依赖缓存与诊断脱敏测试。
- **P2-15：无模型检查入口。** 新增 `npm run test:agent-protocols -- --agent=deepseek` 与设置界面按钮。DeepSeek 检查 initialize/session-new/模型选项/close，不发送 prompt。沙箱未通过时拒绝启动；Claude 仅查询版本，其结果不宣称证明流式协议兼容。
- **P2-13：文档。** README、ACCEPTANCE、SANDBOX 已删除“必须寻找 dsh.exe”和“只有 11 项基础探测”的过时描述。

## 已实现但仍待真实验证

- **P0-1：realpath。** 增加受限兼容层，并以显式 `-r` 预载到 Electron CLI；Node 子进程由宿主 NODE_OPTIONS 预载。只在允许根内、逐级验证无链接且目标存在时处理 EPERM/EACCES。没有采用对任意路径及 ENOENT 一律返回 path.resolve 的建议。模拟测试通过，DSH Desktop 的实际 boot 尚待复测。
- **P0-2：私有临时目录。** 在隔离 LOCALAPPDATA 内预建 profile 小写名称对应的 AC/Temp、INetCache、INetCookies、LocalCache。已编译，未证明其足以解决全部 DSH bundle 初始化问题。

## 仍未解决

- **P0-4：原生工具链门槛。** 最新实际结果为 20/22；Node 管道子进程超时、Git 仓库写入失败。工作区相对 Git 路径实验同样失败，未将它作为产品绕过方案。Node 上游已记录 libuv 的管道命名缺陷；realpath 兼容层不能修复该问题，Desktop 内嵌 Electron 也需要单独验证。
- **P2-11：能力范围。** DeepSeek 的通用中途输入、token/费用仍声明未知或不支持，不伪造字段。修改目标继续使用任务版本控制。
- **P2-12：上下文。** 已明确声明当前房间快照与任务版本为本轮事实，旧原生历史不产生新的执行授权；每轮使用持久化覆盖游标。仍会向有原生历史的会话发送快照，没有消除重复上下文或证明模型在所有冲突场景下正确处理。
- 三个真实 Agent 的模型、文件编辑、群聊 MCP 与完整协作验收仍由用户显式在本机运行。未执行付费模型请求。

## 本轮验证与外部限制

30 项无模型自动测试通过；TypeScript、SDK/Schema、生产构建与 .NET 编译通过。新的运行文件与启动兼容层尚无真实 DSH 沙箱启动成功证据。

本轮尝试使用独立测试数据目录启动生产界面复查新表单。服务已启动，但执行环境拒绝 loopback 套接字访问、浏览器连接超时，因此没有将本轮界面复查列为通过。测试服务已停止；没有改动用户正式 Agent 配置。

读取 Node/LLVM 官方构建依赖信息的升级命令被自动审批系统因额度耗尽而拒绝执行；工具明确说明不是安全判定。下载/构建兼容运行时暂未执行，未通过其他渠道绕过该审批。其余本地代码与测试继续完成。

## 后续复查（2026-10-17 20:01 起）

- 经新的执行审批，已在独立测试目录重跑原生探测：20/22 通过。私有 IPv6、应用数据 canary、跨沙箱文件/进程/IPC 均通过；Node 与 Git 两项失败保留。报告为 `.state/native-recheck-20261017/diagnostics/sandbox.json`。
- 无模型自动测试增至 49 项并全部通过；新增的 MCP 错误路径也做选定密钥及错误标识脱敏。运行文件、真实模型与浏览器验收状态没有因此改为通过。
- 新增[真实 Agent 完整场景验收入口](REAL-AGENT-ACCEPTANCE.md)，仅用户显式 `--allow-paid` 才进入模型场景，成果只应用到脚本自建测试项目。
- 新增[固定源码与 libuv 补丁的本地构建入口](RUNTIME-BUILD.md)。源码准备可在没有编译器时独立进行；本机缺少 Visual Studio Clang 组件，尚无已验证兼容二进制。先前审批失败记录保留为历史，不代表后续审批结果。
- 本轮浏览器复查已完成：资源设置、DeepSeek Desktop 连接字段和 API 结构化回复选项均保存并正确回显。使用独立测试数据库，没有启用真实成员；截图在 `docs/screenshots/`，测试预览服务已停止。
- 固定 Node 24.21.0 源码已与官方 SHA-256 比对，libuv 固定提交的 pipe.c 补丁已通过 `git apply --check` 并实际应用。Windows tar 的中文路径错误通过 Unicode 安全的 Python 提取修复，完整源码保留。编译仍因 Clang 组件缺失未执行，不能宣称修复了实际 Node 管道或 DSH Electron。

## 第二轮：实际隔离接入验证（2026-10-17 22:40 Asia/Shanghai）

- **修复 IPC 编码根因。** 真实轮次此前失败并非沙箱拒绝：C# 宿主 stdin 未按 UTF-8 解码，含中文的 IPC 帧（项目上下文模板即中文）被错误解码后 JSON 解析失败，表现为 `input` 请求 45 秒超时。宿主入口现显式设置 `Console.InputEncoding` / `Console.OutputEncoding` 为 UTF-8；含中文的 IPC 帧可正确解析，诊断文本也不再乱码。
- **修复 DSH realpath 祖先查询的接入侧表现。** 聊天工作区创建时补一个 Git 基线（幂等 `git init`，失败不阻断运行）。DSH 的项目根发现停在 workspace，不再 realpath 未声明的祖先目录；任务工作区原本已有 Git 基线。
- **实测通过。** 沙箱探测 23/23（`ready=true`）；隔离内 DSH Desktop 0.2.0-rc.2：ACP `initialize` / `session/new`、真实模型回复、同一原生会话连续三轮复用、`room_read` / `room_post` 经逐运行 named pipe、最终回复进入房间；另建全新房间（未手工初始化 Git）复测自动基线通过。
- **新增验证。** 无模型自动测试 51/51 通过；`npm run build:sandbox` 与类型检查通过。
- **范围不变。** 本机单版本、单提供方验证；Codex/Claude 真实轮次、DSH Office 裁剪目录、多 Windows 环境仍未验收，正式 v1 门槛不变。

## 第三轮：本机直连执行模式（2026-10-18 00:35 Asia/Shanghai）

- **背景。** 隔离内 DSH 的嵌套沙箱会因 AppContainer 权限失败（`SetNamedSecurityInfoW Win32 5: grantWrite`、项目根 realpath EPERM、ripgrep provider failure），导致 Agent 有文件工具但无法执行命令；同时任务快照上限（200 MiB / 20,000 文件）让指向大目录的任务瞬间失败，每个 Agent 的私有聊天工作区又使多 Agent 无法共享文件。用户明确要求接入 Agent 使用本机最高权限。
- **改动。** 新增每 Agent 可选执行权限：`sandbox`（默认）与 `host`（本机直连）。host 模式直接以当前 Windows 用户启动 Agent 进程，继承完整环境；不复制运行文件、不建快照，任务直接使用真实项目目录，完成后发布 Git 状态变更清单；聊天工作区按房间共享。取消/退出通过进程树终止与退出确认处理。
- **DSH room MCP。** 托管启动上下文里 ACP `session/new` 的 `mcpServers` 声明可能被忽略；host 模式改用隔离 `DSH_HOME`，在 acp profile 写入 `@deepseek-ai/dsh-mcp-client` band，并把每次运行的 `ROOM_PIPE` 经环境传入，房间工具因此稳定挂载。
- **实测。** DSH 本机直连聊天：`room_read` 成功、shell 可执行 `node -v`/`git --version`、读取真实 `package.json` 与用户主目录；任务：直接在真实 Git 项目改 `version` 并新增文件，任务 completed、无快照、生成“本机变更清单”报告交付物。`tsc`、`vite build` 通过，自动测试 52/52。
- **未覆盖。** Claude/Codex 的本机直连、插件/MCP 外部接入、多 Agent 同时编辑同一项目的冲突策略；这些留待后续轮次。
