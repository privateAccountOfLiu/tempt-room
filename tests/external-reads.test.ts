import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { buildContextSegments } from '../apps/server/src/context-segments.ts';
import { captureContext } from '../apps/server/src/context.ts';
import type { Run } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');
test('owner can record external read versions and they reach context evidence', t => {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'external-read-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  t.after(() => { store.close(); rmSync(root, {recursive: true, force: true}); });
  const command = (type: string, payload: unknown, actor?: {id: string; kind: 'agent'}) => service.execute({version: '0.1', commandId: uid(), roomId, type, payload}, actor);
  const taskId = (command('task.create', {title: 'External read', agentId: 'demo-planner'}).result as any).taskId as string;
  const run = store.list<Run>('runs', roomId).find(item => item.taskId === taskId)!;
  const recorded = command('run.evidence.record', {runId: run.id, kind: 'network', source: 'https://example.test/spec', version: 'etag-v3', hash: 'a'.repeat(64)});
  assert.equal(recorded.result.externalReads, 1);
  assert.equal(store.get<Run>('runs', run.id)!.externalReads![0].version, 'etag-v3');
  const context = captureContext(store, roomId, run.basedOnSeq);
  const related = buildContextSegments(store.get<Run>('runs', run.id)!, context).find(segment => segment.kind === 'related')!;
  assert.match(related.text, /externalRead:network:https:\/\/example\.test\/spec:etag-v3/);
  assert.doesNotMatch(related.text, /externalReadVersion=unknown/);
  assert.throws(() => command('run.evidence.record', {runId: run.id, kind: 'file', source: 'src/a.ts'}, {id: 'demo-planner', kind: 'agent'}), /无权执行此命令/);
});
