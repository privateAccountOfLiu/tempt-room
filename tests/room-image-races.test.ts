import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { Store, SYSTEM, now, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { ImageUploads } from '../apps/server/src/image-uploads.ts';
import { imageOperationIds, type Run, type Task } from '../packages/protocol/src/index.ts';
import { Worker } from '../apps/server/src/worker.ts';
import { createApp } from '../apps/server/src/app.ts';
import { executionFence } from '../apps/server/src/execution.ts';

const parent = resolve('.state/test-data');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t: import('node:test').TestContext) {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'image-races-'));
  const store = new Store(join(root, 'room.sqlite'));
  const service = new RoomService(store);
  const uploads = new ImageUploads(store, root);
  t.after(() => { try { store.close(); } catch { /* closed */ } rmSync(root, {recursive: true, force: true}); });
  const roomId = store.rooms()[0].id, agentId = 'demo-planner';
  return {root, store, service, uploads, roomId, agentId};
}
type Ctx = Awaited<ReturnType<typeof fixture>>;

async function picture(width = 5, height = 3) {
  return sharp({create: {width, height, channels: 3, background: '#2468ac'}}).png().toBuffer();
}

async function pending(ctx: Ctx, bytes: Buffer, rootOperationId = `root_${Math.random().toString(16).slice(2)}`) {
  const upload = ctx.uploads.begin({roomId: ctx.roomId, agentId: ctx.agentId, rootOperationId, name: 'race.png', size: bytes.byteLength, sha256: sha(bytes)});
  await ctx.uploads.chunk(upload.uploadId, 0, bytes, sha(bytes), {roomId: ctx.roomId, agentId: ctx.agentId});
  return upload;
}

function finish(ctx: Ctx, uploadId: string) {
  return ctx.uploads.finalize(uploadId, {roomId: ctx.roomId, agentId: ctx.agentId});
}

test('deleting a room rejects pending chunks and releases the reservation', async t => {
  const ctx = await fixture(t);
  const bytes = await picture();
  const upload = await pending(ctx, bytes);
  ctx.store.event(ctx.roomId, 'room.deleting', SYSTEM, {room: {...ctx.store.room(ctx.roomId)!, status: 'deleting', revision: 2}});
  await assert.rejects(() => ctx.uploads.chunk(upload.uploadId, 0, bytes, sha(bytes), {roomId: ctx.roomId, agentId: ctx.agentId}), /房间/);
  assert.equal(ctx.uploads.expireRoom(ctx.roomId), 1);
  assert.equal(ctx.uploads.pendingStats({roomId: ctx.roomId}).count, 0);
  assert.equal(ctx.store.events(ctx.roomId).filter(event => event.type === 'chat.message.created' && ((event.payload as any).message?.attachments?.length ?? 0) > 0).length, 0);
});

test('removing the uploading member invalidates the old uploadId', async t => {
  const ctx = await fixture(t);
  const bytes = await picture();
  const upload = await pending(ctx, bytes);
  ctx.service.execute({version: '0.1', commandId: 'cmd_remove_member', roomId: ctx.roomId, type: 'room.configure', payload: {name: ctx.store.room(ctx.roomId)!.name, description: '', members: ['demo-reviewer'], expectedRevision: ctx.store.room(ctx.roomId)!.revision}});
  await assert.rejects(() => ctx.uploads.chunk(upload.uploadId, 0, bytes, sha(bytes), {roomId: ctx.roomId, agentId: ctx.agentId}), /不在房间/);
});

