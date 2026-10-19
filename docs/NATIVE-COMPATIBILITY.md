# 当前原生运行时兼容层

本机已通过 23 项原生沙箱探测。兼容层处理工具在 AppContainer 中的路径、管道假设；文件、网络、进程边界仍由 Windows 实施。

## Node / Electron 管道

`npm run build:sandbox` 同时编译 C# 宿主与 `sandbox/RoomPipeCompat/compat.cpp`。后者使用本机 Visual Studio **MSVC x64** 构建为 N-API 8 模块，不需要重编完整 Node 或安装 Clang。

`room-pipes.cjs` 在隔离 Node 中预载，DSH Desktop 使用显式 `-r`。模块核验当前 AppContainer token，只替换当前进程主可执行映像导入表中的 `CreateNamedPipeA/W`、`CreateFileA/W`。仅把 libuv 的 uv 管道名移入 LOCAL 命名空间，不重写普通文件或其他管道，不改系统 DLL、安装目录或其他进程。非 AppContainer 进程拒绝启用。

构建脚本核对源码、脚本、VS 工具版本与输出哈希；staging 继续按内容指纹复制并只读授权。更换运行时或 Windows 版本后应重跑探测。

## 路径、Git 与 DSH 持久化

- `room-realpath.cjs` 只在声明的 workspace/home/runtime 内逐级核对路径存在且无链接后处理 EPERM/EACCES，不将未授权路径或 ENOENT 当作成功。
- Git 独立快照使用 reftable，避免 files refs 后端查询未授权祖先。原项目仓库格式不变，旧快照不自动转换。
- `room-deepseek.cjs` 仅对已核验 SHA-256 的持久化模块做内存加载转换，从声明的可写根检查目录。已验证 Desktop 0.2.0-rc.2 模块哈希为 `0845707017acc2b4a8a75eab2244fa3fd88587b8094ab32014321dce7ca1e31b`；未知版本拒绝转换，安装包不变。
- C# 宿主使用 UTF-8 IPC，在隔离 home 预建 AppContainer 私有临时目录；聊天工作区有 Git 基线，避免 Harness 向宿主祖先寻找项目根。

证据在 `.state/diagnostics/sandbox.json` 与独立测试目录报告，覆盖管道子进程、真实 MCP 桥、npm、Git、文件/进程/IPC 拒绝、网络和 Job 退出。多系统环境、DSH Office 与完整真实编程任务仍需验收。

[完整 Node 源码构建](RUNTIME-BUILD.md)保留为可选替代路线；本机未完成该路线的二进制构建，与默认 MSVC 小模块是不同实现。
