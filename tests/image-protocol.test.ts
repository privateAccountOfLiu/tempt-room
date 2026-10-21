import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IMAGE_BASE64_MAX_CHARS, IMAGE_CHUNK_BYTES, IMAGE_MAX_BYTES, agentToolCallSchema,
  agentToolNameSchema, artifactSchema, imageMetadataSchema, imageOperationIds,
  imageUploadBeginSchema, imageUploadChunkSchema, imageUploadCompleteSchema,
  payloadSchemas, roomSendImageArgsSchema, roomToolNames
} from '../packages/protocol/src/index.ts';
import { authorizeTool } from '../apps/server/src/tool-authorization.ts';

const hash = 'a'.repeat(64);

test('image bounds and operation ids are deterministic and bounded', () => {
  assert.equal(IMAGE_CHUNK_BYTES, 192 * 1024);
  assert.equal(IMAGE_MAX_BYTES, 10 * 1024 * 1024);
  assert.ok(IMAGE_BASE64_MAX_CHARS < 1024 * 1024);
  const first = imageOperationIds('root_image_send_123');
  const second = imageOperationIds('root_image_send_123');
  assert.equal(first.begin, second.begin);
  assert.equal(first.part(2), second.part(2));
  assert.equal(first.complete, second.complete);
  assert.equal(first.post, second.post);
  const ids = [first.begin, first.part(0), first.part(5), first.complete, first.post];
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.ok(id.length <= 128 && /^[a-zA-Z0-9_-]+$/.test(id), id);
  const other = imageOperationIds('root_image_send_456');
  assert.notEqual(first.begin, other.begin);
});

test('begin rejects oversized files, unsafe names and invalid hashes', () => {
  assert.equal(imageUploadBeginSchema.safeParse({name: 'cat.png', size: 1, sha256: hash}).success, true);
  assert.equal(imageUploadBeginSchema.safeParse({name: 'cat.png', size: IMAGE_MAX_BYTES, sha256: hash, mediaType: 'image/webp', alt: 'a cat'}).success, true);
  for (const payload of [
    {name: 'cat.png', size: 0, sha256: hash},
    {name: 'cat.png', size: IMAGE_MAX_BYTES + 1, sha256: hash},
    {name: 'cat.png', size: 10, sha256: 'a'.repeat(63)},
    {name: '../escape.png', size: 10, sha256: hash},
    {name: 'CON.png', size: 10, sha256: hash},
    {name: 'cat.png', size: 10, sha256: hash, mediaType: 'image/gif'},
    {name: 'cat.png', size: 10, sha256: hash, actor: 'owner'}
  ]) assert.equal(imageUploadBeginSchema.safeParse(payload).success, false, JSON.stringify(payload));
});

test('chunk schema enforces canonical base64, chunk bytes and index bounds', () => {
  const data = Buffer.from('hello image').toString('base64');
  assert.equal(imageUploadChunkSchema.safeParse({uploadId: 'upload_1', index: 0, dataBase64: data, sha256: hash}).success, true);
  assert.equal(imageUploadChunkSchema.safeParse({uploadId: 'upload_1', index: 0, dataBase64: 'aGVs bG8=', sha256: hash}).success, false);
  assert.equal(imageUploadChunkSchema.safeParse({uploadId: 'upload_1', index: 0, dataBase64: data + '=', sha256: hash}).success, false);
  assert.equal(imageUploadChunkSchema.safeParse({uploadId: 'upload_1', index: -1, dataBase64: data, sha256: hash}).success, false);
  assert.equal(imageUploadChunkSchema.safeParse({uploadId: 'upload_1', index: 999, dataBase64: data, sha256: hash}).success, false);
  const tooLarge = Buffer.alloc(IMAGE_CHUNK_BYTES + 1).toString('base64');
  assert.equal(imageUploadChunkSchema.safeParse({uploadId: 'upload_1', index: 0, dataBase64: tooLarge, sha256: hash}).success, false);
  assert.equal(imageUploadCompleteSchema.safeParse({uploadId: 'upload_1'}).success, true);
  assert.equal(imageUploadCompleteSchema.safeParse({uploadId: 'upload_1', name: 'other.png'}).success, false);
});

test('artifact metadata is optional and image fields are verified-only', () => {
  const base = {id: 'artifact_image', roomId: 'room_image', name: 'cat.png', kind: 'file', mediaType: 'image/png', size: 3, createdAt: new Date().toISOString()};
  assert.equal(artifactSchema.safeParse(base).success, true);
  const withImage = {...base, contentHash: hash, image: {verified: true, width: 10, height: 20, alt: 'cat', previewMediaType: 'image/png', previewHash: hash, previewSize: 100}};
  assert.equal(artifactSchema.safeParse(withImage).success, true);
  assert.equal(imageMetadataSchema.safeParse({...withImage.image, verified: false}).success, false);
  assert.equal(imageMetadataSchema.safeParse({...withImage.image, previewMediaType: 'image/jpeg'}).success, false);
});

test('room tool mapping and write authorization include all image low-level operations', () => {
  const imageTools = ['image_upload_begin', 'image_upload_chunk', 'image_upload_complete'];
  for (const tool of imageTools) {
    assert.ok(roomToolNames.includes(tool as any), tool);
    assert.equal(agentToolNameSchema.safeParse(tool).success, true, tool);
    assert.equal(agentToolCallSchema.safeParse({commandId: 'cmd_image', roomId: 'room_image', name: tool, arguments: {}}).success, true, tool);
    const denied = authorizeTool({actor: {id: 'demo-planner', kind: 'agent'}, tool, args: {}, transport: 'external', fingerprint: 'fp', capabilityEvidence: []});
    assert.equal(denied.decision, 'deny', tool);
    assert.equal(denied.reason, 'capability_unverified', tool);
  }
  const readOnly = authorizeTool({actor: {id: 'demo-planner', kind: 'agent'}, tool: 'room_read', args: {}, transport: 'external', fingerprint: 'fp', capabilityEvidence: []});
  assert.equal(readOnly.decision, 'allow');
});

test('message.send accepts attachment-only or text-only messages but rejects an empty one', () => {
  const schema = payloadSchemas['message.send'];
  assert.equal(schema.safeParse({text: 'hello'}).success, true);
  assert.equal(schema.safeParse({text: '', attachments: ['artifact_image']}).success, true);
  assert.equal(schema.safeParse({text: '   ', attachments: ['artifact_image']}).success, true);
  assert.equal(schema.safeParse({text: '', attachments: []}).success, false);
  assert.equal(schema.safeParse({}).success, false);
});

test('connector convenience args are strict and never carry server identity or output paths', () => {
  const valid = {path: 'C:\\images\\cat.png', text: 'look', operationId: 'img_root_1'};
  assert.equal(roomSendImageArgsSchema.safeParse(valid).success, true);
  assert.equal(roomSendImageArgsSchema.safeParse({...valid, path: ''}).success, false);
  assert.equal(roomSendImageArgsSchema.safeParse({...valid, roomId: 'room_other'}).success, false);
  assert.equal(roomSendImageArgsSchema.safeParse({...valid, actor: 'owner'}).success, false);
  assert.equal(roomSendImageArgsSchema.safeParse({...valid, pathToWrite: 'x'}).success, false);
  assert.equal(roomSendImageArgsSchema.safeParse({...valid, operationId: ''}).success, false);
});
