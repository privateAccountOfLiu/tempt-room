import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createExperimentFixture, executionOverlap, planThreeGroupExperiment, sha256, summarizeExperimentCosts, EXPERIMENT_VERIFIER_SOURCE } from '../scripts/real-experiment-groups.ts';

const parent = resolve('.state/test-data');
const realAgents = [
  {id: 'real-codex', name: 'Codex', provider: 'codex', enabled: true, executionMode: 'sandbox', workspaceMode: 'isolated' as const},
  {id: 'real-claude', name: 'Claude', provider: 'claude', enabled: true, executionMode: 'sandbox', workspaceMode: 'isolated' as const}
];

function makeFixture(t: import('node:test').TestContext) {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'real-groups-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return {root, fixture: createExperimentFixture(root)};
}

test('fixture freezes an owner verifier hash and immutable input files', t => {
  const {root, fixture: source} = makeFixture(t);
  assert.equal(source.verifierHash, sha256(EXPERIMENT_VERIFIER_SOURCE));
  assert.match(source.fixtureHash, /^[a-f0-9]{64}$/);
  assert.equal(readFileSync(join(source.projectPath, 'README.md'), 'utf8'), '# order query fixture\n');
  assert.ok(readFileSync(join(root, 'owner-verifier', 'verify-order-query.mjs'), 'utf8').includes('order-query-contract-ok'));
});

test('three groups cover single, simple parallel and controlled integration', t => {
  const {fixture: source} = makeFixture(t);
  const plan = planThreeGroupExperiment({agents: realAgents, fixture: source});
  assert.equal(plan.ready, true, plan.blockers.join('; '));
  assert.equal(plan.modelRequests, 0);
  assert.deepEqual(plan.groups.map(group => group.id), ['single', 'parallel-independent', 'collaborative']);
  assert.equal(plan.groups.reduce((sum, group) => sum + group.expectedActivations, 0), 6);
  assert.equal(plan.groups.find(group => group.id === 'parallel-independent')!.agents.length, 2);
  assert.equal(plan.groups.find(group => group.id === 'collaborative')!.requiresIntegration, true);
  assert.deepEqual(plan.limits, {maxMinutes: 30, maxActivations: 12, maxCostUsd: 5});
  assert.equal(plan.fixture.verifierHash, source.verifierHash);
});

test('demo/external/attach agents and too-small limits block a real experiment', t => {
  const {fixture: source} = makeFixture(t);
  const demoOnly = planThreeGroupExperiment({agents: [{id: 'demo', name: 'Demo', provider: 'demo', enabled: true}], fixture: source});
  assert.equal(demoOnly.ready, false);
  assert.ok(demoOnly.blockers.some(blocker => blocker.includes('至少两个')));
  const external = planThreeGroupExperiment({agents: [...realAgents, {id: 'ext', name: 'Ext', provider: 'claude', enabled: true, connectionMode: 'external'}], fixture: source, limits: {maxActivations: 3}});
  assert.equal(external.ready, false);
  assert.ok(external.blockers.some(blocker => blocker.includes('超过上限')));
});

test('overlap evidence distinguishes known intervals from missing timestamps', () => {
  const overlap = executionOverlap(
    {startedAt: '2026-10-22T00:00:00.000Z', finishedAt: '2026-10-22T00:10:00.000Z'},
    {startedAt: '2026-10-22T00:05:00.000Z', finishedAt: '2026-10-22T00:15:00.000Z'}
  );
  assert.deepEqual(overlap, {known: true, overlapMs: 5 * 60 * 1000});
  assert.deepEqual(executionOverlap({startedAt: 'invalid'}, {startedAt: '2026-10-22T00:05:00.000Z'}), {known: false, overlapMs: 0});
  assert.deepEqual(executionOverlap(
    {startedAt: '2026-10-22T00:00:00.000Z', finishedAt: '2026-10-22T00:10:00.000Z'},
    {startedAt: '2026-10-22T00:20:00.000Z', finishedAt: '2026-10-22T00:30:00.000Z'}
  ), {known: true, overlapMs: 0});
});

test('unknown cost is not reported as zero', () => {
  const summary = summarizeExperimentCosts([{costUsd: 0.25, runId: 'run_a'}, {runId: 'run_b'}, {costUsd: Number.NaN, runId: 'run_c'}]);
  assert.equal(summary.knownUsd, 0.25);
  assert.equal(summary.unknownCount, 2);
  assert.deepEqual(summary.unknownRuns, ['run_b', 'run_c']);
});
