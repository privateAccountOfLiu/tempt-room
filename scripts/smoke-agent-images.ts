// Native image transport smoke. No model call and no network: it drives the
// real room-bridge MCP process over a real Windows named pipe into the room
// tool handler, using one fixed local PNG. Host mode uses HostRoomPipe; sandbox
// mode launches the staged Node + bridge inside the real Windows AppContainer.
//
// Run: npm run test:room-images-native -- --mode host
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { Store } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';
import { HostRoomPipe } from '../apps/server/src/host.ts';
import { SandboxHost } from '../apps/server/src/sandbox.ts';
import { stageToolchain } from '../apps/server/src/toolchain.ts';
import { ImageUploads } from '../apps/server/src/image-uploads.ts';
import { imageUploadBeginSchema, imageUploadChunkSchema, imageUploadCompleteSchema, payloadSchemas } from '../packages/protocol/src/index.ts';

const args = process.argv.slice(2);
const modeIndex = args.indexOf('--mode');
const mode = modeIndex >= 0 ? args[modeIndex + 1] : undefined;
if (mode !== 'host' && mode !== 'sandbox') {
  console.error('usage: tsx scripts/smoke-agent-images.ts --mode host|sandbox');
  process.exit(2);
}
const parent = resolve('.state', 'room-images-native');
mkdirSync(parent, {recursive: true});
const runRoot = mkdtempSync(join(parent, 'run-'));
const reportPath = join(parent, 'latest.json');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const report: any = {ok: false, verified: false, mode, modelRequests: 0, startedAt: new Date().toISOString(), runRoot, steps: []};
const step = (name: string, detail?: unknown) => { report.steps.push({name, at: new Date().toISOString(), ...(detail ? {detail} : {})}); console.log(`${name}: PASS`); };

function rpcRequest(child: ChildProcessWithoutNullStreams, id: number, method: string, params?: unknown, timeoutMs = 30000): Promise<any> {
  return new Promise((resolveRequest, rejectRequest) => {
    let done = false;
    const finish = (error: Error | null, value?: any) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('close', onClose);
      if (error) rejectRequest(error); else resolveRequest(value);
    };
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.id !== id) continue;
          message.error ? finish(new Error(message.error.message)) : finish(null, message.result);
          return;
        } catch { /* ignore non-JSON diagnostics */ }
      }
    };
    const onClose = () => finish(new Error('bridge closed'));
    const timer = setTimeout(() => finish(new Error(`${method} timeout`)), timeoutMs);
    child.stdout.on('data', onData);
    child.once('close', onClose);
    child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, ...(params === undefined ? {} : {params})}) + '\n');
  });
}

