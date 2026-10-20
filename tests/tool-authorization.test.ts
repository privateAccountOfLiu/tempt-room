import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeTool } from '../apps/server/src/tool-authorization.ts';

const agent = {id: 'demo-planner', kind: 'agent' as const};
const fence = {runId: 'run_1', generation: 1, executionId: 'exec_1'};
const evidence = (state: 'verified_supported' | 'verified_unsupported' | 'unverified') => [{fingerprint: 'fp_1', capability: 'preToolGate' as const, state, mode: 'simulated-contract', testedAt: new Date().toISOString(), suiteVersion: 'v1', evidenceHash: 'a'.repeat(64)}];

test('pre-tool authorization requires a run fence and verified preToolGate for writes', () => {
  assert.equal(authorizeTool({actor: agent, runFence: fence, tool: 'room_read', args: {limit: 10}}).decision, 'allow');
  assert.equal(authorizeTool({actor: agent, runFence: fence, tool: 'room_post', args: {text: 'hi'}}).reason, 'capability_unverified');
  assert.equal(authorizeTool({actor: agent, runFence: fence, fingerprint: 'fp_1', capabilityEvidence: evidence('verified_unsupported'), tool: 'room_post', args: {text: 'hi'}}).reason, 'capability_unverified');
  assert.equal(authorizeTool({actor: agent, runFence: fence, fingerprint: 'fp_1', capabilityEvidence: evidence('verified_supported'), tool: 'room_post', args: {text: 'hi'}}).decision, 'allow');
  assert.equal(authorizeTool({actor: agent, tool: 'room_post', args: {text: 'hi'}}).reason, 'run_fence_missing');
});

test('pre-tool authorization rejects traversal, ADS and reserved device names', () => {
  const system = {id: 'owner', kind: 'human' as const};
  assert.equal(authorizeTool({actor: system, tool: 'task_context', args: {path: 'C:\\project\\..\\secret.txt'}}).reason, 'path_traversal');
  assert.equal(authorizeTool({actor: system, tool: 'task_context', args: {path: 'C:\\project\\file.txt:hidden'}}).reason, 'alternate_data_stream');
  assert.equal(authorizeTool({actor: system, tool: 'task_context', args: {path: 'C:\\project\\CON'}}).reason, 'reserved_device_name');
  assert.equal(authorizeTool({actor: system, tool: 'task_context', args: {path: 'C:\\project\\notes.txt'}}).decision, 'allow');
  assert.equal(authorizeTool({actor: system, tool: 'not_a_room_tool', args: {}}).reason, 'unknown_tool');
});
