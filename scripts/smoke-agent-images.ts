// Native image transport smoke. No model call and no network: it drives the
// real room-bridge MCP process over a real Windows named pipe into the room
// tool handler, using one fixed local PNG. Host mode is exercised here; sandbox
// mode is reported as not_verified unless its native harness is available.
//
// Run: npm run test:room-images-native -- --mode host
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { Store } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';
import { HostRoomPipe } from '../apps/server/src/host.ts';

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

let store: Store | undefined, worker: Worker | undefined, pipe: HostRoomPipe | undefined, bridge: ChildProcessWithoutNullStreams | undefined;
try {
  if (mode === 'sandbox') {
    const sandbox = resolve('sandbox/RoomSandbox/bin/Release/net10.0-windows/RoomSandbox.exe');
    report.verified = false;
    report.notVerified = existsSync(sandbox) ? 'AppContainer 图片管道 smoke 尚未实现；不把缺失当 supported' : '未构建 RoomSandbox.exe；AppContainer 图片管道 not_verified';
    report.ok = true;
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
  try { await worker?.close(); } catch { /* closing */ }
  try { store?.close(); } catch { /* closing */ }
  rmSync(runRoot, {recursive: true, force: true});
}
