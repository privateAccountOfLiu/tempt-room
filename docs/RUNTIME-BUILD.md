# 隔离 Node 运行时的本地构建

本页为可选的完整 Node 重编路线。**当前默认使用 MSVC 构建的小型 N-API 管道模块**，无需 Clang；`npm run build:sandbox` 会一并构建，已通过本机 23 项探测，见[原生兼容层](NATIVE-COMPATIBILITY.md)。下文缺少 Clang 只影响完整 Node 重编。

当前宿主 Node 24.14.0 的 libuv 1.51.0 在 AppContainer 内创建管道子进程时会卡住。上游问题及修复分别见 [Node #66374](https://github.com/nodejs/node/issues/66374)、[libuv #5178](https://github.com/libuv/libuv/issues/5178) 和 [libuv 提交 2cadaa401670](https://github.com/libuv/libuv/commit/2cadaa401670)。这是原生管道实现的问题，JS realpath 兼容层不能解决。

`scripts/build-node-runtime.mjs` 提供一条可审查的构建路线：Node 24.21.0 官方源码，加上该固定提交中 `src/win/pipe.c` 的补丁。2026-10-17 已实际完成源码 SHA-256 核对、完整解包与 `git apply --check`/补丁应用，目录为 `.cache/node-build/node-v24.21.0-appcontainer-2cadaa401670`。编译及实际兼容性尚未验证；脚本不是已经验证通过的二进制分发。

## 依赖与执行

编译需要 Windows、Visual Studio C++ x64 工具、**C++ Clang Compiler for Windows** 与 **MSBuild support for LLVM (clang-cl) toolset** 两个可选组件、Python 3.12+ 与 Git。编译入口先检查依赖，再进行任何下载；`--prepare-only` 仅需 Python 与 Git，可以在尚无编译器时准备可审查源码。当前机器的 Clang 组件缺失；编译入口会明确失败，不自动安装系统组件或更改执行策略。

已提供 `sandbox/node-runtime.vsconfig`，仅声明这两个可选组件，可在 Visual Studio Installer 中导入到已有 C++ 安装。组件要求来自 Node 对应版本的 BUILDING.md。安装器需要的管理员权限由本机用户处理；本项目没有尝试修改系统权限或以其他身份静默安装。

在项目根目录执行：

```powershell
npm run check:node-build-tools
npm run build:sandbox-node -- --prepare-only  # 下载、校验、解包并尝试应用补丁
npm run build:sandbox-node                   # 继续调用官方 vcbuild
```

源码、下载缓存和构建输出均放在项目 `.cache/node-build/`。下载使用官方 Node HTTPS 地址和固定 libuv 提交，GitHub 直连失败时重试其官方 API；源码归档与官方 SHA-256 清单比对，补丁提交号及选定文件也会核对。清单未额外做签名验证。构建来源与二进制哈希写入 `.room-build.json`，中断的目录保留以供检查。

本机 Windows tar 在解包中文测试路径时报错，因此使用 Python tarfile 的 data filter 完整提取源码。额外拒绝链接、特殊文件、绝对路径、越界路径和超量归档，不删除中文测试 fixture。本入口不编译或运行上游测试执行器，不能将此输出当作完整 Node 测试分发。

脚本调用官方 `vcbuild.bat`，可能耗时较长并占用较多磁盘。不修改全局 Node，不替换已有安装。官方构建要求以对应源码中的 [BUILDING.md](https://github.com/nodejs/node/blob/v24.21.0/BUILDING.md) 为准。

## 选择构建结果并验证

只有成功构建后才使用脚本输出的绝对路径：

```powershell
$env:ROOM_SANDBOX_NODE = '<构建输出的 node.exe 绝对路径>'
npm run test:sandbox
```

重启服务使其选择新的运行文件。`ROOM_SANDBOX_NODE` 仅改变隔离工具链的输入，实际文件仍被复制和只读授权；不会跳过探测或改变宿主进程的 Node。运行设置、内存限制、AppContainer 和 Job 检查仍照常生效。

即使补丁构建成功，也必须验证管道子进程、npm、文件拒绝、网络、IPC 和取消。Git 已用独立 reftable 仓库解决本机探测中的写入问题。DSH Desktop 使用自己的 Electron/Node，选择这个 Node 不会替换其内嵌 libuv；默认 N-API 模块另由 Desktop 显式预载。两种 DSH 形态均需单独验收。
