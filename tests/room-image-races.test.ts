import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { Store, SYSTEM, now } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { ImageUploads } from '../apps/server/src/image-uploads.ts';
import { imageOperationIds } from '../packages/protocol/src/index.ts';

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
