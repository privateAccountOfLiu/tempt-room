import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, now } from '../apps/server/src/store.ts';
import { ImageUploads } from '../apps/server/src/image-uploads.ts';

const parent = resolve('.state/test-data');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function fixture(t: import('node:test').TestContext) {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'image-uploads-'));
  const store = new Store(join(root, 'room.sqlite'));
  const uploads = new ImageUploads(store, root);
  t.after(() => { try { store.close(); } catch { /* closed */ } rmSync(root, {recursive: true, force: true}); });
  const roomId = store.rooms()[0].id;
  return {root, store, uploads, roomId, agentId: 'demo-planner'};
}
type Ctx = ReturnType<typeof fixture>;
const identity = (ctx: Ctx, overrides: {roomId?: string; agentId?: string} = {}) => ({roomId: overrides.roomId ?? ctx.roomId, agentId: overrides.agentId ?? ctx.agentId});

function begin(ctx: Ctx, bytes: Buffer, rootOperationId = `root_${Math.random().toString(16).slice(2)}`, overrides: {roomId?: string; agentId?: string; alt?: string} = {}) {
  return ctx.uploads.begin({roomId: overrides.roomId ?? ctx.roomId, agentId: overrides.agentId ?? ctx.agentId, rootOperationId, name: 'image.png', size: bytes.byteLength, sha256: sha(bytes), mediaType: 'image/png', ...(overrides.alt ? {alt: overrides.alt} : {})});
}

test('begin/chunk/complete assembles a bounded upload and is idempotent per operation root', async t => {
  const ctx = fixture(t);
  const bytes = Buffer.alloc(100, 7);
  const upload = begin(ctx, bytes, 'root_idempotent');
  assert.equal(upload.state, 'uploading');
  assert.deepEqual(upload.completedParts, []);
  const chunkResult = await ctx.uploads.chunk(upload.uploadId, 0, bytes, sha(bytes), identity(ctx));
  assert.deepEqual(chunkResult, {uploadId: upload.uploadId, index: 0, acceptedBytes: 100, duplicate: false});
  const duplicate = await ctx.uploads.chunk(upload.uploadId, 0, bytes, sha(bytes), identity(ctx));
  assert.equal(duplicate.duplicate, true);
  const completed = await ctx.uploads.complete(upload.uploadId, identity(ctx));
  assert.equal(completed.state, 'completed');
  assert.equal(completed.size, 100);
  assert.equal(completed.sha256, sha(bytes));
  const reused = begin(ctx, bytes, 'root_idempotent');
  assert.equal(reused.uploadId, upload.uploadId);
  assert.equal(reused.reused, true);
  assert.throws(() => begin(ctx, Buffer.alloc(101, 7), 'root_idempotent'), /同一 operationId/);
});

test('chunk validates order, size, hash and total bytes', async t => {
  const ctx = fixture(t);
  const bytes = Buffer.alloc(100, 1);
  const upload = begin(ctx, bytes);
  await assert.rejects(() => ctx.uploads.chunk(upload.uploadId, 0, bytes, sha(Buffer.from('other')), identity(ctx)), /摘要不匹配/);
  await assert.rejects(() => ctx.uploads.chunk(upload.uploadId, 0, Buffer.alloc(99), sha(Buffer.alloc(99)), identity(ctx)), /字节数/);
  await assert.rejects(() => ctx.uploads.chunk(upload.uploadId, 99, bytes, sha(bytes), identity(ctx)), /序号越界/);
  await assert.rejects(() => ctx.uploads.complete(upload.uploadId, identity(ctx)), /缺少分块/);
  const wrong = Buffer.alloc(100, 2);
  await ctx.uploads.chunk(upload.uploadId, 0, wrong, sha(wrong), identity(ctx));
  await assert.rejects(() => ctx.uploads.complete(upload.uploadId, identity(ctx)), /整图摘要/);
});

test('an upload is bound to the agent, room and managed fence', async t => {
  const ctx = fixture(t);
  const bytes = Buffer.alloc(10, 3);
  const upload = begin(ctx, bytes);
  await assert.rejects(() => ctx.uploads.chunk(upload.uploadId, 0, bytes, sha(bytes), identity(ctx, {agentId: 'demo-reviewer'})), /不属于此 Agent/);
  await assert.rejects(() => ctx.uploads.chunk(upload.uploadId, 0, bytes, sha(bytes), identity(ctx, {roomId: 'room_other'})), /不属于此房间/);
  const fenced = ctx.uploads.begin({roomId: ctx.roomId, agentId: ctx.agentId, rootOperationId: 'root_fenced', name: 'image.png', size: 10, sha256: sha(bytes), fence: {runId: 'run_1', generation: 1, executionId: 'exec_1'}});
  await assert.rejects(() => ctx.uploads.complete(fenced.uploadId, identity(ctx)), /执行身份/);
  await assert.rejects(() => ctx.uploads.complete(fenced.uploadId, {...identity(ctx), fence: {runId: 'run_1', generation: 2, executionId: 'exec_2'}}), /执行已变化/);
});

test('pending quotas are bounded per agent and released by abort/expiry', async t => {
  const ctx = fixture(t);
  for (const index of [1, 2]) begin(ctx, Buffer.alloc(1, index), `root_quota_${index}`);
  assert.throws(() => begin(ctx, Buffer.alloc(1, 3), 'root_quota_3'), /待上传数量/);
  const list = ctx.store.db.prepare("SELECT id FROM image_uploads WHERE agent_id=?").all(ctx.agentId) as {id: string}[];
  ctx.uploads.abort(list[0].id, identity(ctx));
  assert.equal(ctx.uploads.pendingStats({agentId: ctx.agentId}).count, 1);
  const third = begin(ctx, Buffer.alloc(1, 3), 'root_quota_3');
  assert.ok(third.uploadId);
  ctx.store.db.prepare('UPDATE image_uploads SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), third.uploadId);
  await assert.rejects(() => ctx.uploads.chunk(third.uploadId, 0, Buffer.alloc(1, 3), sha(Buffer.alloc(1, 3)), identity(ctx)), /已过期/);
  assert.equal(ctx.uploads.pendingStats({agentId: ctx.agentId}).count, 1, 'expired upload must not keep a pending slot');
});

test('missing files and DB-only parts are detected instead of pretending success', async t => {
  const ctx = fixture(t);
  const bytes = Buffer.alloc(8, 4);
  const upload = begin(ctx, bytes);
  const {uploads} = ctx;
  const partsDir = join(uploads.root, upload.uploadId, 'parts');
  // DB has a part record but the file disappeared.
  await uploads.chunk(upload.uploadId, 0, bytes, sha(bytes), identity(ctx));
  unlinkSync(join(partsDir, '0.part'));
  await assert.rejects(() => uploads.chunk(upload.uploadId, 0, bytes, sha(bytes), identity(ctx)), /文件缺失/);
  // File landed but DB lost the row: retry verifies the file hash and records it.
  const retryBytes = Buffer.alloc(8, 5);
  const retry = begin(ctx, retryBytes);
  writeFileSync(join(uploads.root, retry.uploadId, 'parts', '0.part'), retryBytes);
  const recovered = await uploads.chunk(retry.uploadId, 0, retryBytes, sha(retryBytes), identity(ctx));
  assert.equal(recovered.duplicate, false);
  assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS count FROM image_upload_parts WHERE upload_id=?').get(retry.uploadId)!.count, 1);
});
