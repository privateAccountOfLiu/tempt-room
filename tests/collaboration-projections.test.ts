import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { Store, DATABASE_VERSION, SYSTEM, uid } from '../apps/server/src/store.ts';
import { projectionCheckpointSchema } from '../packages/protocol/src/events.ts';

const base = resolve('.state/test-data');
const now = new Date().toISOString();
function fixture(t: import('node:test').TestContext) {
  mkdirSync(base, {recursive: true});
  const root = mkdtempSync(join(base, 'b02-')), store = new Store(join(root, 'room.sqlite')), roomId = store.rooms()[0].id;
  t.after(() => { store.close(); rmSync(root, {recursive: true, force: true}); });
  return {root, store, roomId};
}
const session = {id: 'session_1', roomId: 'room_1', agentId: 'demo-planner', status: 'active', createdAt: now, updatedAt: now};
const subscription = {id: 'subscription_1', roomId: 'room_1', agentSessionId: session.id, eventTypes: [], taskIds: [], sourcePolicy: 'explicit', enabled: true, scanSeq: 0};
const delivery = {id: 'delivery_1', agentSessionId: session.id, sourceEventId: 'event_1', sourceSeq: 1, status: 'pending'};
const batch = {id: 'batch_1', agentSessionId: session.id, generation: 1, executionId: 'exec_1', deliveryIds: [delivery.id], sourceEventIds: [delivery.sourceEventId], fromScanSeq: 0, throughScanSeq: 1, payloadHash: 'a'.repeat(64), deliveryMode: 'next-turn', createdAt: now, status: 'created'};
const wake = {id: 'wake_1', scopeKey: 'discussion_1/round_1', discussionId: 'discussion_1', roundId: 'round_1', agentSessionId: session.id, sourceEventId: delivery.sourceEventId, status: 'pending'};
const capability = {id: 'capability_1', fingerprint: 'fp_1', capability: 'streamOutput', state: 'verified_supported', mode: 'simulated', testedAt: now, suiteVersion: 'sim-v1', evidenceHash: 'b'.repeat(64)};
const round = {id: 'round_1', discussionId: 'discussion_1', round: 1, status: 'open', openedSeq: 1, openedAt: now};

test('fresh v10 databases project all B02 collaboration tables and rebuild identically', t => {
  const {store, roomId} = fixture(t);
  assert.equal(Number((store.db.prepare('PRAGMA user_version').get() as any).user_version), DATABASE_VERSION);
  const tables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(row => row.name);
  for (const table of ['agent_sessions','subscriptions','inbox_deliveries','input_batches','wake_intents','capability_evidence','discussion_rounds']) assert.ok(tables.includes(table), table);
  store.event(roomId, 'agent_session.created', SYSTEM, {agentSession: {...session, roomId}});
  store.event(roomId, 'subscription.updated', SYSTEM, {subscription: {...subscription, roomId}});
  store.event(roomId, 'inbox.delivered', SYSTEM, {delivery});
  store.event(roomId, 'input.batch.created', SYSTEM, {batch});
  store.event(roomId, 'wake.requested', SYSTEM, {wakeIntent: wake});
  store.event(roomId, 'capability.verified', SYSTEM, {capabilityEvidence: capability});
  store.event(roomId, 'discussion.round.opened', SYSTEM, {round});
  assert.equal(store.list('agent_sessions', roomId).length, 1);
  assert.equal(store.list('subscriptions', roomId).length, 1);
  assert.equal(store.list('inbox_deliveries', roomId).length, 1);
  assert.equal(store.list('input_batches', roomId).length, 1);
  assert.equal(store.list('wake_intents', roomId).length, 1);
  assert.equal(store.list('capability_evidence', roomId).length, 1);
  assert.equal(store.list('discussion_rounds', roomId).length, 1);
  const before = store.projectionBytes(roomId);
  store.rebuildProjections(roomId, 0);
  assert.equal(store.projectionBytes(roomId), before);
  assert.equal(store.projectionStatus(roomId).consistent, true);
});

test('inbox delivery identity is unique per agent session and source event', t => {
  const {store, roomId} = fixture(t);
  store.event(roomId, 'inbox.delivered', SYSTEM, {delivery});
  assert.throws(() => store.event(roomId, 'inbox.delivered', SYSTEM, {delivery: {...delivery, id: 'delivery_2'}}));
  assert.equal(store.list('inbox_deliveries', roomId).length, 1);
});

test('v9 databases back up and migrate to v10 without rewriting events', t => {
  mkdirSync(base, {recursive: true});
  const root = mkdtempSync(join(base, 'b02-migrate-')), path = join(root, 'room.sqlite');
  const store = new Store(path);
  const raw = store.db.prepare('SELECT body FROM events ORDER BY seq').all() as any[];
  store.close();
  const old = new DatabaseSync(path);
  for (const table of ['agent_sessions','subscriptions','inbox_deliveries','input_batches','wake_intents','capability_evidence','discussion_rounds']) old.exec(`DROP TABLE IF EXISTS ${table}`);
  for (const index of ['inbox_delivery_unique','wake_scope_unique','capability_evidence_unique','runs_response_slot','runs_agent_session_active']) old.exec(`DROP INDEX IF EXISTS ${index}`);
  old.exec('PRAGMA user_version=9');
  old.close();
  const migrated = new Store(path);
  t.after(() => { migrated.close(); rmSync(root, {recursive: true, force: true}); });
  assert.equal(Number((migrated.db.prepare('PRAGMA user_version').get() as any).user_version), DATABASE_VERSION);
  assert.ok(readdirSync(root).some(name => name.includes('.v9.') && name.endsWith('.bak')));
  assert.deepEqual(migrated.db.prepare('SELECT body FROM events ORDER BY seq').all(), raw);
  const migratedTables = (migrated.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(row => row.name);
  assert.ok(migratedTables.includes('agent_sessions'));
});

test('legacy projection checkpoints without B02 row arrays still decode', () => {
  const checkpoint = {room: {id: 'room_1', name: 'Room', description: '', members: [], createdAt: now, seq: 1}, rows: {messages: [], tasks: [], runs: [], artifacts: [], discussions: [], decisions: [], contexts: []}, reason: 'manual-snapshot'};
  const parsed = projectionCheckpointSchema.parse(checkpoint);
  assert.deepEqual(parsed.rows.agent_sessions, []);
  assert.deepEqual(parsed.rows.inbox_deliveries, []);
  assert.deepEqual(parsed.rows.discussion_rounds, []);
});
