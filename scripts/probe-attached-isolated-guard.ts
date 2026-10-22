/** Real local Codex App Server + local Responses fixture, then a real attached
 * Worker task whose frozen workspaceMode is isolated. The Worker must reject
 * the attached thread with workspace_mode_unsupported instead of silently
 * using the source directory. No paid model request: the local Responses
 * fixture would answer if one were made, and the report proves how many were.
 */
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { agentSchema } from '../packages/protocol/src/index.ts';
import type { Run, Task } from '../packages/protocol/src/index.ts';
import { Store, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';
import { AttachedCodexChannel } from '../apps/server/src/codex-attached-channel.ts';
import { diagnoseCodexAttachment } from '../apps/server/src/codex-attach.ts';

const { values } = parseArgs({ options: { codex: { type: 'string' } } });
if (!values.codex) throw new Error('Usage: npx tsx scripts/probe-attached-isolated-guard.ts --codex <absolute-codex.exe>');
const parent = resolve('.state/codex-attach/worker-guard'); mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'probe-')), home = join(root, 'codex-home'), cwd = join(root, 'workspace');
mkdirSync(home); mkdirSync(cwd);
let localRequests = 0, responses = 0;
const api = createServer(async (request, reply) => {
  localRequests++;
  for await (const _chunk of request) { /* fixture only */ }
  if (!request.url?.startsWith('/v1/responses')) { reply.writeHead(404); reply.end(); return; }
  responses++;
  const item = { id: 'fixture-answer', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'NATIVE_ATTACH_FIXTURE_OK', annotations: [] }] };
  const response = { id: `fixture-response-${responses}`, object: 'response', status: 'completed', model: 'fixture-model', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  reply.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const event of [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: item.content[0].text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response }
  ]) reply.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  reply.end();
});
await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
const port = (api.address() as any).port;
writeFileSync(join(home, 'config.toml'), `model = "fixture-model"\nmodel_provider = "room_fixture"\n[model_providers.room_fixture]\nname = "Local fixture only"\nbase_url = "http://127.0.0.1:${port}/v1"\nenv_key = "ROOM_ATTACH_GUARD_KEY"\nwire_api = "responses"\n`);
const reserve = createTcpServer(); await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve));
const wsPort = (reserve.address() as any).port; await new Promise<void>(resolve => reserve.close(() => resolve()));
const endpoint = `ws://127.0.0.1:${wsPort}`, credentialEnv = 'ROOM_ATTACH_GUARD_TOKEN', token = randomBytes(32).toString('hex');
process.env[credentialEnv] = token;
const child = spawn(resolve(values.codex), ['app-server', '--listen', endpoint, '--ws-auth', 'capability-token', '--ws-token-sha256', createHash('sha256').update(token).digest('hex')], {
  cwd, env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH, TEMP: process.env.TEMP, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: home, ROOM_ATTACH_GUARD_KEY: 'local-fixture-only', NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '' },
  windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
});
child.stdin.end(); child.stdout.resume();
let stderr = '', childExited = false, childError: Error | undefined;
child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-5000); });
child.on('exit', () => { childExited = true; });
child.on('error', error => { childError = error; childExited = true; });
const report: Record<string, any> = { at: new Date().toISOString(), realModelRequests: 0, localFixtureRequests: 0, ok: false };
let channel: AttachedCodexChannel | undefined, worker: Worker | undefined, store: Store | undefined;
try {
  const readyBy = Date.now() + 15000;
  while (true) {
    if (childError) throw childError;
    if (childExited) throw new Error('Owned fixture App Server exited');
    try { const response = await fetch(`http://127.0.0.1:${wsPort}/readyz`, { signal: AbortSignal.timeout(300) }); if (response.ok) break; } catch { /* retry */ }
    if (Date.now() > readyBy) throw new Error('Fixture App Server readiness timed out'); await delay(100);
  }
  const seed = { transport: 'websocket' as const, endpoint, credentialEnv, threadId: 'fixture', expectedCwd: cwd };
  channel = await AttachedCodexChannel.connect(seed);
  const created = await channel.request('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'read-only' });
  const binding = { ...seed, threadId: created.thread.id };
  const agent = agentSchema.parse({ id: 'native-guard', name: 'Native guard', provider: 'codex', enabled: true, connectionMode: 'attach', executionMode: 'host', codexBinding: binding });
  report.threadId = created.thread.id;
  report.diagnostics = await diagnoseCodexAttachment(agent);
  if (!report.diagnostics.ready) throw new Error('Real App Server attach diagnostics failed');
  const stateRoot = join(root, 'state'); mkdirSync(stateRoot, { recursive: true });
  store = new Store(join(stateRoot, 'room.sqlite'));
  const service = new RoomService(store);
  store.put('agents', agent);
  const room = store.rooms()[0];
  service.execute({ version: '0.1', commandId: uid(), roomId: room.id, type: 'room.configure', payload: { name: room.name, description: room.description, members: [...new Set([...(room.members ?? []), agent.id])], expectedRevision: room.revision ?? 1 } });
  worker = new Worker(store, service, stateRoot);
  worker.start();
  const contract = {
    objective: 'attached isolated guard', workspaceMode: 'isolated' as const,
    projectBinding: { id: 'binding_attach_guard', version: 1, baselineRef: 'fixture', manifestHash: 'a'.repeat(64), allowedPaths: ['fixture.txt'] },
    acceptance: [{ id: 'fixture', description: 'fixture', command: 'node -e "process.exit(0)"', verifierVersion: '1.0.0', verifierHash: 'a'.repeat(64) }],
    expectedArtifacts: [], dependencies: []
  };
  const taskId = service.execute({ version: '0.1', commandId: uid(), roomId: room.id, type: 'task.create', payload: { title: 'attached isolated guard', agentId: agent.id, projectPath: cwd, contract } }).result.taskId as string;
  const deadline = Date.now() + 30000;
  let run: Run | undefined;
  while (Date.now() < deadline) {
    worker.tick();
    run = store.list<Run>('runs', room.id).find(item => item.taskId === taskId);
    if (run && ['failed', 'completed', 'canceled', 'interrupted', 'unknown'].includes(run.status)) break;
    await delay(100);
  }
  if (!run) throw new Error('Worker did not create an attached run');
  report.guard = { taskId, runId: run.id, status: run.status, error: run.error, workspacePath: run.workspacePath, workspaceMode: run.workspaceMode, projectPath: cwd, threadId: binding.threadId, localFixtureRequests: localRequests, localFixtureResponses: responses };
  report.guardOk = run.status === 'failed' && /workspace_mode_unsupported|独立工作区/.test(String(run.error));
  if (!report.guardOk) throw new Error('attached isolated guard did not reject: ' + String(run.error));
  report.clientDisconnectLeavesBackendAlive = (await fetch(`http://127.0.0.1:${wsPort}/readyz`)).ok;
  report.ok = report.guardOk && report.clientDisconnectLeavesBackendAlive && responses === 0;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  report.stderrPresent = Boolean(stderr);
  process.exitCode = 1;
} finally {
  try { await worker?.close(); } catch { /* cleanup continues */ }
  try { store?.close(); } catch { /* cleanup continues */ }
  channel?.close(); delete process.env[credentialEnv];
  child.kill(); const deadline = Date.now() + 3000; while (!childExited && Date.now() < deadline) await delay(50);
  api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve()));
  report.localFixtureRequests = localRequests; report.localFixtureResponses = responses;
  report.ownedBackendExited = childExited;
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); console.log(`Report: ${join(root, 'report.json')}`);
}
