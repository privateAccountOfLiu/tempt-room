/** Real local App Server + a local Responses fixture. No account or paid model. */
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { agentSchema, type AgentOutput, type CodexRunState } from '../packages/protocol/src/index.ts';
import { AttachedCodexChannel } from '../apps/server/src/codex-attached-channel.ts';
import { diagnoseCodexAttachment, attachedCodexRun } from '../apps/server/src/codex-attach.ts';

const { values } = parseArgs({ options: { codex: { type: 'string' } } });
const methods:Record<string,number>={},originalRequest=AttachedCodexChannel.prototype.request;
AttachedCodexChannel.prototype.request=function(method,params,timeoutMs){methods[method]=(methods[method]??0)+1;return originalRequest.call(this,method,params,timeoutMs);};
if (!values.codex) throw new Error('Usage: npm run test:codex-attach-native -- --codex <absolute-codex.exe>');
const parent = resolve('.state/codex-attach/native'); mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'probe-')), home = join(root, 'codex-home'), cwd = join(root, 'workspace');
mkdirSync(home); mkdirSync(cwd);
let localRequests = 0, responses = 0;
const api = createServer(async (request, reply) => {
  localRequests++;
  for await (const _chunk of request) { /* discard fixture request: never write prompts to reports */ }
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
writeFileSync(join(home, 'config.toml'), `model = "fixture-model"\nmodel_provider = "room_fixture"\n[model_providers.room_fixture]\nname = "Local fixture only"\nbase_url = "http://127.0.0.1:${port}/v1"\nenv_key = "ROOM_ATTACH_PROBE_KEY"\nwire_api = "responses"\n`);
const reserve = createTcpServer(); await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve));
const wsPort = (reserve.address() as any).port; await new Promise<void>(resolve => reserve.close(() => resolve()));
const endpoint = `ws://127.0.0.1:${wsPort}`, credentialEnv = 'ROOM_NATIVE_ATTACH_PROBE_TOKEN', token = randomBytes(32).toString('hex');
process.env[credentialEnv] = token;
const child = spawn(resolve(values.codex), ['app-server', '--listen', endpoint, '--ws-auth', 'capability-token', '--ws-token-sha256', createHash('sha256').update(token).digest('hex')], {
  cwd, env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH, TEMP: process.env.TEMP, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: home, ROOM_ATTACH_PROBE_KEY: 'local-fixture-only', NO_PROXY:'127.0.0.1,localhost,::1',no_proxy:'127.0.0.1,localhost,::1',HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'' },
  windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
});
child.stdin.end();child.stdout.resume();
let stderr = '', childExited = false, childError:Error|undefined;
child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-5000); });
child.on('exit', () => { childExited = true; });child.on('error',error=>{childError=error;childExited=true;});
const report: Record<string, any> = { at: new Date().toISOString(), realModelRequests: 0, localFixtureRequests: 0, ok: false };
let channel: AttachedCodexChannel | undefined;
try {
  const readyBy = Date.now() + 15000;
  while (true) {
    if (childError) throw childError;
    if (childExited) throw new Error('Owned fixture App Server exited');
    try { const response = await fetch(`http://127.0.0.1:${wsPort}/readyz`, { signal: AbortSignal.timeout(300) }); if (response.ok) break; } catch {}
    if (Date.now() > readyBy) throw new Error('Fixture App Server readiness timed out'); await delay(100);
  }
  // Creating this isolated fixture thread never loads or changes desktop threads.
  const seed = { transport: 'websocket' as const, endpoint, credentialEnv, threadId: 'fixture', expectedCwd: cwd };
  channel = await AttachedCodexChannel.connect(seed);
  const created = await channel.request('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'read-only' });
  const binding = { ...seed, threadId: created.thread.id };
  const agent = agentSchema.parse({ id: 'native-fixture', name: 'Native fixture', provider: 'codex', connectionMode: 'attach', executionMode: 'host', codexBinding: binding });
  report.server = channel.server;
  report.diagnostics = await diagnoseCodexAttachment(agent);
  if (!report.diagnostics.ready) throw new Error('Real App Server attach diagnostics failed');
  const states: CodexRunState[] = [], output: AgentOutput[] = [];
  for await (const item of attachedCodexRun({ agent, run: { id: 'run_native_fixture', roomId: 'room_fixture', agentId: agent.id, status: 'running', prompt: 'Fixture', basedOnSeq: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    prompt: 'Reply with the fixture marker.', workspace: cwd, home: root, stateRoot: root, host: {} as any, signal: AbortSignal.timeout(30000), saveCodexState: state => {states.push(state);report.finalState=state;} })) output.push(item);
  report.finalState = states.at(-1); report.reply = output.filter(item => item.type === 'text').map(item => item.text).join('');
  report.clientDisconnectLeavesBackendAlive = (await fetch(`http://127.0.0.1:${wsPort}/readyz`)).ok;
  report.ok = report.reply === 'NATIVE_ATTACH_FIXTURE_OK' && report.finalState?.nativeStatus === 'completed' && report.clientDisconnectLeavesBackendAlive;
  if (!report.ok) throw new Error('Native fixture did not produce the expected completed output');
} catch (error) { report.error = error instanceof Error ? error.message : String(error); report.cause=error instanceof Error&&error.cause instanceof Error?{message:error.cause.message,detail:(error.cause as any).detail}:undefined;report.stderrPresent = Boolean(stderr); process.exitCode = 1; }
finally {
  report.methods=methods;
  channel?.close(); delete process.env[credentialEnv];
  // Only the backend created above belongs to this script.
  child.kill(); const deadline = Date.now() + 3000; while (!childExited && Date.now() < deadline) await delay(50);
  api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve()));
  report.localFixtureRequests = localRequests; report.localFixtureResponses = responses; report.ownedBackendExited = childExited;
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); console.log(`Report: ${join(root, 'report.json')}`);
}
