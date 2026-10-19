# Windows 原生执行边界

本实现选择 AppContainer、目录 ACL、低完整性标签、Job Object 和受限 named pipe。运行模型不需要 Docker/WSL。**2026-10-17 22:20 本机最新探测 23/23 通过；DeepSeek Harness Desktop 已在隔离内完成 ACP 会话、真实模型轮次与群聊 MCP 验证。** 其他 Windows 环境、Codex/Claude 与 Office 裁剪仍需复测，不能以编译/模拟测试替代正式验收。

## 本机直连模式（显式、非默认）

每个本地 Agent 可单独选择「本机直连」。该模式**不经过本节沙箱**：应用直接以当前 Windows 用户身份启动 Agent 进程，继承完整用户环境（文件系统、网络、loopback、已安装工具链、自身登录状态），聊天工作区按房间共享，任务直接使用真实 `projectPath`（不复制快照），完成后发布 Git 状态变更清单而不是可应用的补丁交付物。它解决的是“Agent 无法使用本机资源、嵌套沙箱互相冲突、快照上限卡住任务”等能力问题，代价是**没有系统级隔离**：Agent 能读写当前用户可访问的任意文件与凭据，只应对可信 Agent 显式开启。沙箱仍是默认模式，不会因失败自动回退到本机直连；远程/A2A Agent 应继续使用沙箱。DSH 本机直连使用隔离的 `DSH_HOME` 并通过 acp profile 的 MCP band 挂载房间工具；Claude/Codex 的本机直连尚未实测。

## 启动顺序

Node 先诊断，C# 宿主创建每次运行专属 AppContainer profile。仅指定 workspace、隔离 home 可写，运行文件只读；必要系统组件由 Windows ACL 决定。进程以 suspended 状态启动，绑定 Job 并读取真实 AppContainer token；全部成功才发出启动证明并恢复线程。失败清理，不回退到 CreateProcess 的普通模式。

Job 设置 kill-on-close、总内存上限 4 GiB、64 个进程；根进程退出时终止剩余子进程，查询 Job 的 activeProcesses 为零后才报告 sandbox.exit。宿主 stdin 断开时终止活动 Job。失去退出证明会显示状态未知。

环境变量显式构造：SystemRoot、受控 PATH、隔离 HOME/USERPROFILE、TEMP、各 Agent HOME；仅注入所选提供方的密钥。不继承宿主完整环境、用户配置、代理或其他提供方凭据。不得选择包含个人配置的 runtimeDirectory。

原生沙箱的放宽模式仅影响沙箱内工具审批。外部文件应用、配置变更、任务版本及决策接受仍由服务端控制。Agent 没有修改这些边界的协议操作。

## 网络与 IPC

AppContainer 只申请 internetClient capability，不申请 privateNetworkClientServer，也不配置 loopback exemption。实际可达性必须由探测认证；网络类别、系统策略和宿主已有豁免均可能影响结果。本实现尚未完成所有 Windows 网络环境的验证，不宣称这等同于经过验证的全量出站防火墙。

API/A2A 出站请求另外使用 HTTPS、DNS 解析后公网地址验证、连接地址固定、禁重定向，拒绝 loopback、私有、链路本地、保留范围和常见 IPv6 映射/转换绕过。此检查只约束服务端 HTTP 适配器，不替代本地进程的系统隔离。

群聊桥使用 `LOCAL\TemptRoom-<run>` named pipe，只授予宿主用户和该 AppContainer SID，设置低完整性标签；连接后还验证客户端进程属于当前 Job。管道帧限制 1 MiB，工具限定当前房间和当前运行。

## 工作区与成果

工作区来自明确项目路径的文件快照。Git 项目重建独立仓库和基线提交，记录原始 sourceCommit；不复制历史对象、remote、hooks 或共享 .git 元数据，以免被删除的凭据仍通过历史泄漏。非 Git 项目使用文件清单和内容哈希。

默认过滤 `.env*`、常见凭据文件、密钥、用户 Agent 配置、依赖和构建目录。过滤按文件名进行，不能检测任意业务文件中硬编码的密钥；选用的项目仍应先自行清理。单快照最多 200 MiB/20,000 文件。拒绝符号链接、越界路径、ADS、Windows 设备名等。选定附件复制到本次隔离 home，不复制完整用户目录。

