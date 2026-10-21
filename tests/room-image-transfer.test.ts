import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { Store } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';
import { readLocalImage, roomSendImage, imageRoots } from '../scripts/room-image-transfer.mjs';

const parent = resolve('.state/test-data');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t: import('node:test').TestContext) {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'room-image-transfer-'));
  const store = new Store(join(root, 'room.sqlite'));
  const service = new RoomService(store);
  const worker = new Worker(store, service, root, {adapter: async function* () { yield {type: 'text', text: 'unused'}; }});
  t.after(async () => { await worker.close(); try { store.close(); } catch { /* closed */ } rmSync(root, {recursive: true, force: true}); });
  const bytes = await sharp({create: {width: 5, height: 3, channels: 3, background: '#137a4c'}}).png().toBuffer();
  const imagePath = join(root, 'fixture.png');
  writeFileSync(imagePath, bytes);
  return {root, store, worker, roomId: store.rooms()[0].id, agentId: 'demo-planner', bytes, imagePath, roots: [root]};
}
type Ctx = Awaited<ReturnType<typeof fixture>>;
const call = (ctx: Ctx) => (name: string, args: Record<string, unknown>, commandId: string) => ctx.worker.agentTool(ctx.agentId, ctx.roomId, name, args, commandId);

test('room_send_image reads inside allowed roots, uploads, and posts exactly one message', async t => {
  const ctx = await fixture(t);
  const result = await roomSendImage(call(ctx), {path: ctx.imagePath, text: 'from helper', alt: 'helper image', operationId: 'helper_root_1'}, ctx.roots);
  assert.match(result.artifactId, /^artifact_/);
  assert.match(result.messageId, /^msg_/);
  assert.equal(result.stage, 'posted');
  assert.equal(result.width, 5);
  assert.equal(result.height, 3);
  assert.equal(result.contentHash, sha(ctx.bytes));
  assert.equal(ctx.store.events(ctx.roomId).filter(event => event.type === 'artifact.created').length, 1);
  assert.equal(ctx.store.snapshot(ctx.roomId).messages.filter(message => message.attachments.includes(result.artifactId)).length, 1);
});

test('local path policy rejects missing, outside-root, URL/UNC and symlink paths', async t => {
  const ctx = await fixture(t);
  const bytes = ctx.bytes;
  const roots = ctx.roots;
  assert.throws(() => readLocalImage(join(ctx.root, 'missing.png'), roots), /不存在/);
  assert.throws(() => readLocalImage('https://example.test/cat.png', roots), /URL|UNC|设备|绝对/);
  assert.throws(() => readLocalImage('\\\\server\\share\\cat.png', roots), /URL|UNC|设备/);
  assert.throws(() => readLocalImage(ctx.imagePath, [join(ctx.root, 'other')]), /允许/);
  const link = join(ctx.root, 'link.png');
  try { symlinkSync(ctx.imagePath, link); assert.throws(() => readLocalImage(link, roots), /符号链接|普通文件/); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; }
  const read = readLocalImage(ctx.imagePath, roots);
  assert.equal(read.size, bytes.byteLength);
  assert.deepEqual(Array.from(read.bytes), Array.from(bytes));
  assert.equal(read.sha256, sha(bytes));
});

test('both room connectors advertise room_send_image with the same safe schema', () => {
  for (const script of ['scripts/room-agent-mcp.mjs', 'scripts/room-bridge.mjs']) {
    const input = [JSON.stringify({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18'}}), JSON.stringify({jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}}), ''].join('\n');
    const result = spawnSync(process.execPath, [script], {input, encoding: 'utf8', timeout: 15000, windowsHide: true});
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
    const lines = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    const tools = lines.find(line => line.id === 2).result.tools;
    const imageTool = tools.find((tool: any) => tool.name === 'room_send_image');
    assert.ok(imageTool, `${script} missing room_send_image`);
    assert.deepEqual(imageTool.inputSchema.required, ['path', 'operationId']);
    assert.ok(imageTool.inputSchema.properties.path);
    assert.ok(!('roomId' in imageTool.inputSchema.properties));
    const post = tools.find((tool: any) => tool.name === 'room_post');
    assert.ok(post.inputSchema.properties.attachments);
    assert.ok(post.inputSchema.properties.replyTo);
  }
  const roots = imageRoots({ROOM_IMAGE_ROOTS: parent}, process.cwd());
  assert.deepEqual(roots, [parent]);
});