test('parallel uploads from two members do not mix chunks or artifacts', async t => {
  const ctx = await fixture(t);
  const blue = await picture(5, 3), red = await picture(3, 5);
  const uploadA = ctx.uploads.begin({roomId: ctx.roomId, agentId: 'demo-planner', rootOperationId: 'root_parallel_a', name: 'a.png', size: blue.byteLength, sha256: sha(blue)});
  const uploadB = ctx.uploads.begin({roomId: ctx.roomId, agentId: 'demo-reviewer', rootOperationId: 'root_parallel_b', name: 'b.png', size: red.byteLength, sha256: sha(red)});
  await Promise.all([
    ctx.uploads.chunk(uploadA.uploadId, 0, blue, sha(blue), {roomId: ctx.roomId, agentId: 'demo-planner'}),
    ctx.uploads.chunk(uploadB.uploadId, 0, red, sha(red), {roomId: ctx.roomId, agentId: 'demo-reviewer'})
  ]);
  const [a, b] = await Promise.all([
    ctx.uploads.finalize(uploadA.uploadId, {roomId: ctx.roomId, agentId: 'demo-planner'}),
    ctx.uploads.finalize(uploadB.uploadId, {roomId: ctx.roomId, agentId: 'demo-reviewer'})
  ]);
  assert.notEqual(a.artifactId, b.artifactId);
  assert.notEqual(a.contentHash, b.contentHash);
  assert.equal(ctx.store.events(ctx.roomId).filter(event => event.type === 'artifact.created').length, 2);
});

test('retrying a lost post receipt with the same commandId creates one message', async t => {
  const ctx = await fixture(t);
  const bytes = await picture(6, 4);
  const upload = await pending(ctx, bytes);
  const image = await finish(ctx, upload.uploadId);
  const command = {version: '0.1', commandId: 'cmd_post_lost_receipt', roomId: ctx.roomId, type: 'message.send', payload: {text: '', attachments: [image.artifactId]}};
  const first = ctx.service.execute(command);
  const second = ctx.service.execute(command);
  assert.equal(first.result.messageId, second.result.messageId);
  const messages = ctx.store.snapshot(ctx.roomId).messages.filter(message => message.attachments.includes(image.artifactId));
  assert.equal(messages.length, 1);
});

test('artifact export/replay contains metadata and message references but no bytes or local source paths', async t => {
  const ctx = await fixture(t);
  const bytes = await picture(4, 9);
  const upload = await pending(ctx, bytes);
  const image = await finish(ctx, upload.uploadId);
  ctx.service.execute({version: '0.1', commandId: 'cmd_replay_post', roomId: ctx.roomId, type: 'message.send', payload: {text: 'image attached', attachments: [image.artifactId]}});
  const exported = JSON.stringify(ctx.store.events(ctx.roomId));
  assert.ok(!exported.includes('dataBase64'));
  assert.ok(!exported.includes(ctx.root));
  assert.ok(!exported.includes('complete.bin'));
  const artifactEvent = ctx.store.events(ctx.roomId).find(event => event.type === 'artifact.created')!;
  const artifact = (artifactEvent.payload as any).artifact;
  assert.equal(artifact.image.verified, true);
  assert.match(artifact.image.previewHash, /^[a-f0-9]{64}$/);
  assert.equal(artifact.contentHash, image.contentHash);
  const preview = readFileSync(join(ctx.root, 'artifacts', `${image.artifactId}.preview.png`));
  assert.equal(sha(preview), artifact.image.previewHash);
  const replayEvents = JSON.parse(exported).filter((event: any) => event.type === 'artifact.created');
  assert.equal(replayEvents.length, 1);
});

test('deleting the room after a complete upload hides the image but keeps audit metadata', async t => {
  const ctx = await fixture(t);
  const bytes = await picture(8, 8);
  const upload = await pending(ctx, bytes);
  const image = await finish(ctx, upload.uploadId);
  ctx.service.execute({version: '0.1', commandId: 'cmd_delete_after_upload', roomId: ctx.roomId, type: 'room.delete', payload: {expectedRevision: ctx.store.room(ctx.roomId)!.revision}});
  assert.equal(ctx.store.room(ctx.roomId)?.status, 'deleting');
  assert.equal(ctx.store.get<any>('artifacts', image.artifactId)?.image.verified, true);
  const uploadRow = ctx.store.db.prepare('SELECT state FROM image_uploads WHERE id=?').get(upload.uploadId) as any;
  assert.equal(uploadRow.state, 'completed');
  assert.ok(imageOperationIds('root').begin.length <= 128);
});

