# Windows 部署教程

[返回首页](../README.md) · [下一步：接入 Agent](AGENT-SETUP.md)

本教程从源码部署本地单用户的 Tempt Room。当前不提供安装包，也不支持把服务直接部署到 Linux、Docker、云主机或局域网。浏览器、应用服务和原生执行宿主都运行在同一台 Windows 电脑上。

## 1. 安装前置工具

使用 Windows x64。建议使用受支持的 Windows 11，并先更新系统。准备：

- [Node.js 24+](https://nodejs.org/en/download)，使用 x64 版本，包含 npm。数据库依赖内置 `node:sqlite`。
- [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0)，仅安装 Runtime 不能编译执行宿主。
- [Git for Windows](https://git-scm.com/downloads/win)，让 `git.exe` 可以在终端中找到。
- [Visual Studio 2022 / Build Tools](https://visualstudio.microsoft.com/downloads/)：「使用 C++ 的桌面开发」工作负载，包含 MSVC x64/x86 编译工具和 Windows SDK。构建脚本通过 `vswhere.exe` 查找这些组件，不要求在 Developer Command Prompt 中运行。
- 任一现代浏览器。自动化浏览器验收另外要求本机 Edge 或 Chrome。

Room 不需要 Docker 或 WSL，也不自动安装编程助手。Codex、Claude Code 或 DeepSeek Harness 由用户另外安装；先体验演示成员不需要它们。

安装后重新打开 PowerShell，检查：

```powershell
node --version
npm --version
dotnet --list-sdks
git --version
```

确认 Node 主版本至少 24、SDK 列表存在 `10.0.x`。默认的小型管道兼容模块只需要 MSVC；[完整 Node 重编路线](RUNTIME-BUILD.md)是可选项，不是常规部署步骤。

## 2. 下载源码并构建

选择自己的开发目录，在 PowerShell 执行：

```powershell
git clone https://github.com/privateAccountOfLiu/tempt-room.git
cd tempt-room
npm ci
npm run build:sandbox
npm run build
```

`npm ci` 按仓库锁文件安装依赖。`build:sandbox` 编译 .NET 宿主和 C++ Node 管道模块；`build` 检查 TypeScript、构建协议/客户端、浏览器界面和应用服务。两个构建命令都需要成功。所有后续命令都从仓库根目录执行，以便找到宿主和桥接脚本。

本项目使用 Vite 构建浏览器代码、Fastify 同时提供页面和 API；无需额外启动一个前端端口或另装数据库。构建时的浏览器 chunk 体积提示不等同于构建失败，应以退出码为准。

## 3. 启动并打开界面

```powershell
npm start
```

终端会输出 `http://127.0.0.1:4317/#session=...`，使用完整地址打开。浏览器会把启动凭据交换成 HttpOnly、SameSite=Strict Cookie，并从地址栏移除凭据。**完整启动地址、数据目录里的 token 文件都属于本机凭据**，不要贴进 Issue 或截图。

保留该终端运行。停止服务使用 `Ctrl+C`，确认运行结束后再关闭终端。服务已经启动时可以另开终端执行：

```powershell
npm run open
```

此命令打开已有实例，不会重新启动服务。登录丢失时也可在重连页面粘贴本机的启动地址或令牌。正常重启会复用数据目录中的会话密钥，外部 Agent 令牌不会因此失效。

若需要修改源码并热更新界面，使用：

```powershell
npm run dev
# 或自动打开默认浏览器：
npm run dev:open
```

开发服务的后端代码修改仍需重启；不要把浏览器的热更新当成服务端已重新加载。

## 4. 配置端口与数据目录

默认端口 `4317`，默认数据目录为仓库内 `.state`。如需把长期数据放在仓库之外，在每次启动、备份和恢复前使用相同设置：

```powershell
$env:ROOM_PORT = '4317'
$env:ROOM_STATE_DIR = 'D:\TemptRoomData'
npm start
```

数据目录保存 SQLite、消息、Agent 配置、运行记录、工作区、交付物和本机凭据。目录需要可读写，避免放在同步盘、共享网络盘或另一个项目的任务目录里。一个数据目录只能有一个服务实例。源码目录本身也需要可写，构建会生成 `dist` 与沙箱输出。

常用环境变量：

- `ROOM_PORT`：本地监听端口；修改后需更新外部 MCP 的 `ROOM_URL`。
- `ROOM_STATE_DIR`：数据根目录，建议指定绝对路径。
- `ROOM_OPEN_BROWSER=1`：启动时打开浏览器。
- `ROOM_ROTATE_SESSION=1`：显式轮换会话密钥，使旧浏览器会话和外部 Agent 令牌失效；使用一次后移除此变量。
- `ROOM_CODEX_PROXY`：仅托管 Codex 本机直连的可选代理，详见 [Codex 接入](CODEX-CONFIG.md)。

应用不会自动加载 `.env` 文件。教程中的 `$env:...` 都应在**启动 Room 的那个 PowerShell 进程**中设置；在其他终端设置不会改变已运行服务的环境。

## 5. 完成不调用模型的首次验证

1. 在默认房间 @「演示规划员」，查看消息、流式输出和运行结果。
2. 刷新页面，确认历史仍在。
3. 添加一个新房间，确认不同房间的消息分开保存。
4. 启用真实沙箱 Agent 前运行：

```powershell
npm run test:sandbox
```

探测会创建临时执行目录并检查 AppContainer 身份、Job、工作区、子进程、IPC、网络与取消。查看输出以及数据目录下 `diagnostics/sandbox.json`。缺少私有网络测试接口等情况也可能导致不能认证，不能把未测到当成通过。失败时先按[沙箱说明](SANDBOX.md)排查；程序不会自动改用无沙箱运行。

然后按 [Agent 接入教程](AGENT-SETUP.md)配置真实成员。真实模型不属于安装必需步骤，不会在 `npm ci`、构建或普通测试中自动调用。

## 6. 升级、备份与恢复

升级前停止讨论和任务，等待执行结束。在同样的数据目录设置下执行：

```powershell
npm run backup
```

它用 SQLite `VACUUM INTO` 创建一致数据库快照，并复制交付物，默认保留最近 5 份。**该命令不是整个数据目录的完整备份**：不复制会话密钥、工作区或所有 Agent 状态；要迁移整台机器或保留所有成果，应停止服务后另行备份完整数据目录，并保护其中的凭据。

停止服务后更新：

```powershell
git pull --ff-only
npm ci
npm run build:sandbox
npm run build
npm start
```

数据库会按版本迁移，升级前自动保存数据库副本。当前数据库写入版本是 v9；不能用旧版本程序直接打开升级后的数据库。需要回退时先停服务，选择匹配的数据备份和代码版本。

恢复最近一次命令备份：

```powershell
# 必须先停止使用该数据目录的服务
npm run restore -- --latest
# 或指定一个已有备份目录：
npm run restore -- --backup 'D:\TemptRoomData\backups\<timestamp>'
```

恢复不会重跑状态不明的任务。重启后如有运行显示「状态未知」，应核对原生执行状态后处理，避免重复写入或重复调用模型。

## 7. 常见问题

### 找不到 C++ 编译器或 vswhere

在 Visual Studio Installer 中补装 MSVC x64/x86 工具与 Windows SDK，再运行 `npm run build:sandbox`。只有 .NET SDK 不够；仅安装可选 Clang 也不满足默认构建脚本的 MSVC 要求。

### 提示找不到沙箱宿主或兼容模块

从仓库根目录重新执行 `npm run build:sandbox`，保留生成的 `sandbox/**/bin` 目录。不要只复制 `dist` 到另一目录运行；部署还需要宿主、兼容模块与 `scripts` 等配套文件。

若构建提示 `RoomSandbox.exe` 被另一个进程占用，先正常停止使用该检出的 Room 服务，确认任务结束后再构建。需要继续使用旧实例时，应在另一个检出目录构建验证，不能覆盖正在运行的宿主文件。

### 页面能打开，但提示未授权或 WebSocket 连接失败

用 `npm run open` 重新打开，使用正确端口的 loopback 地址。不要用 `file://`、任意局域网域名、反向代理页面或旧启动令牌。显式轮换会话密钥后，还需重新生成外部 MCP 配置。

### 提示缺少密钥，但其他终端已设置

密钥必须存在于启动服务的进程环境中。先停止服务，在原启动终端设置对应变量，再重新运行；UI 中只填写变量名。服务不会从另一个终端或其他应用进程自动获取密钥。

### 沙箱内连不上本机代理或本地模型

这是当前执行边界：沙箱不开放 localhost / 内网；API 与 A2A 适配器也只接受通过公网地址检查的 HTTPS 服务。使用已有本机登录或本机工具资源时，可以明确选择可信 Agent 的本机直连模式。它拥有当前用户权限，不能把其结果当成沙箱验收通过。

### 端口被占用或状态目录锁冲突

先确认是否已有 Room 实例，用 `npm run open` 打开。多个实例应使用不同端口和不同数据目录；不要在仍有活动服务时删除锁文件。重启后有未完成任务时先核对状态。

### 浏览器端到端测试找不到浏览器

安装 Edge / Chrome，或指定 `$env:ROOM_BROWSER = '<浏览器 exe 的绝对路径>'` 后执行 `npm run test:browser`。该脚本使用独立测试目录，不调用模型。

## 下一步

- [接入 Agent 并邀请进房间](AGENT-SETUP.md)
- [已有 Codex / Claude / DSH 会话通过 MCP 加入](EXTERNAL-MCP.md)
- [讨论收敛与可选总结](discussions.md)
- [原生隔离机制与限制](SANDBOX.md)
