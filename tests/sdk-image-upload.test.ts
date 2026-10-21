import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IMAGE_CHUNK_BYTES, imageOperationIds } from '../packages/protocol/src/index.ts';
import { uploadImage, sendImage, ImageUploadError } from '../packages/client/src/image-upload.ts';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function fakeTransport(options: {failAt?: string} = {}) {
  const calls: Array<{commandId: string; name: string; args: any}> = [];
  const send = async (commandId: string, name: string, args: any) => {
    calls.push({commandId, name, args});
    if (options.failAt === name) throw Object.assign(new Error(`failed ${name}`), {code: 'fixture_failure'});
    if (name === 'image_upload_begin') return {uploadId: 'upload_123', chunkBytes: IMAGE_CHUNK_BYTES, completedParts: [], expiresAt: new Date().toISOString()};
    if (name === 'image_upload_chunk') return {uploadId: 'upload_123', index: args.index, acceptedBytes: 0, duplicate: false};
    if (name === 'image_upload_complete') return {artifactId: 'artifact_image_1', uploadId: 'upload_123', mediaType: 'image/png', width: 20, height: 10, size: args.size ?? 0, contentHash: 'c'.repeat(64)};
    if (name === 'room_post') return {messageId: 'msg_image_1'};
    throw new Error(`unknown ${name}`);
  };
  return {calls, send};
}

test('uploadImage sends begin, deterministic chunks and complete without a filesystem path', async () => {
  const bytes = new Uint8Array(IMAGE_CHUNK_BYTES + 1234);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  const transport = fakeTransport();
  const result = await uploadImage(transport.send, bytes, {name: 'cat.png', operationId: 'root_1', alt: 'a cat'});
  assert.equal(result.artifactId, 'artifact_image_1');
  assert.deepEqual(transport.calls.map(call => call.name), ['image_upload_begin', 'image_upload_chunk', 'image_upload_chunk', 'image_upload_complete']);
  const ids = imageOperationIds('root_1');
  assert.equal(transport.calls[0].commandId, ids.begin);
  assert.equal(transport.calls[1].commandId, ids.part(0));
  assert.equal(transport.calls[2].commandId, ids.part(1));
  assert.equal(transport.calls[3].commandId, ids.complete);
  assert.equal(transport.calls[0].args.sha256, sha(bytes));
  assert.equal(transport.calls[0].args.alt, 'a cat');
  assert.ok(!('path' in transport.calls[0].args));
  const first = Buffer.from(transport.calls[1].args.dataBase64, 'base64');
  const second = Buffer.from(transport.calls[2].args.dataBase64, 'base64');
  assert.equal(first.byteLength, IMAGE_CHUNK_BYTES);
  assert.equal(second.byteLength, 1234);
  assert.equal(sha(first), sha(bytes.subarray(0, IMAGE_CHUNK_BYTES)));
  assert.equal(sha(second), sha(bytes.subarray(IMAGE_CHUNK_BYTES)));
  assert.equal(transport.calls[1].args.sha256, sha(first));
});

test('a retried operation reuses the same command ids across calls', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const first = fakeTransport(), second = fakeTransport();
  await uploadImage(first.send, bytes, {name: 'tiny.bin', operationId: 'root_retry'});
  await uploadImage(second.send, bytes, {name: 'tiny.bin', operationId: 'root_retry'});
  assert.deepEqual(first.calls.map(call => call.commandId), second.calls.map(call => call.commandId));
});

test('sendImage uploads then posts one attachment message and returns posted stage', async () => {
  const transport = fakeTransport();
  const bytes = new Uint8Array([9, 8, 7]);
  const result = await sendImage(transport.send, bytes, {name: 'tiny.png', operationId: 'root_post', text: 'see image', mentions: ['demo-planner']});
  assert.equal(result.stage, 'posted');
  assert.equal(result.messageId, 'msg_image_1');
  assert.equal(result.artifactId, 'artifact_image_1');
  const post = transport.calls.at(-1)!;
  assert.equal(post.name, 'room_post');
  assert.deepEqual(post.args.attachments, ['artifact_image_1']);
  assert.equal(post.args.text, 'see image');
  assert.equal(post.args.mentions[0], 'demo-planner');
  const ids = imageOperationIds('root_post');
  assert.equal(post.commandId, ids.post);
});

test('errors retain the failed phase and stable command id; aborts stop before more chunks', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const failing = fakeTransport({failAt: 'image_upload_complete'});
  await assert.rejects(() => uploadImage(failing.send, bytes, {name: 'bad.png', operationId: 'root_fail'}), (error: any) => {
    assert.ok(error instanceof ImageUploadError);
    assert.equal(error.stage, 'complete');
    assert.equal(error.commandId, imageOperationIds('root_fail').complete);
    return true;
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => uploadImage(fakeTransport().send, bytes, {name: 'bad.png', operationId: 'root_abort', signal: controller.signal}), /取消/);
});
