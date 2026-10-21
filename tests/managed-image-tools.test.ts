import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { Store } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';

const parent = resolve('.state/test-data');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t: import('node:test').TestContext) {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'managed-image-tools-'));
  const store = new Store(join(root, 'room.sqlite'));
  const service = new RoomService(store);
  const worker = new Worker(store, service, root, {adapter: async function* () { yield {type: 'text', text: 'unused'}; }});
  t.after(async () => { await worker.close(); try { store.close(); } catch { /* closed */ } rmSync(root, {recursive: true, force: true}); });
  return {root, store, service, worker, roomId: store.rooms()[0].id, agentId: 'demo-planner'};
}
type Ctx = Awaited<ReturnType<typeof fixture>>;

async function uploadViaWorker(ctx: Ctx) {
  const bytes = await sharp({create: {width: 6, height: 4, channels: 3, background: '#336699'}}).png().toBuffer();
  const begin = await ctx.worker.agentTool(ctx.agentId, ctx.roomId, 'image_upload_begin', {name: 'tool-cat.png', size: bytes.byteLength, sha256: sha(bytes), mediaType: 'image/png'});
  const chunk = await ctx.worker.agentTool(ctx.agentId, ctx.roomId, 'image_upload_chunk', {uploadId: begin.uploadId, index: 0, dataBase64: bytes.toString('base64'), sha256: sha(bytes)});
  assert.equal(chunk.acceptedBytes, bytes.byteLength);
  const complete = await ctx.worker.agentTool(ctx.agentId, ctx.roomId, 'image_upload_complete', {uploadId: begin.uploadId});
  return {bytes, begin, chunk, complete};
}

test('external Agent can upload an image through the three low-level tools', async t => {
  const ctx = await fixture(t);
  const {bytes, complete} = await uploadViaWorker(ctx);
  assert.match(complete.artifactId, /^artifact_/);
  assert.equal(complete.width, 6);
  assert.equal(complete.height, 4);
  assert.equal(complete.contentHash, sha(bytes));
  const artifact = ctx.store.get<any>('artifacts', complete.artifactId)!;
  assert.equal(artifact.image.verified, true);
  assert.equal(artifact.image.width, 6);
  assert.equal(artifact.image.height, 4);
  assert.equal(artifact.mediaType, 'image/png');
  assert.ok(existsSync(join(ctx.root, 'artifacts', complete.artifactId)));
  const preview = readFileSync(join(ctx.root, 'artifacts', `${complete.artifactId}.preview.png`));
  assert.equal(sha(preview), artifact.image.previewHash);
  assert.equal(ctx.store.events(ctx.roomId).filter(event => event.type === 'artifact.created').length, 1);
});

test('image tools reject invalid chunks and foreign agents before creating artifacts', async t => {
  const ctx = await fixture(t);
  const bytes = await sharp({create: {width: 2, height: 2, channels: 3, background: '#000000'}}).png().toBuffer();
  const begin = await ctx.worker.agentTool(ctx.agentId, ctx.roomId, 'image_upload_begin', {name: 'bad.png', size: bytes.byteLength, sha256: sha(bytes)});
  await assert.rejects(() => ctx.worker.agentTool(ctx.agentId, ctx.roomId, 'image_upload_chunk', {uploadId: begin.uploadId, index: 0, dataBase64: bytes.toString('base64'), sha256: 'b'.repeat(64)}), /摘要|hash/i);
  await assert.rejects(() => ctx.worker.agentTool('demo-reviewer', ctx.roomId, 'image_upload_chunk', {uploadId: begin.uploadId, index: 0, dataBase64: bytes.toString('base64'), sha256: sha(bytes)}), /不属于/);
  assert.equal(ctx.store.events(ctx.roomId).filter(event => event.type === 'artifact.created').length, 0);
});

test('repeating complete returns the same artifact without a duplicate event', async t => {
  const ctx = await fixture(t);
  const bytes = await sharp({create: {width: 3, height: 7, channels: 3, background: '#ff00ff'}}).png().toBuffer();
  const begin = await ctx.worker.agentTool(ctx.agentId, ctx.roomId, 'image_upload_begin', {name: 'again.png', size: bytes.byteLength, sha256: sha(bytes)});
  await ctx.worker.agentTool(ctx.agentId, ctx.roomId, 'image_upload_chunk', {uploadId: begin.uploadId, index: 0, dataBase64: bytes.toString('base64'), sha256: sha(bytes)});
  const first = await ctx.worker.agentTool(ctx.agentId, ctx.roomId, 'image_upload_complete', {uploadId: begin.uploadId});
  const second = await ctx.worker.agentTool(ctx.agentId, ctx.roomId, 'image_upload_complete', {uploadId: begin.uploadId});
  assert.equal(second.artifactId, first.artifactId);
  assert.equal(second.reused, true);
  assert.equal(ctx.store.events(ctx.roomId).filter(event => event.type === 'artifact.created').length, 1);
});