let store: Store | undefined, worker: Worker | undefined, pipe: HostRoomPipe | undefined, bridge: ChildProcessWithoutNullStreams | undefined, sandboxHost: SandboxHost | undefined;
try {
  if (mode === 'sandbox') {
    const sandbox = resolve('sandbox/RoomSandbox/bin/Release/net10.0-windows/RoomSandbox.exe');
    if (!existsSync(sandbox)) {
      report.verified = false;
      report.notVerified = '未构建 RoomSandbox.exe；AppContainer 图片管道 not_verified';
      report.ok = true;
      console.log(JSON.stringify(report, null, 2));
      writeFileSync(reportPath, JSON.stringify(report, null, 2));
      process.exit(0);
    }
    store = new Store(join(runRoot, 'room.sqlite'));
    const service = new RoomService(store);
    const uploads = new ImageUploads(store, runRoot);
    const roomId = store.rooms()[0].id, agentId = 'demo-planner';
    const workspace = join(runRoot, 'sandbox-workspace'), home = join(runRoot, 'sandbox-home');
    mkdirSync(workspace, {recursive: true}); mkdirSync(home, {recursive: true});
    const imageBytes = await sharp({create: {width: 18, height: 12, channels: 3, background: '#7a3c9c'}}).png().toBuffer();
    writeFileSync(join(workspace, 'fixture.png'), imageBytes);
    const tools = await stageToolchain(runRoot);
    const bridgePath = join(dirname(tools.node), 'room-bridge.mjs');
    if (!existsSync(bridgePath)) throw new Error('staged toolchain 缺少 room-bridge.mjs');
    const host = new SandboxHost(runRoot, sandbox);
    sandboxHost = host;
    const runId = `sandbox-image-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const stdoutFrames: string[] = [];
    const stderrFrames: string[] = [];
    let resolveExit!: (value: {exitCode: number; jobEmpty: boolean}) => void;
    const exited = new Promise<{exitCode: number; jobEmpty: boolean}>(done => { resolveExit = done; });
    const handleTool = async (request: any) => {
      try {
        const name = String(request?.name), args = request?.arguments ?? {};
        if (name === 'image_upload_begin') {
          const input = imageUploadBeginSchema.parse(args);
          return uploads.begin({...input, roomId, agentId, rootOperationId: String(request?.operationId ?? `sandbox_image_${runId}`)});
        }
        if (name === 'image_upload_chunk') {
          const input = imageUploadChunkSchema.parse(args);
          return await uploads.chunk(input.uploadId, input.index, Buffer.from(input.dataBase64, 'base64'), input.sha256, {roomId, agentId});
        }
        if (name === 'image_upload_complete') {
          const input = imageUploadCompleteSchema.parse(args);
          return await uploads.finalize(input.uploadId, {roomId, agentId});
        }
        if (name === 'room_post') {
          const input = payloadSchemas['message.send'].parse(args);
          return service.execute({version: '0.1', commandId: String(request?.operationId ?? `sandbox_post_${runId}`), roomId, type: 'message.send', payload: input});
        }
        return {error: {code: 'unsupported_tool', message: name}};
      } catch (error) {
        return {error: {code: (error as any)?.code ?? 'tool_failed', message: (error as Error).message}};
      }
    };
    host.on('notification', (frame: any) => {
      if (frame?.type === 'sandbox.output' && frame?.stream === 'stdout') { stdoutFrames.push(String(frame.data ?? '')); return; }
      if (frame?.type === 'sandbox.output' && frame?.stream === 'stderr') { stderrFrames.push(String(frame.data ?? '')); return; }
      if (frame?.type === 'sandbox.toolRequest') {
        void handleTool(frame.request).then(result => host.request('toolResponse', {runId: frame.runId, requestId: frame.requestId, result})).catch(() => {});
        return;
      }
      if (frame?.type === 'sandbox.exit') resolveExit({exitCode: Number(frame.exitCode ?? -1), jobEmpty: Boolean(frame.jobEmpty)});
    });
    const childScript = join(workspace, 'image-smoke-client.cjs');
    writeFileSync(childScript, `const cp = require('node:child_process');
const path = require('node:path');
const bridge = process.argv[2];
const child = cp.spawn(process.execPath, [bridge], {cwd: process.cwd(), env: {...process.env, ROOM_IMAGE_ROOTS: process.cwd()}, stdio: ['pipe', 'pipe', 'pipe']});
let buffer = '', nextId = 0;
const pending = new Map();
child.stdout.on('data', chunk => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let message; try { message = JSON.parse(line); } catch { continue; }
    const waiter = pending.get(message.id);
    if (!waiter) continue;
    pending.delete(message.id);
    message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
  }
});
function request(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, {resolve, reject});
    child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, ...(params === undefined ? {} : {params})}) + '\\n');
  });
}
(async () => {
  try {
    await request('initialize', {protocolVersion: '2025-06-18'});
    const listed = await request('tools/list', {});
    if (!listed.tools.some(tool => tool.name === 'room_send_image')) throw new Error('room_send_image missing');
    const response = await request('tools/call', {name: 'room_send_image', arguments: {path: path.join(process.cwd(), 'fixture.png'), text: 'sandbox smoke image', alt: 'sandbox fixture', operationId: 'sandbox_image_root'}});
    if (response.isError) throw new Error(JSON.stringify(response.content));
    const result = JSON.parse(response.content[0].text);
    console.log('SMOKE_RESULT:' + JSON.stringify(result));
    child.kill();
    process.exit(result.artifactId ? 0 : 1);
  } catch (error) {
    console.error('sandbox image smoke failed: ' + error.message);
    child.kill();
    process.exit(1);
  }
})();
`);
    await host.launch({runId, executable: tools.node, args: [childScript, bridgePath], workspace, home, runtimeRoots: tools.runtimeRoots, environment: {}, memoryMb: 2048, maxProcesses: 64, timeoutMs: 90000, roomPipe: `LOCAL\\TemptRoom-${runId}`});
    step('sandbox-image-process-started', {runId});
    const exit = await Promise.race([exited, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('sandbox image smoke timeout')), 120000))]);
    if (!exit.jobEmpty || exit.exitCode !== 0) throw new Error(`sandbox image process failed: exit=${exit.exitCode} jobEmpty=${exit.jobEmpty} stdout=${stdoutFrames.join('').slice(-500)} stderr=${stderrFrames.join('').slice(-1000)}`);
    const marker = stdoutFrames.join('').split(/\r?\n/).find(line => line.startsWith('SMOKE_RESULT:'));
    if (!marker) throw new Error('sandbox image smoke result missing');
    const result = JSON.parse(marker.slice('SMOKE_RESULT:'.length));
    const artifact = store.get<any>('artifacts', result.artifactId);
    if (!artifact?.image?.verified || artifact.image.width !== 18 || artifact.image.height !== 12) throw new Error('sandbox artifact verification failed');
    const messages = store.snapshot(roomId).messages.filter(message => message.attachments.includes(result.artifactId));
    if (messages.length !== 1) throw new Error('sandbox image message missing');
    const preview = readFileSync(join(runRoot, 'artifacts', `${result.artifactId}.preview.png`));
    if (sha(preview) !== artifact.image.previewHash) throw new Error('sandbox preview hash mismatch');
    step('sandbox-image-artifact-verified', {artifactId: result.artifactId, messageId: result.messageId});
    report.verified = true;
    report.ok = true;
    report.artifactId = result.artifactId;
    report.messageId = result.messageId;
    host.close();
    console.log(JSON.stringify(report, null, 2));
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    process.exit(0);
  }


  store = new Store(join(runRoot, 'room.sqlite'));
  const service = new RoomService(store);
  worker = new Worker(store, service, runRoot, {adapter: async function* () { yield {type: 'text', text: 'unused'}; }});
  const roomId = store.rooms()[0].id, agentId = 'demo-planner';
  pipe = new HostRoomPipe('smoke-host-image', async request => worker!.agentTool(agentId, roomId, request.name, request.arguments, request.operationId ?? `smoke_${randomUUID()}`));
  await pipe.start();
  step('host-pipe-listening', {pipe: pipe.pipePath});

  const imageBytes = await sharp({create: {width: 24, height: 16, channels: 3, background: '#2e8b57'}}).png().toBuffer();
  const imagePath = join(runRoot, 'smoke.png');
  writeFileSync(imagePath, imageBytes);
  const bridgePath = resolve('scripts/room-bridge.mjs');
  bridge = spawn(process.execPath, [bridgePath], {cwd: runRoot, windowsHide: true, env: {...process.env, ROOM_PIPE: pipe.pipePath, ROOM_IMAGE_ROOTS: runRoot}});
  bridge.stdout.setEncoding('utf8');
  const initialize = await rpcRequest(bridge, 1, 'initialize', {protocolVersion: '2025-06-18'});
  step('bridge-initialize', {server: initialize?.serverInfo?.name});
  const listed = await rpcRequest(bridge, 2, 'tools/list', {});
  const names = (listed.tools ?? []).map((tool: any) => tool.name);
  if (!names.includes('room_send_image')) throw new Error('room_send_image not listed');
  step('bridge-tools-list', {tools: names.length});
  const called = await rpcRequest(bridge, 3, 'tools/call', {name: 'room_send_image', arguments: {path: imagePath, operationId: `smoke_image_${Date.now()}`, text: 'native smoke image', alt: 'native smoke'}});
  if (called.isError) throw new Error(`room_send_image failed: ${JSON.stringify(called.content)}`);
  const result = JSON.parse(called.content[0].text);
  if (!result.artifactId || !result.messageId) throw new Error('missing artifact/message id');
  step('bridge-room-send-image', {artifactId: result.artifactId, messageId: result.messageId, stage: result.stage});
  const artifact = store.get<any>('artifacts', result.artifactId);
  if (artifact?.image?.verified !== true) throw new Error('artifact image not verified');
  if (artifact.image.width !== 24 || artifact.image.height !== 16) throw new Error('wrong image dimensions');
  if (sha(readFileSync(join(runRoot, 'artifacts', `${result.artifactId}.preview.png`))) !== artifact.image.previewHash) throw new Error('preview hash mismatch');
  const messages = store.snapshot(roomId).messages.filter(message => message.attachments.includes(result.artifactId));
  if (messages.length !== 1) throw new Error(`expected one image message, got ${messages.length}`);
  step('artifact-and-message-verified', {messages: messages.length});
  report.ok = true;
  report.verified = true;
  report.artifactId = result.artifactId;
  report.messageId = result.messageId;
  console.log(JSON.stringify(report, null, 2));
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
} catch (error) {
  report.ok = false;
  report.error = (error as Error).message;
  console.error(`image native smoke failed: ${report.error}`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  bridge?.kill();
  pipe?.close();
  try { sandboxHost?.close(); } catch { /* already closed */ }
  try { await worker?.close(); } catch { /* closing */ }
  try { store?.close(); } catch { /* closing */ }
  rmSync(runRoot, {recursive: true, force: true});
}
