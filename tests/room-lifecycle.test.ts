import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, DATABASE_VERSION, SYSTEM, OWNER, uid, now } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { normalizeRoom, roomSchema } from '../packages/protocol/src/room.ts';
import type { Room } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');

function fixture(t: import('node:test').TestContext, rootSuffix = '') {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, `room-lifecycle-${rootSuffix}`));
  const path = join(root, 'room.sqlite');
  const store = new Store(path);
  const service = new RoomService(store);
  t.after(() => { try { store.close(); } catch { /* already closed */ } rmSync(root, {recursive: true, force: true}); });
  const roomId = store.rooms()[0].id;
  const command = (type: string, payload: unknown) => service.execute({version: '0.1', commandId: uid(), roomId, type, payload});
  return {root, path, store, service, roomId, command};
}

test('room schema accepts historic rooms and normalizeRoom supplies lifecycle defaults', () => {
  const legacy = {id: 'room_legacy', name: 'Legacy', description: '', members: ['demo-planner'], createdAt: now(), seq: 3};
  assert.equal(roomSchema.safeParse(legacy).success, true);
  const normalized = normalizeRoom(legacy);
  assert.equal(normalized.revision, 1);
  assert.equal(normalized.status, 'active');
  assert.equal(normalized.name, 'Legacy');
  assert.equal((legacy as any).revision, undefined, 'normalization must not rewrite the input event bytes');
});

test('new rooms start at revision 1 with deduplicated members and active status', t => {
  const {store, service, roomId} = fixture(t, 'create');
  const created = service.execute({version: '0.1', commandId: uid(), roomId: undefined, type: 'room.create', payload: {name: 'Lifecycle', members: ['demo-planner', 'demo-planner', 'demo-reviewer']}});
  const room = store.room(created.result.roomId as string)!;
  assert.equal(room.revision, 1);
  assert.equal(room.status, 'active');
  assert.deepEqual(room.members, ['demo-planner', 'demo-reviewer']);
});

test('room.configured, deleting and deleted are state events; illegal lifecycle transitions and member diffs are rejected', t => {
  const {store, service, roomId} = fixture(t, 'events');
  const before = store.room(roomId)!;
  const beforeSeq = before.seq;
  store.event(roomId, 'room.configured', SYSTEM, {room: {...before, name: 'Renamed', description: 'after', members: [...before.members.filter(member => member !== 'demo-planner')], revision: 2}, addedMemberIds: [], removedMemberIds: ['demo-planner']});
  const configured = store.room(roomId)!;
  assert.equal(configured.name, 'Renamed');
  assert.equal(configured.revision, 2);
  assert.equal(configured.members.includes('demo-planner'), false);

  assert.throws(() => store.event(roomId, 'room.configured', SYSTEM, {
    room: {...configured, members: [...configured.members], revision: 3},
    addedMemberIds: ['demo-planner'],
    removedMemberIds: []
  }), /member diff|member diff does not match/);

  const deletion = {requestedAt: now(), requestedBy: 'owner', commandId: 'delete_contract', pendingReasons: []};
  store.event(roomId, 'room.deleting', SYSTEM, {room: {...configured, status: 'deleting', revision: 3, deletion}});
  assert.throws(() => store.event(roomId, 'room.deletion.updated', SYSTEM, {room: {...store.room(roomId)!, status: 'deleting', revision: 4, deletion: {...deletion, commandId: 'other_delete'}}}), /identity cannot change/);
  assert.throws(() => store.event(roomId, 'room.updated', SYSTEM, {room: {...store.room(roomId)!, revision: 2}}), /revision cannot decrease/);
  store.event(roomId, 'room.deleted', SYSTEM, {room: {...store.room(roomId)!, status: 'deleted', revision: 4, deletion: {...deletion, deletedAt: now()}}});
  assert.equal(store.room(roomId)!.status, 'deleted');
  assert.throws(() => store.event(roomId, 'room.updated', SYSTEM, {room: {...store.room(roomId)!, status: 'active', revision: 5}}), /Deleted room cannot become active again/);
  assert.throws(() => store.event(roomId, 'room.configured', SYSTEM, {room: {...store.room(roomId)!, name: 'Again', revision: 5}, addedMemberIds: [], removedMemberIds: []}), /Deleted room cannot accept configuration/);

  const historic = store.snapshotAt(roomId, beforeSeq);
  assert.equal(historic.room.status ?? 'active', 'active');
  assert.equal(historic.room.name, before.name);
});

test('migrations are ordered from v10 to v18 and newer databases are rejected', t => {
  const {root, path, store} = fixture(t, 'migration');
  assert.equal(Number((store.db.prepare('PRAGMA user_version').get() as any).user_version), DATABASE_VERSION);
  store.close();
  const legacy = new DatabaseSync(path);
  for (const table of ['project_bindings', 'integrations', 'usage_samples', 'budget_reservations', 'resource_leases', 'capability_evidence_history']) legacy.exec(`DROP TABLE IF EXISTS ${table}`);
  legacy.exec('PRAGMA user_version=10');
  legacy.close();
  const upgraded = new Store(path);
  assert.equal(Number((upgraded.db.prepare('PRAGMA user_version').get() as any).user_version), DATABASE_VERSION);
  for (const table of ['project_bindings', 'integrations', 'usage_samples', 'budget_reservations', 'resource_leases', 'capability_evidence_history']) assert.ok(upgraded.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table), table);
  upgraded.close();
  const reopened = new Store(path);
  assert.equal(Number((reopened.db.prepare('PRAGMA user_version').get() as any).user_version), DATABASE_VERSION);
  reopened.close();
  const future = new DatabaseSync(path);
  future.exec(`PRAGMA user_version=${DATABASE_VERSION + 1}`);
  future.close();
  assert.throws(() => new Store(path), /newer than this application/);
  assert.ok(root);
});

test('historic room event bodies stay byte-identical while reads normalize lifecycle defaults', t => {
  const {path, store, roomId} = fixture(t, 'historic');
  const legacyRoom = {id: uid('room'), name: 'Historic room', description: 'old payload', members: ['demo-planner'], createdAt: now(), seq: 0};
  store.putRoom(legacyRoom as Room, OWNER);
  const event = store.events(legacyRoom.id).find(item => item.payload && (item.payload as any).room?.id === legacyRoom.id)!;
  const raw = store.db.prepare('SELECT body FROM events WHERE event_id=?').get(event.eventId) as any;
  assert.equal(JSON.parse(raw.body).payload.room.revision, undefined);
  store.close();
  const reopened = new Store(path);
  const after = reopened.db.prepare('SELECT body FROM events WHERE event_id=?').get(event.eventId) as any;
  assert.equal(after.body, raw.body, 'restart must not rewrite the historic room event');
  const room = normalizeRoom(reopened.room(legacyRoom.id)!);
  assert.equal(room.revision, 1);
  assert.equal(room.status, 'active');
  reopened.close();
});
