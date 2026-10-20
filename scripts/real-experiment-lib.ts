export interface ExperimentAgent {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  connectionMode?: string;
}

export interface ExperimentPlan {
  agentA?: ExperimentAgent;
  agentB?: ExperimentAgent;
  errors: string[];
  warnings: string[];
  steps: string[];
}

const realProviders = new Set(['codex', 'claude', 'deepseek', 'api', 'a2a']);

/** Plan a real dual-agent room experiment without performing any model call. */
export function planDualAgentExperiment(input: {agents: readonly ExperimentAgent[]; agentA?: string; agentB?: string; projectPath?: string}): ExperimentPlan {
  const errors: string[] = [], warnings: string[] = [];
  const selectable = input.agents.filter(agent => agent.enabled && realProviders.has(agent.provider) && agent.connectionMode !== 'external');
  const pick = (id?: string, exclude?: string): ExperimentAgent | undefined => {
    if (id) {
      const found = input.agents.find(agent => agent.id === id);
      if (!found) errors.push(`找不到 Agent ${id}`);
      else if (!selectable.includes(found)) errors.push(`Agent ${id} 未启用、处于 external 模式或 provider 不受支持`);
      return found;
    }
    return selectable.find(agent => agent.id !== exclude);
  };
  const agentA = pick(input.agentA);
  const agentB = pick(input.agentB, agentA?.id);
  if (!agentA) errors.push(selectable.length ? '需要指定或至少存在一个真实 Agent 作为 A' : '没有可用的真实模型 Agent（demo 不计入真实实验）');
  if (!agentB) errors.push('需要两个不同的真实 Agent 作为 B');
  if (selectable.length < 2 && !input.agentA && !input.agentB) warnings.push('真实 Agent 少于两个；请先在 Agent 设置中配置真实 CLI/API 连接');
  const steps = agentA && agentB ? [
    `创建实验房间，成员：${agentA.name} + ${agentB.name}`,
    `A（${agentA.name}）创建基线任务并完成${input.projectPath ? `，项目 ${input.projectPath}` : ''}`,
    `B（${agentB.name}）基于 A 的结果创建验收/复核任务`,
    '等待两个 Run 完成，记录状态、tool 调用、artifacts、usage 与耗时',
    '写出实验报告到 .state/real-experiment/report-*.json'
  ] : [];
  return {agentA, agentB, errors, warnings, steps};
}

/** True only when every run in a room snapshot is terminal. */
export function roomIsIdle(runs: readonly {status: string}[]): boolean {
  return runs.every(run => ['completed', 'failed', 'canceled', 'superseded', 'interrupted', 'unknown'].includes(run.status));
}
