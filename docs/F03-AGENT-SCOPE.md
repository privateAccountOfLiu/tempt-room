# F03 — 可选 AgentScope Service Transport（fixture 阶段）

实现日期：2026-10-21

## 状态

**fixture / 未声明真实 Service 集成完成。**

计划要求先锁定真实 AgentScope 版本与官方接口；本实现没有目标服务的真实版本，
因此只交付可替换的 service transport 契约与 fixture 测试，不宣称兼容某个
AgentScope 发行版。

## 实现

`apps/server/src/ports/agent-scope.ts`：

- `AgentScopeTransport implements AgentTransport`
- 映射：open session → outputs、provideInput、cancel、queryOutcome
- 端点可配置，凭证通过 `credentialEnv` 注入
- 所有能力状态固定为 `unverified`（`agentScopeCapabilities`）

## 验收

`tests/agent-scope-transport.test.ts` 使用本地 HTTP fixture：

- POST /sessions 返回 session 与文本输出
- provideInput / cancel / queryOutcome 请求被真实发出
- usage 事件可映射
- 能力证据保持 unverified

## 生产接入前提

1. 固定真实 AgentScope 服务版本与官方接口文档
2. 用真实服务跑投递、取消、未知结果、断线、幂等契约
3. 将真实能力证据写入 capability matrix 后，才可把对应项标为 verified
4. 在此之前不要将本适配器作为生产路由