test('a room entering deletion while the preview is generated cannot commit the artifact', async t => {
  const ctx = await fixture(t);
  const bytes = await picture(6, 6);
  const upload = await pending(ctx, bytes);
  await assert.rejects(() => ctx.uploads.finalize(upload.uploadId, {roomId: ctx.roomId, agentId: ctx.agentId}, {beforeCommit: async () => {
    ctx.store.event(ctx.roomId, 'room.deleting', SYSTEM, {room: {...ctx.store.room(ctx.roomId)!, status: 'deleting', revision: 2}});
  }}), /房间/);
  assert.equal(ctx.store.list<any>('artifacts', ctx.roomId).length, 0);
});

test('managed tool image commits reject a stale generation before writing an artifact', async t => {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'managed-image-fence-'));
  const store = new Store(join(root, 'room.sqlite'));
  const service = new RoomService(store);
  const roomId = store.rooms()[0].id;
  const bytes = await picture(3, 3);
  let worker!: Worker;
  const captured: {uploadId?: string; error?: string; code?: string} = {};
  worker = new Worker(store, service, root, {adapter: async function* (ctx: any) {
    try {
      const fence = executionFence(ctx.run);
      const begin = await worker.executeTool(ctx.run.id, {name: 'image_upload_begin', arguments: {name: 'managed.png', size: bytes.byteLength, sha256: sha(bytes)}, operationId: 'managed_root'}, fence);
      captured.uploadId = begin.uploadId;
      const latest = store.get<Run>('runs', ctx.run.id)!;
      store.event(roomId, 'run.updated', SYSTEM, {run: {...latest, generation: (latest.generation ?? 1) + 1}});
      try {
        const result = await worker.executeTool(ctx.run.id, {name: 'image_upload_chunk', arguments: {uploadId: begin.uploadId, index: 0, dataBase64: bytes.toString('base64'), sha256: sha(bytes)}, operationId: 'managed_chunk'}, fence);
        if (result?.code) { captured.code = result.code; captured.error = result.error; }
      } catch (error) { captured.error = (error as Error).message; captured.code = (error as any).code; }
    } catch (error) { captured.error = (error as Error).message; captured.code = (error as any).code; }
    yield {type: 'text', text: 'done'};
  }});
  t.after(async () => { try { await worker.close(); } catch { /* closed */ } try { store.close(); } catch { /* closed */ } });
  service.execute({version: '0.1', commandId: uid(), roomId, type: 'task.create', payload: {title: 'managed image race', agentId: 'demo-planner'}});
  worker.start();
  const deadline = Date.now() + 15000;
  while (!captured.error && Date.now() < deadline) { worker.tick(); await new Promise(done => setTimeout(done, 20)); }
  assert.ok(captured.uploadId, 'managed image adapter did not run: ' + JSON.stringify(captured));
  assert.match(String(captured.code) + ' ' + String(captured.error), /stale_generation|Stale run generation/, 'captured=' + JSON.stringify(captured));
  assert.equal(store.list<any>('artifacts', roomId).length, 0);
});

