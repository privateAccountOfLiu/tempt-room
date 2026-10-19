# 参与开发

请先按 [Windows 部署教程](docs/DEPLOYMENT.md)安装工具，并使用 Node.js 24+。Room 的原生执行宿主需要 Windows x64、.NET 10 SDK 与 MSVC C++ 工具；当前不支持用 Linux CI 的结果代替 Windows 原生验证。

```powershell
npm ci
npm run build:sandbox
npm run dev
```

提交前按改动范围运行：

```powershell
npm run typecheck
npm test
npm run check:secrets
npm run build
```

界面改动补充 `npm run test:browser`，构建 / 启动改动补充 `npm run test:production`；沙箱改动还需 `npm run test:sandbox` 与相应原生场景。`npm test` 使用模拟 / 本地 fixture，不调用真实模型。真实 Agent 测试需要明确的 `--allow-paid`，不应放入普通 CI。

GitHub Actions 检查 TypeScript、协议 / 集成测试、常见凭据、构建与原生宿主编译；托管 CI 编译通过不表示 AppContainer 或真实模型场景已通过。

Issue 中请提供复现步骤、Windows / Node / .NET / Agent 版本、接入与执行方式及脱敏错误。不要上传完整 `.state`、数据库、用户配置目录、启动 URL、API Key、MCP 专用令牌或客户端配置备份。普通日志和截图也应先检查是否含业务内容。

协议改动同步更新类型、验证与 JSON Schema；可以运行 `npm run build:sdk` 生成 Schema、`npm run test:sdk` 检查源码包消费者。涉及任务恢复与取消时，应保持未知状态不盲目重跑、取消受理不等于确认终止的语义。

本项目采用 [Apache License 2.0](LICENSE)。第三方代码与依赖须保留其原有声明；不要把外部 Agent 安装程序或账号文件加入仓库。
