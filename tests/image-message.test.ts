import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, SYSTEM, uid, now } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import type { Artifact } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');

function fixture(t: import('node:test').TestContext) {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'image-message-'));
  const store = new Store(join(root, 'room.sqlite'));
  const service = new RoomService(store);
  t.after(() => { try { store.close(); } catch { /* closed */ } rmSync(root, {recursive: true, force: true}); });
  const roomId = store.rooms()[0].id;
  const command = (type: string, payload: unknown, id = roomId) => service.execute({version: '0.1', commandId: uid(), roomId: id, type, payload});
  return {store, service, roomId, command};
}
type Ctx = ReturnType<typeof fixture>;

function imageArtifact(ctx: Ctx, roomId = ctx.roomId, id = uid('artifact')): Artifact {
  const artifact: Artifact = {
    id, roomId, name: 'cat.png', kind: 'file', mediaType: 'image/png', size: 128, createdAt: now(),
    contentHash: 'c'.repeat(64),
    image: {verified: true, width: 10, height: 20, alt: 'a cat', previewMediaType: 'image/png', previewHash: 'd'.repeat(64), previewSize: 64}
  };
  ctx.store.event(roomId, 'artifact.created', SYSTEM, {artifact});
  return artifact;
}

test('attachment-only message is accepted and keeps the empty text as an empty string', t => {
  const ctx = fixture(t);
  const artifact = imageArtifact(ctx);
  const receipt = ctx.command('message.send', {text: '', attachments: [artifact.id]});
  const snapshot = ctx.store.snapshot(ctx.roomId);
  const message = snapshot.messages.find(item => item.id === receipt.result.messageId)!;
  assert.equal(message.text, '');
  assert.deepEqual(message.attachments, [artifact.id]);
  const withCaption = ctx.command('message.send', {text: 'look at this', attachments: [artifact.id]});
  assert.ok(withCaption.result.messageId);
});

test('an empty text and attachment list is rejected by the command contract', t => {
  const ctx = fixture(t);
  assert.throws(() => ctx.command('message.send', {text: '', attachments: []}), /附件|消息必须|invalid/i);
  assert.throws(() => ctx.command('message.send', {}), /附件|消息必须|invalid/i);
});

test('attachments must belong to the same room', t => {
  const ctx = fixture(t);
  const second = ctx.service.execute({version: '0.1', commandId: uid(), type: 'room.create', payload: {name: 'Other image room', members: ['demo-planner']}}).result.roomId as string;
  const foreign = imageArtifact(ctx, second);
  assert.throws(() => ctx.command('message.send', {text: '', attachments: [foreign.id]}), /附件不属于此房间/);
  assert.ok(ctx.store.snapshot(ctx.roomId).messages.every(message => !message.attachments.includes(foreign.id)));
});
