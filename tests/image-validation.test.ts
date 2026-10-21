import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { Store, SYSTEM, now } from '../apps/server/src/store.ts';
import { ImageUploads } from '../apps/server/src/image-uploads.ts';
import { detectStaticImageType } from '../apps/server/src/image-validation.ts';

const parent = resolve('.state/test-data');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function fixture(t: import('node:test').TestContext) {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'image-validation-'));
  const store = new Store(join(root, 'room.sqlite'));
  const uploads = new ImageUploads(store, root);
  t.after(() => { try { store.close(); } catch { /* closed */ } rmSync(root, {recursive: true, force: true}); });
  const roomId = store.rooms()[0].id;
  const agentId = 'demo-planner';
  const identity = {roomId, agentId};
  return {root, store, uploads, roomId, agentId, identity};
}
type Ctx = ReturnType<typeof fixture>;

async function upload(ctx: Ctx, bytes: Buffer, alt?: string) {
  const upload = ctx.uploads.begin({roomId: ctx.roomId, agentId: ctx.agentId, rootOperationId: `root_${sha(bytes).slice(0, 16)}`, name: `image-${sha(bytes).slice(0, 6)}.bin`, size: bytes.byteLength, sha256: sha(bytes), mediaType: 'image/png', ...(alt ? {alt} : {})});
  let offset = 0;
  for (let index = 0; offset < bytes.byteLength; index++) {
    const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + 192 * 1024));
    await ctx.uploads.chunk(upload.uploadId, index, chunk, sha(chunk), ctx.identity);
    offset += chunk.byteLength;
  }
  return upload;
}

function insertPngChunk(png: Buffer, type: string, data: Buffer): Buffer {
  const idat = png.indexOf(Buffer.from('IDAT'));
  if (idat < 0) throw new Error('IDAT missing');
  const start = idat - 4;
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const chunk = Buffer.alloc(8 + data.byteLength + 4);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeAndData.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(typeAndData) >>> 0, 8 + data.byteLength);
  return Buffer.concat([png.subarray(0, start), chunk, png.subarray(start)]);
}

test('static PNG, JPEG and WebP are decoded, recorded and given a PNG preview', async t => {
  const ctx = fixture(t);
  const inputs = [
    {mediaType: 'image/png', bytes: await sharp({create: {width: 12, height: 8, channels: 3, background: '#ff0000'}}).png().toBuffer()},
    {mediaType: 'image/jpeg', bytes: await sharp({create: {width: 9, height: 14, channels: 3, background: '#00ff00'}}).jpeg().toBuffer()},
    {mediaType: 'image/webp', bytes: await sharp({create: {width: 7, height: 5, channels: 3, background: '#0000ff'}}).webp().toBuffer()}
  ];
  for (const input of inputs) {
    const uploaded = await upload(ctx, input.bytes, 'fixture image');
    const result = await ctx.uploads.finalize(uploaded.uploadId, ctx.identity);
    assert.equal(result.mediaType, input.mediaType);
    assert.equal(result.width, input.mediaType === 'image/png' ? 12 : input.mediaType === 'image/jpeg' ? 9 : 7);
    assert.equal(result.height, input.mediaType === 'image/png' ? 8 : input.mediaType === 'image/jpeg' ? 14 : 5);
    assert.equal(result.size, input.bytes.byteLength);
    assert.match(result.contentHash, /^[a-f0-9]{64}$/);
    const artifact = ctx.store.get<any>('artifacts', result.artifactId)!;
    assert.equal(artifact.image.verified, true);
    assert.equal(artifact.image.alt, 'fixture image');
    assert.equal(artifact.mediaType, input.mediaType);
    assert.ok(existsSync(join(ctx.root, 'artifacts', result.artifactId)));
    const preview = readFileSync(join(ctx.root, 'artifacts', `${result.artifactId}.preview.png`));
    assert.equal(preview[0], 0x89);
    assert.equal(preview[1], 0x50);
    assert.equal(sha(preview), artifact.image.previewHash);
    assert.equal(preview.byteLength, artifact.image.previewSize);
    const repeated = await ctx.uploads.finalize(uploaded.uploadId, ctx.identity);
    assert.equal(repeated.artifactId, result.artifactId);
    assert.equal(repeated.reused, true);
    assert.equal(ctx.store.events(ctx.roomId).filter(event => event.type === 'artifact.created' && (event.payload as any).artifact?.id === result.artifactId).length, 1);
  }
});

test('animation, SVG/HTML and corrupt images are rejected before artifact creation', async t => {
  const ctx = fixture(t);
  const png = await sharp({create: {width: 4, height: 4, channels: 3, background: '#ffffff'}}).png().toBuffer();
  const apng = insertPngChunk(png, 'acTL', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]));
  assert.throws(() => detectStaticImageType(apng), /静态/);
  const animatedWebp = Buffer.alloc(30);
  animatedWebp.write('RIFF', 0, 'ascii'); animatedWebp.writeUInt32LE(22, 4); animatedWebp.write('WEBP', 8, 'ascii');
  animatedWebp.write('VP8X', 12, 'ascii'); animatedWebp.writeUInt32LE(10, 16); animatedWebp[20] = 0x02;
  assert.throws(() => detectStaticImageType(animatedWebp), /静态/);
  const corrupt = Buffer.concat([png.subarray(0, 20), Buffer.alloc(30, 0)]);
  for (const [index, bytes] of [apng, corrupt, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')].entries()) {
    const uploaded = await upload(ctx, bytes);
    await assert.rejects(() => ctx.uploads.finalize(uploaded.uploadId, ctx.identity), /图片|解码|静态/, `case ${index}`);
    assert.equal(ctx.store.list<any>('artifacts', ctx.roomId).length, 0);
  }
});

test('a room entering deletion during image decode wins over the prepared artifact', async t => {
  const ctx = fixture(t);
  const bytes = await sharp({create: {width: 3, height: 3, channels: 3, background: '#abcdef'}}).png().toBuffer();
  const uploaded = await upload(ctx, bytes);
  ctx.store.event(ctx.roomId, 'room.deleting', SYSTEM, {room: {...ctx.store.room(ctx.roomId)!, status: 'deleting', revision: 2, deletion: {requestedAt: now(), requestedBy: 'owner', commandId: 'delete_during_decode', pendingReasons: []}}});
  await assert.rejects(() => ctx.uploads.finalize(uploaded.uploadId, ctx.identity), /房间/);
  assert.equal(ctx.store.list<any>('artifacts', ctx.roomId).length, 0);
});
