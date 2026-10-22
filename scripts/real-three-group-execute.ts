// Authorized real three-group experiment for V03. This script starts real host
// CLI turns and therefore consumes paid model budget. It enforces the default
// hard limits (30 minutes, 12 activations, 5 USD known cost), preserves a JSON
// report for failed attempts, and never hides unknown cost as zero.
//
// Run: ROOM_EXPERIMENT_AUTHORIZED=1 npm run experiment:three-groups:execute
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { Store, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';
import { createExperimentFixture, executionOverlap, planThreeGroupExperiment, summarizeExperimentCosts, DEFAULT_EXPERIMENT_LIMITS, type ExperimentAgent } from './real-experiment-groups.ts';
import { roomToolNames, type AgentDescriptor, type Artifact, type Run, type Task } from '../packages/protocol/src/index.ts';

const args = new Set(process.argv.slice(2));
if (!args.has('--execute') || process.env.ROOM_EXPERIMENT_AUTHORIZED !== '1') {
  console.error('真实付费实验需要显式授权：ROOM_EXPERIMENT_AUTHORIZED=1 且传 --execute。');
  process.exit(3);
}
const sourceDb = resolve('.state', 'room.sqlite');
if (!existsSync(sourceDb)) { console.error('缺少 .state/room.sqlite，无法复制已配置的真实 Agent 配置'); process.exit(2); }
const sourceStore = new Store(sourceDb);
const configured = sourceStore.list<AgentDescriptor>('agents').filter(agent => agent.enabled && ['claude', 'codex', 'deepseek'].includes(agent.provider));
sourceStore.close();
const baseAgent = configured.find(agent => agent.provider === 'claude') ?? configured[0];
if (!baseAgent) { console.error('没有已配置的真实 Agent（claude/codex/deepseek）'); process.exit(2); }
if (process.env.DEEPSEEK_API_KEY === undefined) {
  const fromUser = process.env.USERPROFILE ? (await import('node:child_process')).execFileSync('powershell', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY','User')"], {encoding: 'utf8'}).trim() : '';
  if (fromUser) process.env.DEEPSEEK_API_KEY = fromUser;
}

const limits = {...DEFAULT_EXPERIMENT_LIMITS};
const selectedGroups = new Set((process.env.ROOM_EXPERIMENT_GROUPS ?? 'single,single-image,parallel-independent,collaborative').split(',').map(group => group.trim()).filter(Boolean));
const groupEnabled = (groupId: string) => selectedGroups.has(groupId);
const startedAt = Date.now();
const deadline = startedAt + limits.maxMinutes * 60 * 1000;
const experimentParent = resolve('.state', 'real-experiment');
mkdirSync(experimentParent, {recursive: true});
const root = mkdtempSync(join(experimentParent, 'execute-'));
const stateRoot = join(root, 'state');
mkdirSync(stateRoot, {recursive: true});
const fixture = createExperimentFixture(root);
const imagePath = join(fixture.projectPath, 'fixture-image.png');
writeFileSync(imagePath, await sharp({create: {width: 16, height: 10, channels: 3, background: '#2f6f4e'}}).png().toBuffer());

const store = new Store(join(stateRoot, 'room.sqlite'));
const service = new RoomService(store);
const roomId = store.rooms()[0].id;
const makeAgent = (suffix: string, name: string): AgentDescriptor => ({...baseAgent, id: `real_${suffix}`, name, role: `V03 真实实验 ${suffix}`, enabled: true, connectionMode: 'managed', executionMode: 'host', schedulerWeight: 1, roomToolPolicy: 'allow', allowedRoomTools: [...roomToolNames]});
const agentA = makeAgent('a', '真实实验 A'), agentB = makeAgent('b', '真实实验 B');
store.put('agents', agentA);
store.put('agents', agentB);
const currentRoom = store.room(roomId)!;
service.execute({version: '0.1', commandId: uid(), roomId, type: 'room.configure', payload: {name: currentRoom.name, description: currentRoom.description, members: [...new Set([...(currentRoom.members ?? []), agentA.id, agentB.id])], expectedRevision: currentRoom.revision ?? 1}});
service.execute({version: '0.1', commandId: uid(), roomId, type: 'settings.update', payload: {...store.settings(), concurrency: 4, maxConcurrentRunsPerRoom: 3}});
const worker = new Worker(store, service, stateRoot);
worker.start();
const modelRequests: string[] = [];
const errors: string[] = [];
const runs: {groupId: string; runId: string; agentId: string; status: string; startedAt?: string; finishedAt?: string; usage?: Run['usage']; error?: string; artifacts: string[]}[] = [];
const command = (type: string, payload: unknown, id = roomId) => service.execute({version: '0.1', commandId: uid(), roomId: id, type, payload});
const contract = (dependencies: string[]) => ({
  objective: 'V03 order-query experiment',
  workspaceMode: 'isolated' as const,
  projectBinding: {id: 'binding_v03_experiment', version: 1, baselineRef: 'v03-fixture', manifestHash: 'a'.repeat(64), allowedPaths: ['order-query.json', 'planner.txt', 'reviewer.txt', 'README.md', 'fixture-image.png', 'baseline.txt', 'tests']},
  acceptance: [{id: 'owner-verifier', description: 'owner-controlled verifier', command: 'node -e', argv: ['node', '-e', 'process.exit(0)'], verifierVersion: '1.0.0', verifierHash: fixture.verifierHash}],
  expectedArtifacts: [],
  dependencies: dependencies.map(taskId => ({taskId, condition: 'execution' as const, taskVersion: store.get<Task>('tasks', taskId)?.version ?? 1}))
});
const taskPrompt = (text: string) => `[V03 真实实验：请直接在当前工作目录完成，不要只解释] ${text}`;
function createTask(groupId: string, agent: AgentDescriptor, prompt: string, dependencies: string[] = []) {
  if (modelRequests.length >= limits.maxActivations) throw new Error('激活数达到硬限制');
  const taskId = command('task.create', {title: taskPrompt(prompt), agentId: agent.id, projectPath: fixture.projectPath, dependencies, contract: contract(dependencies)}).result.taskId as string;
  modelRequests.push(taskId);
  return taskId;
}
async function pump(groupId: string, taskIds: string[], timeoutMs: number) {
  const until = Math.min(Date.now() + timeoutMs, deadline);
  while (Date.now() < until) {
    worker.tick();
    const current = taskIds.map(taskId => store.list<Run>('runs', roomId).find(run => run.taskId === taskId));
    if (current.every(run => run && ['completed', 'failed', 'canceled', 'interrupted', 'unknown'].includes(run.status))) return;
    await new Promise(done => setTimeout(done, 250));
  }
  for (const taskId of taskIds) {
    const run = store.list<Run>('runs', roomId).find(item => item.taskId === taskId);
    if (run && !['completed', 'failed', 'canceled'].includes(run.status)) { try { command('run.cancel', {runId: run.id}); } catch { /* best effort */ } }
  }
  throw new Error(`实验组 ${groupId} 超时`);
}
function record(groupId: string, taskIds: string[]) {
  for (const taskId of taskIds) {
    const run = store.list<Run>('runs', roomId).find(item => item.taskId === taskId)!;
    const artifacts = store.list<Artifact>('artifacts', roomId).filter(artifact => artifact.runId === run.id).map(artifact => artifact.id);
    runs.push({groupId, runId: run.id, agentId: run.agentId, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt, usage: run.usage, error: run.error, artifacts});
    if (run.status !== 'completed') errors.push(`${groupId}/${run.id}: ${run.status} ${run.error ?? ''}`.trim());
  }
}
function findHostImage(runId: string) {
  const messages = store.snapshot(roomId).messages.filter(message => message.runId === runId && message.attachments.length > 0);
  for (const message of messages) {
    for (const artifactId of message.attachments) {
      const artifact = store.get<Artifact>('artifacts', artifactId);
      if (artifact?.image?.verified === true) return {runId, artifactId: artifact.id, messageId: message.id, verified: true, width: artifact.image.width, height: artifact.image.height, previewHash: artifact.image.previewHash};
    }
  }
  return {runId, artifactId: null, messageId: null, verified: false};
}
function captureGroup(groupId: string) {
  const messages = store.snapshot(roomId).messages.slice(-8).map(message => ({actor: message.actor, text: message.text.slice(0, 500), attachments: message.attachments}));
  const toolEvents = store.events(roomId).filter(event => ['agent.tool.called', 'run.tool.completed', 'audit.recorded'].includes(event.type)).slice(-40).map(event => ({type: event.type, payload: event.payload}));
  return {groupId, messages, toolEvents};
}
function costGuard() {
  const summary = summarizeExperimentCosts(runs.map(run => ({costUsd: run.usage?.costUsd, runId: run.runId})));
  if (summary.knownUsd > limits.maxCostUsd) throw new Error(`已知成本 ${summary.knownUsd} USD 超过上限 ${limits.maxCostUsd}`);
  return summary;
}
process.env.ROOM_DEBUG_HOST_LOG = join(root, 'host-debug.log');
const cliVersion = (() => { try { return execFileSync(baseAgent.executable, ['--version'], {encoding: 'utf8', timeout: 30000, windowsHide: true}).trim().split(/\r?\n/)[0]; } catch (error) { return 'version_unavailable: ' + (error as Error).message.slice(0, 200); } })();
const report: any = {root, stateRoot, startedAt: new Date(startedAt).toISOString(), mode: 'execute', limits, fixture, agents: {a: agentA.id, b: agentB.id}, agentMetadata: {provider: baseAgent.provider, executable: baseAgent.executable, endpoint: baseAgent.endpoint, model: baseAgent.model || '(cli default)', credentialEnv: baseAgent.credentialEnv || null, configuredVersion: baseAgent.version || null, cliVersion, executionMode: 'host', workspaceMode: 'isolated', connectionMode: 'managed', accountSource: 'user-configured host CLI/model'}, verifier: fixture.verifier, modelRequests: 0, groups: [], errors, runs, imageEvidence: null, cleanup: false};
try {
  // Group 1: single agent, with a real fixed-image host call.
  if (groupEnabled('single')) {
  const single = createTask('single', agentA, `Create a file order-query.json in the current working directory containing exactly this JSON: {"query":"SELECT * FROM orders WHERE id = ?","parameterized":true,"tests":2}. Also use the room_send_image tool with path equal to the absolute path of fixture-image.png in your current working directory, alt "v03 host image", operationId "v03_single_image". Keep the final answer under 20 words.`);
  await pump('single', [single], 8 * 60 * 1000);
  record('single', [single]);
  const singleRun = store.list<Run>('runs', roomId).find(run => run.taskId === single)!;
  report.imageEvidence = findHostImage(singleRun.id);
  report.groups.push({id: 'single', taskIds: [single], status: singleRun.status});
  (report.groupDetails ??= []).push(captureGroup('single'));
  }
  if (groupEnabled('single-image') && Date.now() < deadline) {
    const imageTask = createTask('single-image', agentA, 'You MUST call the room MCP tool room_send_image exactly once. The image is fixture-image.png in your current working directory. Determine its absolute path and pass it as the path argument, alt "v03 host image", operationId "v03_host_image_20261022". If the tool is not available reply exactly TOOL_MISSING; if it fails reply the error. Do not use shell to send the image and do not create files.');
    await pump('single-image', [imageTask], 8 * 60 * 1000);
    record('single-image', [imageTask]);
    const imageRun = store.list<Run>('runs', roomId).find(run => run.taskId === imageTask)!;
    report.imageEvidence = findHostImage(imageRun.id);
    report.groups.push({id: 'single-image', taskIds: [imageTask], status: imageRun.status, imageEvidence: report.imageEvidence});
    (report.groupDetails ??= []).push(captureGroup('single-image'));
  }

  // Group 2: two independent agents should have overlapping execution intervals.
  if (groupEnabled('parallel-independent') && Date.now() < deadline) {
    const parallelA = createTask('parallel-independent', agentA, 'Create order-query.json in the current working directory with exactly this JSON: {"query":"SELECT * FROM orders WHERE id = ?","parameterized":true,"tests":2}. Do not create other files. Keep the final answer short.');
    const parallelB = createTask('parallel-independent', agentB, 'Create order-query.json in the current working directory with exactly this JSON: {"query":"SELECT * FROM orders WHERE id = ?","parameterized":true,"tests":2}. Do not create other files. Keep the final answer short.');
    await pump('parallel-independent', [parallelA, parallelB], 8 * 60 * 1000);
    record('parallel-independent', [parallelA, parallelB]);
    const a = store.list<Run>('runs', roomId).find(run => run.taskId === parallelA)!;
    const b = store.list<Run>('runs', roomId).find(run => run.taskId === parallelB)!;
    report.groups.push({id: 'parallel-independent', taskIds: [parallelA, parallelB], overlap: executionOverlap(a, b), statuses: [a.status, b.status]});
    (report.groupDetails ??= []).push(captureGroup('parallel-independent'));
  } else report.groups.push({id: 'parallel-independent', status: 'not_run_limit'});

  // Group 3: collaborative dependency plus controlled integration of the final patch.
  if (groupEnabled('collaborative') && Date.now() < deadline) {
    const upstream = createTask('collaborative', agentA, 'Create order-query.json in the current working directory with exactly: {"query":"SELECT * FROM orders WHERE id = ?","parameterized":true,"tests":2}');
    await pump('collaborative', [upstream], 8 * 60 * 1000);
    record('collaborative', [upstream]);
    const downstream = createTask('collaborative', agentB, 'The current working directory already contains order-query.json from the upstream task. Read it, keep query and parameterized fields, set tests to 3, and write it back. Keep the final answer under 20 words.', [upstream]);
    await pump('collaborative', [downstream], 8 * 60 * 1000);
    record('collaborative', [downstream]);
    const upstreamRun = store.list<Run>('runs', roomId).find(run => run.taskId === upstream)!;
    const downstreamRun = store.list<Run>('runs', roomId).find(run => run.taskId === downstream)!;
    const integrateArtifact = async (artifactId: string, label: string) => {
      try {
        const queued = command('artifact.integrate', {artifactId}) as any;
        const until = Date.now() + 60000;
        while (Date.now() < until) {
          worker.tick();
          const current = store.get<any>('integrations', queued.result.integrationId);
          if (current && ['applied', 'blocked', 'conflict', 'unknown'].includes(current.status)) return {label, integrationId: current.id, status: current.status, errorCode: current.errorCode};
          await new Promise(done => setTimeout(done, 250));
        }
        return {label, status: 'timeout'};
      } catch (error) { errors.push(label + ': ' + (error as Error).message); return {label, status: 'error', error: (error as Error).message}; }
    };
    const upstreamArtifact = store.list<Artifact>('artifacts', roomId).find(item => item.runId === upstreamRun.id && item.kind === 'patch');
    const downstreamArtifact = store.list<Artifact>('artifacts', roomId).find(item => item.runId === downstreamRun.id && item.kind === 'patch');
    const integrations = [];
    if (upstreamArtifact) integrations.push(await integrateArtifact(upstreamArtifact.id, 'upstream'));
    await new Promise(done => setTimeout(done, 250));
    if (downstreamArtifact) integrations.push(await integrateArtifact(downstreamArtifact.id, 'downstream'));
    report.groups.push({id: 'collaborative', taskIds: [upstream, downstream], integrations, statuses: [store.get<Task>('tasks', upstream)?.status, store.get<Task>('tasks', downstream)?.status]});
    (report.groupDetails ??= []).push(captureGroup('collaborative'));
  } else report.groups.push({id: 'collaborative', status: 'not_run_limit'});
  report.costs = costGuard();
  report.modelRequests = modelRequests.length;
  report.elapsedMs = Date.now() - startedAt;
  report.ok = runs.length > 0 && runs.every(run => run.status === 'completed') && Boolean(report.imageEvidence?.verified);
} catch (error) {
  errors.push((error as Error).message);
  report.ok = false;
} finally {
  try { await worker.close(); } catch { /* cleanup continues */ }
  try { store.close(); } catch { /* cleanup continues */ }
  report.modelRequests = modelRequests.length;
  report.costs ??= summarizeExperimentCosts(runs.map(run => ({costUsd: run.usage?.costUsd, runId: run.runId})));
  report.finishedAt = new Date().toISOString();
  report.cleanup = true;
  const reportPath = join(experimentParent, 'three-group-report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ok: report.ok, reportPath, modelRequests: report.modelRequests, groups: report.groups, imageEvidence: report.imageEvidence, costs: report.costs, errors: report.errors, elapsedMs: report.elapsedMs}, null, 2));
  process.exit(report.ok ? 0 : 1);
}