成果应用先检查全部基线哈希，然后写入备份日志，更新文件；普通错误尝试回滚。崩溃后存在未完成日志时阻止后续应用并要求人工核对。当前没有跨外部编辑器的文件系统事务，应用时应停止其他程序同时写入相同文件。

## 探测与当前结果

`npm run test:sandbox` 真正尝试启动 AppContainer，检查 token、Job、工作区写入、未授权文件与应用数据拒绝、宿主进程拒绝、IPv4/IPv6 loopback 拒绝、私有 IPv4/IPv6 接口拒绝、公网 HTTPS、子进程隔离、群聊 IPC、Node 管道子进程、npm、Git、Shell、取消及宿主异常退出后的进程树归零。另启动两个不同身份的 AppContainer，检查彼此的文件、进程权限与精确 IPC 路径不可访问。跨沙箱文件和 IPC、网络拒绝检查先做宿主或所属身份的可达对照；没有可用私有测试接口时不能认证，而非默认为通过。应用数据检查使用真实数据库，目录尚无数据库时使用受保护 canary。报告保存在所选数据目录的 `diagnostics/sandbox.json`；工具超时保留部分 stdout/stderr。

2026-10-17 20:01 在独立 `.state/native-recheck-20261017` 目录重跑：20/22 通过。私有 IPv6 本机对照为链路本地地址；跨沙箱文件、分别请求的进程权限和 IPC 均通过。Node 在创建管道子进程处超时，Git 初始化失败。报告与测试目录保留，默认 `.state/diagnostics/sandbox.json` 的历史 15/17 结果没有被覆盖。

2026-10-17 22:20 在默认数据目录重跑：**23/23 通过**，Node 管道子进程、npm、Git（reftable）初始化、跨沙箱文件/进程/IPC 拒绝均通过；`ready=true`。随后完成真实 DSH Desktop 0.2.0-rc.2 接入验证：隔离内 ACP `initialize`/`session/new`、真实模型轮次、连续会话复用、群聊 MCP `room_read`/`room_post` 均通过。期间修复两项宿主层阻塞：**IPC stdin 未按 UTF-8 解码**（含中文的帧会被错误解码并拒绝，表现为 45 秒 `input` 超时）以及**聊天工作区缺少 Git 基线**（DSH 的项目根发现会 realpath 工作区祖先，而兼容层只声明 staged 根）。这两项均只影响宿主/工作区准备，不扩大 AppContainer 的文件或网络边界。

2026-10-17 已定位并修复初始失败：项目盘继承的 DACL 仅给当前账户 Modify；设置完整性标签需要 WRITE_OWNER。应用仅在当前账户拥有的管理目录设置明确所有者 FullControl 和 SYSTEM ACL，未修改原项目或全局 ACL。管道改为直接带安全描述符创建，并放入对应 AppContainer 的命名空间；公网探测显式关闭系统代理。基础探测现已通过。

当前 Node/libuv 的 AppContainer 管道命名缺陷见 [Node #66374](https://github.com/nodejs/node/issues/66374)，realpath 祖先查询问题见 [Node #66375](https://github.com/nodejs/node/issues/66375)。`--preserve-symlinks` 只能绕开部分模块加载行为，不能修复管道或所有显式 realpath 调用。

新增 `room-realpath.cjs` 仅对本次宿主声明的 workspace/home/只读 runtime 根内路径，在 EPERM/EACCES 时逐级检查后回退到词法绝对路径；拒绝链接，保留 ENOENT 等错误，不把未授权路径变成可访问路径。该层改变部分运行时语义，需继续进行实际兼容性与边界验证。它不能作为宿主成果应用的路径验证器。AppContainer 自身的私有 Temp/缓存目录在隔离 home 下预建。

后续仍需完成 Codex/Claude 的真实隔离验收、DSH Office 裁剪目录、其他 Node/Git 版本与更多网络策略的组合验证。公共探测通过不能代替这些正式验收。[本地 Node 构建脚本](RUNTIME-BUILD.md)只准备兼容运行时路线，构建成功后仍需重跑完整探测。

官方机制参考：[AppContainer 创建](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)、[AppContainer 隔离](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)、[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)。
