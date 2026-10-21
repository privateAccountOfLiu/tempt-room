# B06 真实 Codex Steer 端到端验证

日期：2026-10-21
目标：验证 B06 steer 通道在真实 Codex app-server 上可从房间注入输入并影响当前 turn。

## 实验

- 房间：room_333d74ff4e0343fb99a7740299349b71
- 任务：task_0c30a790a1254895b466a5d88cf57a41
- Run：run_c4f1bba1a991464b89224096f22e0651
- 初始提示：写 400 词软件测试短文，然后打印 DONE，不调用工具
- Run 进入 running 后等待适配器注册 steer 通道（turn/start 响应后）
- 调用：POST /api/runs/run_c4f1bba1a991464b89224096f22e0651/steer
  - text: "STEER_OK: stop the essay now and reply exactly STEER_OK."
- 结果：accepted=true
- 最终 Run：completed
- 最终 Codex 消息：`STEER_OK`

## 结论

- Codex app-server `turn/steer` 通过房间 Worker 通道真实生效
- 最终输出被 steer 文本替代，证明输入进入当前 turn，而不是排队下一轮
- 运行成功写入 capability.verified(steerDuringRun, mode=runtime-steer)

## 已知时序

- Run 状态先变为 running，适配器在 turn/start 响应后才注册 steer handler
- 注册前的 steer 请求返回 `steer_unavailable`；自动 wake 投递会保留 pending 并在后续 tick 重试
- 建议调用方在收到 409 `steer_unavailable` 时短暂重试

## 仍未覆盖

- DeepSeek ACP / Claude adapter 没有 steer 协议
- C02 MCP 宿主权限桥、C04b Job Object 硬保证仍是独立缺口