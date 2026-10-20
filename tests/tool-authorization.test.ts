import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeTool } from '../apps/server/src/tool-authorization.ts';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, SYSTEM, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';
import type { Run } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');

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

test('executeTool enforces and audits tool authorization decisions', async t => {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'tool-auth-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  const worker = new Worker(store, service, root, {adapter: async function* () { yield {type: 'text', text: 'unused'}; }});
  t.after(async () => { await worker.close(); store.close(); rmSync(root, {recursive: true, force: true}); });
  service.execute({version: '0.1', commandId: uid(), roomId, type: 'settings.update', payload: {...store.settings(), toolAuthorizationMode: 'enforce'}});
  const taskId = (service.execute({version: '0.1', commandId: uid(), roomId, type: 'task.create', payload: {title: 'Tool auth', agentId: 'demo-planner'}}).result as any).taskId as string;
  const queued = store.list<Run>('runs', roomId).find(run => run.taskId === taskId)!;
  const at = new Date().toISOString();
  const running: Run = {...queued, status: 'running', generation: 1, executionId: 'exec_auth', startedAt: at, updatedAt: at};
  store.event(roomId, 'run.started', SYSTEM, {run: running});
  (worker as any).active.set(queued.id, new AbortController());
  const fence = {runId: queued.id, roomId, agentId: 'demo-planner', generation: 1, executionId: 'exec_auth'};
  const result = await worker.executeTool(queued.id, {name: 'room_post', arguments: {text: 'blocked'}, operationId: 'op_auth'}, fence);
  assert.equal(result.code, 'tool_denied');
  assert.match(String(result.error), /工具未获授权/);
  const audit = store.events(roomId).find(event => event.type === 'tool.authorization.recorded')!;
  assert.equal((audit.payload as any).authorizationDecision, 'deny');
  assert.equal((audit.payload as any).authorizationMode, 'enforce');
  assert.equal((audit.payload as any).runId, queued.id);
  assert.ok((audit.payload as any).argumentDigest);
  (worker as any).active.delete(queued.id);
});
