import test from 'node:test';
import assert from 'node:assert/strict';
import { planDualAgentExperiment, roomIsIdle } from '../scripts/real-experiment-lib.ts';

const agents = [
  {id: 'demo-planner', name: 'Demo', provider: 'demo', enabled: true},
  {id: 'codex-real', name: 'Codex', provider: 'codex', enabled: true, connectionMode: 'managed'},
  {id: 'deepseek-real', name: 'DeepSeek', provider: 'deepseek', enabled: true, connectionMode: 'managed'},
  {id: 'disabled-real', name: 'Disabled', provider: 'claude', enabled: false}
];

test('real dual-agent planning excludes demo and disabled agents', () => {
  const plan = planDualAgentExperiment({agents});
  assert.equal(plan.agentA?.id, 'codex-real');
  assert.equal(plan.agentB?.id, 'deepseek-real');
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.steps.length, 5);
});

test('real experiment planning reports missing real agents and room idleness', () => {
  const plan = planDualAgentExperiment({agents: [agents[0]!, agents[3]!]});
  assert.ok(plan.errors.length >= 1);
  assert.match(plan.errors.join(' '), /真实模型 Agent/);
  assert.equal(roomIsIdle([{status: 'running'}]), false);
  assert.equal(roomIsIdle([{status: 'completed'}, {status: 'failed'}]), true);
});
