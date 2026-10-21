import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApp } from '../apps/server/src/app.ts';
import { SYSTEM, now } from '../apps/server/src/store.ts';
import type { Artifact } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const preview = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04]);

async function fixture(t: import('node:test').TestContext) {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'artifact-image-'));
  const token = 'image-owner-token';
  const {app, store, service} = await createApp({root, token, startWorker: false});
  t.after(async () => { await app.close(); rmSync(root, {recursive: true, force: true}); });
  const roomId = store.rooms()[0].id;
  const artifact: Artifact = {id: 'artifact_inline_image', roomId, name: 'image.png', kind: 'file', mediaType: 'image/png', size: 16, createdAt: now(), contentHash: 'c'.repeat(64), image: {verified: true, width: 4, height: 2, alt: 'inline alt', previewMediaType: 'image/png', previewHash: sha(preview), previewSize: preview.byteLength}};
  mkdirSync(join(root, 'artifacts'), {recursive: true});
  writeFileSync(join(root, 'artifacts', artifact.id), 'original-bytes');
  writeFileSync(join(root, 'artifacts', `${artifact.id}.preview.png`), preview);
  store.event(roomId, 'artifact.created', SYSTEM, {artifact});
  return {root, app, store, service, token, roomId, artifact};
}
type Ctx = Awaited<ReturnType<typeof fixture>>;

test('inline image route returns a private, nosniff PNG without requiring protocol headers', async t => {
  const ctx = await fixture(t);
  const response = await ctx.app.inject({method: 'GET', url: `/api/artifacts/${ctx.artifact.id}/image`, headers: {authorization: `Bearer ${ctx.token}`}});
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'image/png');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['content-disposition'], 'inline');
  assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');
  assert.match(String(response.headers['cache-control']), /private/);
  assert.match(String(response.headers['cache-control']), /no-store/);
  assert.deepEqual(response.rawPayload, preview);
});

test('inline image route rejects unauthenticated callers, unverified images and deleted rooms', async t => {
  const ctx = await fixture(t);
  const anonymous = await ctx.app.inject({method: 'GET', url: `/api/artifacts/${ctx.artifact.id}/image`});
  assert.equal(anonymous.statusCode, 401);
  const unverified: Artifact = {...ctx.artifact, id: 'artifact_unverified', image: undefined};
  ctx.store.event(ctx.roomId, 'artifact.created', SYSTEM, {artifact: unverified});
  const unverifiedResponse = await ctx.app.inject({method: 'GET', url: `/api/artifacts/${unverified.id}/image`, headers: {authorization: `Bearer ${ctx.token}`}});
  assert.equal(unverifiedResponse.statusCode, 415);
  assert.equal(unverifiedResponse.json().code, 'not_an_image');
  ctx.store.event(ctx.roomId, 'room.deleting', SYSTEM, {room: {...ctx.store.room(ctx.roomId)!, status: 'deleting', revision: 2}});
  const deletedRoom = await ctx.app.inject({method: 'GET', url: `/api/artifacts/${ctx.artifact.id}/image`, headers: {authorization: `Bearer ${ctx.token}`}});
  assert.equal(deletedRoom.statusCode, 410, 'deleting rooms must already hide inline image bytes');
});

test('a corrupt preview returns an explicit error while the original download stays an attachment', async t => {
  const ctx = await fixture(t);
  writeFileSync(join(ctx.root, 'artifacts', `${ctx.artifact.id}.preview.png`), Buffer.from('corrupted'));
  const corrupt = await ctx.app.inject({method: 'GET', url: `/api/artifacts/${ctx.artifact.id}/image`, headers: {authorization: `Bearer ${ctx.token}`}});
  assert.equal(corrupt.statusCode, 410);
  assert.equal(corrupt.json().code, 'preview_corrupt');
  const download = await ctx.app.inject({method: 'GET', url: `/api/artifacts/${ctx.artifact.id}`, headers: {authorization: `Bearer ${ctx.token}`}});
  assert.equal(download.statusCode, 200);
  assert.equal(download.headers['content-type'], 'application/octet-stream');
  assert.match(String(download.headers['content-disposition']), /attachment/);
});
