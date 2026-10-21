import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';

const parent = resolve('.state/test-data');
async function fixture(t: any) {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'tool-approval-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), worker = new Worker(store, service, root, {adapter: async function* () {}}), roomId = store.rooms()[0].id;
  t.after(async () => { await worker.close(); store.close(); rmSync(root, {recursive: true, force: true}); });
  service.execute({version: '0.1', commandId: uid(), roomId, type: 'settings.update', payload: {...store.settings(), toolAuthorizationMode: 'enforce', externalToolApprovalTimeoutMs: 5000}});
  const waitForApproval = async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const pending = worker.pendingToolApprovals();
      if (pending.length) return pending[0]!;
      await new Promise(done => setTimeout(done, 10));
    }
    throw new Error('no pending tool approval');
  };
  return {store, worker, roomId, waitForApproval};
}

test('external MCP tool call waits for owner approval and then executes', async t => {
  const {worker, roomId, waitForApproval} = await fixture(t);
  const call = worker.agentTool('demo-planner', roomId, 'room_post', {text: 'approval test'});
  const pending = await waitForApproval();
  assert.equal(pending.agentId, 'demo-planner');
  assert.equal(pending.tool, 'room_post');
  assert.equal(worker.decideToolApproval(pending.id, true), true);
  const result = await call;
  assert.ok(result && typeof result === 'object');
  assert.equal(worker.pendingToolApprovals().length, 0);
});

test('denied or unknown external tool approvals fail closed', async t => {
  const {worker, roomId, waitForApproval} = await fixture(t);
  const call = worker.agentTool('demo-planner', roomId, 'room_post', {text: 'approval test'});
  const pending = await waitForApproval();
  assert.equal(worker.decideToolApproval(pending.id, false), true);
  await assert.rejects(call, /工具审批未通过|工具未获授权/);
  assert.equal(worker.decideToolApproval(pending.id, true), false);
});