test('deleting the last room survives restart, keeps the room list empty and hides the old image URL', async t => {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'image-last-room-restart-'));
  const store = new Store(join(root, 'room.sqlite'));
  const service = new RoomService(store);
  const uploads = new ImageUploads(store, root);
  const roomId = store.rooms()[0].id, agentId = 'demo-planner';
  const worker = new Worker(store, service, root, {adapter: async function* () { yield {type: 'text', text: 'unused'}; }});
  t.after(async () => { try { await worker.close(); } catch { /* closed */ } try { store.close(); } catch { /* closed */ } });
  const bytes = await picture(4, 4);
  const upload = await pending({root, store, service, uploads, roomId, agentId}, bytes);
  const image = await uploads.finalize(upload.uploadId, {roomId, agentId});
  assert.ok(existsSync(join(root, 'artifacts', image.artifactId)));
  service.execute({version: '0.1', commandId: uid(), roomId, type: 'room.delete', payload: {expectedRevision: store.room(roomId)!.revision}});
  for (let index = 0; index < 50 && store.room(roomId)?.status !== 'deleted'; index++) { worker.tick(); await new Promise(done => setTimeout(done, 10)); }
  assert.equal(store.room(roomId)?.status, 'deleted');
  assert.deepEqual(store.activeRooms().map(room => room.id), []);
  assert.equal(store.events(roomId).filter(event => event.type === 'artifact.created').length, 1);
  await worker.close(); store.close();
  const reopened = new Store(join(root, 'room.sqlite'));
  assert.equal(reopened.room(roomId)?.status, 'deleted', 'projection rebuild must retain the tombstone');
  assert.deepEqual(reopened.activeRooms().map(room => room.id), []);
  assert.equal(reopened.events(roomId).filter(event => event.type === 'artifact.created').length, 1);
  reopened.close();
  const app = await createApp({root, token: 'last-room-token', startWorker: false});
  t.after(async () => { await app.app.close(); try { app.worker.close(); } catch { /* closed */ } try { app.store.close(); } catch { /* closed */ } try { rmSync(root, {recursive: true, force: true}); } catch { /* Windows handle release delay */ } });
  const roomsResponse = await app.app.inject({method: 'GET', url: '/api/rooms', headers: {authorization: 'Bearer last-room-token', 'room-protocol-version': '0.1'}});
  assert.equal(roomsResponse.statusCode, 200);
  assert.deepEqual(roomsResponse.json(), []);
  const imageResponse = await app.app.inject({method: 'GET', url: `/api/artifacts/${image.artifactId}/image`, headers: {authorization: 'Bearer last-room-token'}});
  assert.equal(imageResponse.statusCode, 410);
});

test('cancelling the managed run rejects the in-flight image commit', async t => {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'managed-image-cancel-'));
  const store = new Store(join(root, 'room.sqlite'));
  const service = new RoomService(store);
  const roomId = store.rooms()[0].id;
  const bytes = await picture(3, 3);
  let worker!: Worker;
  const captured: {uploadId?: string; code?: string; error?: string} = {};
  worker = new Worker(store, service, root, {adapter: async function* (ctx: any) {
    try {
      const fence = executionFence(ctx.run);
      const begin = await worker.executeTool(ctx.run.id, {name: 'image_upload_begin', arguments: {name: 'cancelled.png', size: bytes.byteLength, sha256: sha(bytes)}, operationId: 'cancel_root'}, fence);
      captured.uploadId = begin.uploadId;
      service.execute({version: '0.1', commandId: uid(), roomId, type: 'run.cancel', payload: {runId: ctx.run.id}});
      const result = await worker.executeTool(ctx.run.id, {name: 'image_upload_chunk', arguments: {uploadId: begin.uploadId, index: 0, dataBase64: bytes.toString('base64'), sha256: sha(bytes)}, operationId: 'cancel_chunk'}, fence);
      captured.code = result?.code; captured.error = result?.error;
    } catch (error) { captured.code = (error as any).code; captured.error = (error as Error).message; }
    yield {type: 'text', text: 'cancelled'};
  }});
  t.after(async () => { await worker.close(); try { store.close(); } catch { /* closed */ } rmSync(root, {recursive: true, force: true}); });
  service.execute({version: '0.1', commandId: uid(), roomId, type: 'task.create', payload: {title: 'cancel image task', agentId: 'demo-planner'}});
  worker.start();
  const deadline = Date.now() + 15000;
  while (!captured.code && Date.now() < deadline) { worker.tick(); await new Promise(done => setTimeout(done, 20)); }
  assert.equal(captured.code, 'run_not_active', JSON.stringify(captured));
  assert.equal(store.list<any>('artifacts', roomId).length, 0);
});

