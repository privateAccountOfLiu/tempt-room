// No-model readiness check for the V03 three-group real CLI experiment.
// It creates a throwaway fixture, freezes the owner verifier hash, checks hard
// limits and writes a machine-readable plan. It never starts a model or a real
// CLI; paid execution requires explicit operator authorization and is not part
// of `--check`.
//
// Run: npm run experiment:three-groups
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createExperimentFixture, planThreeGroupExperiment, DEFAULT_EXPERIMENT_LIMITS, type ExperimentAgent } from './real-experiment-groups.ts';

const args = new Set(process.argv.slice(2));
if (!args.has('--check') || args.has('--execute')) {
  console.error('usage: tsx scripts/real-three-group-experiment.ts --check');
  console.error('真实付费实验需要单独的显式授权与实际执行实现；--check 不会调用模型或 CLI。');
  process.exit(2);
}
let agents: ExperimentAgent[] = [];
try {
  const parsed = JSON.parse(process.env.ROOM_EXPERIMENT_AGENTS_JSON ?? '[]');
  if (!Array.isArray(parsed)) throw new Error('ROOM_EXPERIMENT_AGENTS_JSON 必须是数组');
  agents = parsed;
} catch (error) {
  console.error(`无法解析 ROOM_EXPERIMENT_AGENTS_JSON：${(error as Error).message}`);
  process.exit(2);
}
const experimentBase = resolve('.state', 'real-experiment');
mkdirSync(experimentBase, {recursive: true});
const root = mkdtempSync(join(experimentBase, 'three-group-'));
const fixture = createExperimentFixture(root);
const limits = {
  maxMinutes: Number(process.env.ROOM_EXPERIMENT_MAX_MINUTES ?? DEFAULT_EXPERIMENT_LIMITS.maxMinutes),
  maxActivations: Number(process.env.ROOM_EXPERIMENT_MAX_ACTIVATIONS ?? DEFAULT_EXPERIMENT_LIMITS.maxActivations),
  maxCostUsd: Number(process.env.ROOM_EXPERIMENT_MAX_COST_USD ?? DEFAULT_EXPERIMENT_LIMITS.maxCostUsd)
};
const plan = planThreeGroupExperiment({agents, fixture, limits});
const report = {
  ...plan,
  generatedAt: new Date().toISOString(),
  mode: 'check',
  authorization: {
    paidExecution: false,
    required: ['explicit operator authorization for model/CLI cost and duration', 'concrete maxMinutes/maxActivations/maxCostUsd'],
    note: '本报告只证明无模型 fixture/verifier/limits 就绪，不声称已做真实实验'
  },
  agentMetadata: agents.map(agent => ({
    id: agent.id, provider: agent.provider, version: agent.version ?? null,
    executable: agent.executable ?? null, executionMode: agent.executionMode ?? null,
    workspaceMode: agent.workspaceMode ?? null, connectionMode: agent.connectionMode ?? null
  }))
};
const reportDir = resolve('.state', 'real-experiment');
mkdirSync(reportDir, {recursive: true});
const reportPath = join(reportDir, 'three-group-plan.json');
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ready: plan.ready, modelRequests: 0, groups: plan.groups.map(group => ({id: group.id, expectedActivations: group.expectedActivations, requiresIntegration: group.requiresIntegration})), blockers: plan.blockers, warnings: plan.warnings, limits: plan.limits, fixture: plan.fixture, reportPath}, null, 2));
if (plan.blockers.length) console.error('真实实验未就绪：' + plan.blockers.join('；'));
