import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { createApp } from '../apps/server/src/app.ts';
import { issueAgentToken } from '../apps/server/src/agent-tokens.ts';

const parent = resolve('.state/test-data');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t: import('node:test').TestContext) {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'external-image-tools-'));
  const tokenSecret = 'external-image-owner-secret';
  const created = await createApp({root, token: tokenSecret, startWorker: false});
  await created.app.listen({port: 0, host: '127.0.0.1'});
  const address = created.app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const roomId = created.store.rooms()[0].id;
  const agentToken = issueAgentToken(tokenSecret, 'demo-planner', roomId);
  const bytes = await sharp({create: {width: 11, height: 7, channels: 3, background: '#8a2be2'}}).png().toBuffer();
  const imagePath = join(root, 'external.png');
  writeFileSync(imagePath, bytes);
  t.after(async () => {
    await created.app.close();
    try { await created.worker.close(); } catch { /* closed */ }
    try { created.store.close(); } catch { /* closed */ }
    rmSync(root, {recursive: true, force: true});
  });
  return {root, app: created.app, store: created.store, roomId, bytes, imagePath, env: {ROOM_URL: `http://127.0.0.1:${port}`, ROOM_AGENT_TOKEN: agentToken, ROOM_ROOM_ID: roomId, ROOM_IMAGE_ROOTS: root}};
}
type Ctx = Awaited<ReturnType<typeof fixture>>;

function startConnector(env: Record<string, string>) {
  const child = spawn(process.execPath, [resolve('scripts/room-agent-mcp.mjs')], {env: {...process.env, ...env}, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']}) as ChildProcessWithoutNullStreams;
  const pending = new Map<number, {resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout}>();
  let nextId = 1;
  createInterface({input: child.stdout}).on('line', line => {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
  });
  const request = (method: string, params?: unknown, timeoutMs = 30000): Promise<any> => {
    const id = nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => { pending.delete(id); rejectRequest(new Error(`${method} timeout`)); }, timeoutMs);
      pending.set(id, {resolve: resolveRequest, reject: rejectRequest, timer});
      child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, ...(params === undefined ? {} : {params})}) + '\n');
    });
  };
  return {child, request, stop: () => child.kill()};
}

async function callImage(ctx: Ctx, connector: ReturnType<typeof startConnector>, operationId: string) {
  return connector.request('tools/call', {name: 'room_send_image', arguments: {path: ctx.imagePath, operationId, text: 'external image'}});
}

test('external MCP room_send_image posts one verified image over real stdio and HTTP', async t => {
  const ctx = await fixture(t);
  const connector = startConnector(ctx.env);
  t.after(() => connector.stop());
  const initialized = await connector.request('initialize', {protocolVersion: '2025-06-18'});
  assert.equal(initialized.serverInfo.name, 'tempt-room-connector');
  const listed = await connector.request('tools/list', {});
  assert.ok(listed.tools.some((tool: any) => tool.name === 'room_send_image'));
  const called = await callImage(ctx, connector, 'external_root_1');
  assert.equal(called.isError, false, JSON.stringify(called.content));
  const image = JSON.parse(called.content[0].text);
  assert.match(image.artifactId, /^artifact_/);
  assert.match(image.messageId, /^msg_/);
  assert.equal(image.stage, 'posted');
  const artifact = ctx.store.get<any>('artifacts', image.artifactId)!;
  assert.equal(artifact.image.verified, true);
  assert.equal(artifact.image.width, 11);
  assert.equal(artifact.image.height, 7);
  assert.equal(sha(readFileSync(join(ctx.root, 'artifacts', `${image.artifactId}.preview.png`))), artifact.image.previewHash);
  assert.equal(ctx.store.snapshot(ctx.roomId).messages.filter(message => message.attachments.includes(image.artifactId)).length, 1);
});

test('retrying a lost MCP reply with the same operationId creates one artifact and one message', async t => {
  const ctx = await fixture(t);
  const connector = startConnector(ctx.env);
  t.after(() => connector.stop());
  await connector.request('initialize', {protocolVersion: '2025-06-18'});
  const first = JSON.parse((await callImage(ctx, connector, 'external_retry_root')).content[0].text);
  const second = JSON.parse((await callImage(ctx, connector, 'external_retry_root')).content[0].text);
  assert.equal(second.artifactId, first.artifactId);
  assert.equal(second.messageId, first.messageId);
  assert.equal(ctx.store.events(ctx.roomId).filter(event => event.type === 'artifact.created').length, 1);
  assert.equal(ctx.store.snapshot(ctx.roomId).messages.filter(message => message.attachments.includes(first.artifactId)).length, 1);
  assert.ok(existsSync(join(ctx.root, 'artifacts', first.artifactId)));
});