test('a task version change rejects the in-flight managed image commit', async t => {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'managed-image-task-version-'));
  const store = new Store(join(root, 'room.sqlite'));
  const service = new RoomService(store);
  const roomId = store.rooms()[0].id;
  const bytes = await picture(3, 3);
  let worker!: Worker;
  const captured: {uploadId?: string; code?: string; error?: string} = {};
  worker = new Worker(store, service, root, {adapter: async function* (ctx: any) {
    try {
      const fence = executionFence(ctx.run);
      const begin = await worker.executeTool(ctx.run.id, {name: 'image_upload_begin', arguments: {name: 'revised.png', size: bytes.byteLength, sha256: sha(bytes)}, operationId: 'version_root'}, fence);
      captured.uploadId = begin.uploadId;
      const task = store.get<Task>('tasks', ctx.run.taskId)!;
      store.event(roomId, 'task.revised', SYSTEM, {task: {...task, version: task.version + 1}});
      const result = await worker.executeTool(ctx.run.id, {name: 'image_upload_chunk', arguments: {uploadId: begin.uploadId, index: 0, dataBase64: bytes.toString('base64'), sha256: sha(bytes)}, operationId: 'version_chunk'}, fence);
      captured.code = result?.code; captured.error = result?.error;
    } catch (error) { captured.code = (error as any).code; captured.error = (error as Error).message; }
    yield {type: 'text', text: 'revised'};
  }});
  t.after(async () => { await worker.close(); try { store.close(); } catch { /* closed */ } rmSync(root, {recursive: true, force: true}); });
  service.execute({version: '0.1', commandId: uid(), roomId, type: 'task.create', payload: {title: 'version image task', agentId: 'demo-planner'}});
  worker.start();
  const deadline = Date.now() + 15000;
  while (!captured.code && Date.now() < deadline) { worker.tick(); await new Promise(done => setTimeout(done, 20)); }
  assert.equal(captured.code, 'stale_task_version', JSON.stringify(captured));
  assert.equal(store.list<any>('artifacts', roomId).length, 0);
});

test('adding a member while another task is queued lets the new member upload without cancelling the task', async t => {
  const ctx = await fixture(t);
  const baseRoom = ctx.store.room(ctx.roomId)!;
  ctx.service.execute({version: '0.1', commandId: uid(), roomId: ctx.roomId, type: 'room.configure', payload: {name: baseRoom.name, description: baseRoom.description, members: ['demo-planner'], expectedRevision: baseRoom.revision}});
  const taskId = ctx.service.execute({version: '0.1', commandId: uid(), roomId: ctx.roomId, type: 'task.create', payload: {title: 'queued while member added', agentId: 'demo-planner'}}).result.taskId as string;
  const before = ctx.store.get<Task>('tasks', taskId)!;
  const current = ctx.store.room(ctx.roomId)!;
  ctx.service.execute({version: '0.1', commandId: uid(), roomId: ctx.roomId, type: 'room.configure', payload: {name: current.name, description: current.description, members: ['demo-planner', 'demo-reviewer'], expectedRevision: current.revision}});
  const after = ctx.store.get<Task>('tasks', taskId)!;
  assert.equal(after.version, before.version);
  assert.equal(after.status, before.status);
  const bytes = await picture(4, 4);
  const upload = ctx.uploads.begin({roomId: ctx.roomId, agentId: 'demo-reviewer', rootOperationId: 'new_member_image', name: 'member.png', size: bytes.byteLength, sha256: sha(bytes)});
  await ctx.uploads.chunk(upload.uploadId, 0, bytes, sha(bytes), {roomId: ctx.roomId, agentId: 'demo-reviewer'});
  const image = await ctx.uploads.finalize(upload.uploadId, {roomId: ctx.roomId, agentId: 'demo-reviewer'});
  assert.match(image.artifactId, /^artifact_/);
  assert.equal(ctx.store.get<Task>('tasks', taskId)?.status, before.status);
});
