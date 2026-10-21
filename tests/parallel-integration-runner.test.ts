import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {createApp} from '../apps/server/src/app.ts';
import {uid} from '../apps/server/src/store.ts';
import {acquireResource, canonicalProjectKey} from '../apps/server/src/resource-manager.ts';
import type {Integration, Run} from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');
const hash = 'a'.repeat(64);

async function fixture(t: import('node:test').TestContext) {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'parallel-integration-'));
  const {app, store, service, worker} = await createApp({root, startWorker: false, token: 'parallel-owner'});
  t.after(async () => { await app.close(); rmSync(root, {recursive: true, force: true}); });
  return {root, app, store, service, worker};
}
type Ctx = Awaited<ReturnType<typeof fixture>>;

function makeRoom(ctx: Ctx, name: string): string {
  return ctx.service.execute({version: '0.1', commandId: uid(), type: 'room.create', payload: {name, members: ['demo-planner']}}).result.roomId as string;
}

/**
 * Create one completed candidate run and enqueue its integration. The optional
 * verifier writes start/end timestamps into the shared timeline file.
 */
function enqueue(ctx: Ctx, roomId: string, project: string, file: string, timeline: string, sleepMs = 0): string {
  mkdirSync(project, {recursive: true});
  writeFileSync(join(project, file), 'original\n');
  const verifier = sleepMs > 0 ? `const fs=require('fs');const p=process.argv[1];fs.appendFileSync(p,JSON.stringify({e:'start',t:Date.now(),file:${JSON.stringify(file)}})+'\\n');setTimeout(()=>{fs.appendFileSync(p,JSON.stringify({e:'end',t:Date.now(),file:${JSON.stringify(file)}})+'\\n');},${sleepMs});` : 'process.exit(0)';
  const check = {id: `verify-${file.replace(/[^a-zA-Z0-9_-]/g, '_')}`, description: 'verification', command: 'node -e', argv: ['node', '-e', verifier, ...(sleepMs > 0 ? [timeline] : [])], verifierVersion: '1.0.0', verifierHash: hash};
  const bindingId = `binding_${file.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const contract = {objective: 'parallel integration', projectBinding: {id: bindingId, version: 1, baselineRef: 'baseline_1', manifestHash: hash, allowedPaths: [file]}, acceptance: [check], expectedArtifacts: [], dependencies: []};
  const command = (type: string, payload: unknown) => ctx.service.execute({version: '0.1', commandId: uid(), roomId, type, payload});
  const taskId = command('task.create', {title: `integration ${file}`, agentId: 'demo-planner', projectPath: project, contract}).result.taskId as string;
  const run = ctx.store.list<Run>('runs', roomId).find(item => item.taskId === taskId)!;
  run.status = 'running'; ctx.store.event(roomId, 'run.started', {id: 'system', kind: 'system'}, {run});
  const snapshot = ctx.worker.workspaces.snapshot(project, run.id);
  writeFileSync(join(snapshot.workspace, file), 'candidate\n');
  const changes = ctx.worker.workspaces.changes(run.id);
  const artifact = ctx.worker.publishArtifact(run, `${file}.patch`, changes.patch, 'text/x-diff', 'patch');
  writeFileSync(join(ctx.root, 'artifacts', artifact.id + '.changes.json'), JSON.stringify(changes));
  ctx.worker.finish(run, 'completed');
  return command('artifact.integrate', {artifactId: artifact.id}).result.integrationId as string;
}

async function waitIntegration(ctx: Ctx, id: string, statuses: Integration['status'][], timeoutMs = 30000): Promise<Integration> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = ctx.store.get<Integration>('integrations', id);
    if (current && statuses.includes(current.status)) return current;
    await new Promise(done => setTimeout(done, 25));
  }
  assert.fail(`integration ${id} did not reach ${statuses.join('/')}: ${ctx.store.get<Integration>('integrations', id)?.status}`);
}

function parseTimeline(path: string) {
  if (!existsSync(path)) return [] as Array<{e: string; t: number; file: string}>;
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('a blocked project does not stop an integration for another project', async t => {
  const ctx = await fixture(t);
  const projectA = join(ctx.root, 'project-a'), projectB = join(ctx.root, 'project-b');
  mkdirSync(projectA, {recursive: true}); mkdirSync(projectB, {recursive: true});
  const roomA = ctx.store.rooms()[0].id;
  const blocker = acquireResource(ctx.store, {roomId: roomA, kind: 'project', key: canonicalProjectKey(projectA), run: {id: 'blocker_run', generation: 1}});
  const roomB = makeRoom(ctx, 'project-b room');
  const integrationId = enqueue(ctx, roomB, projectB, 'b.txt', join(ctx.root, 'b.timeline'));
  ctx.worker.tick();
  const applied = await waitIntegration(ctx, integrationId, ['applied']);
  assert.equal(applied.status, 'applied');
  assert.equal(readFileSync(join(projectB, 'b.txt'), 'utf8'), 'candidate\n');
  assert.equal(ctx.store.list<any>('resource_leases', roomA).find(item => item.id === blocker.id)?.status, 'active');
});

test('two projects verify concurrently within the verifier limit', async t => {
  const ctx = await fixture(t);
  const projectA = join(ctx.root, 'overlap-a'), projectB = join(ctx.root, 'overlap-b');
  const timeline = join(ctx.root, 'overlap.timeline');
  const roomA = ctx.store.rooms()[0].id, roomB = makeRoom(ctx, 'overlap room');
  const a = enqueue(ctx, roomA, projectA, 'a.txt', timeline, 500);
  const b = enqueue(ctx, roomB, projectB, 'b.txt', timeline, 500);
  ctx.worker.tick();
  await waitIntegration(ctx, a, ['applied'], 40000);
  await waitIntegration(ctx, b, ['applied'], 40000);
  const events = parseTimeline(timeline);
  const firstEnd = events.find(event => event.e === 'end' && event.file === 'a.txt');
  const secondStart = events.find(event => event.e === 'start' && event.file === 'b.txt');
  const reverseFirstEnd = events.find(event => event.e === 'end' && event.file === 'b.txt');
  const reverseSecondStart = events.find(event => event.e === 'start' && event.file === 'a.txt');
  assert.ok(Boolean(firstEnd && secondStart && firstEnd.t > secondStart.t) || Boolean(reverseFirstEnd && reverseSecondStart && reverseFirstEnd.t > reverseSecondStart.t), 'verifiers from different projects must overlap');
});

test('two rooms targeting the same project serialize their verification', async t => {
  const ctx = await fixture(t);
  const project = join(ctx.root, 'shared-project');
  mkdirSync(project, {recursive: true});
  writeFileSync(join(project, 'a.txt'), 'original\n');
  writeFileSync(join(project, 'b.txt'), 'original\n');
  const timeline = join(ctx.root, 'shared.timeline');
  const roomA = ctx.store.rooms()[0].id, roomB = makeRoom(ctx, 'shared room');
  const a = enqueue(ctx, roomA, project, 'a.txt', timeline, 350);
  const b = enqueue(ctx, roomB, project, 'b.txt', timeline, 350);
  const deadline = Date.now() + 40000;
  let statuses: string[] = [];
  while (Date.now() < deadline) {
    ctx.worker.tick();
    const current = [ctx.store.get<Integration>('integrations', a), ctx.store.get<Integration>('integrations', b)];
    statuses = current.map(item => item?.status ?? 'missing');
    if (statuses.every(status => ['applied', 'conflict', 'verification_failed', 'unknown'].includes(status))) break;
    await new Promise(done => setTimeout(done, 50));
  }
  assert.deepEqual(statuses, ['applied', 'applied']);
  const events = parseTimeline(timeline);
  assert.equal(events.length, 4);
  const byFile = new Map<string, {start?: number; end?: number}>();
  for (const event of events) {
    const entry = byFile.get(event.file) ?? {};
    if (event.e === 'start') entry.start = event.t;
    else entry.end = event.t;
    byFile.set(event.file, entry);
  }
  const intervals = [...byFile.values()].sort((left, right) => (left.start ?? 0) - (right.start ?? 0));
  assert.equal(intervals.length, 2);
  assert.ok((intervals[0]!.end ?? 0) <= (intervals[1]!.start ?? 0), 'same-project verifiers must not overlap');
});

test('HTTP commands keep working while another project verifies', async t => {
  const ctx = await fixture(t);
  const project = join(ctx.root, 'http-project');
  const timeline = join(ctx.root, 'http.timeline');
  const roomId = ctx.store.rooms()[0].id;
  const integrationId = enqueue(ctx, roomId, project, 'http.txt', timeline, 1200);
  ctx.worker.tick();
  await waitIntegration(ctx, integrationId, ['testing'], 10000);
  const headers = {authorization: 'Bearer parallel-owner', 'room-protocol-version': '0.1'};
  const started = Date.now();
  const response = await ctx.app.inject({method: 'POST', url: '/api/commands', headers, payload: {version: '0.1', commandId: uid(), roomId, type: 'message.send', payload: {text: 'while verifying'}}});
  assert.equal(response.statusCode, 200);
  assert.ok(Date.now() - started < 1500, 'HTTP must not be blocked by the verifier');
  assert.equal(ctx.store.get<Integration>('integrations', integrationId)?.status, 'testing');
  await waitIntegration(ctx, integrationId, ['applied'], 20000);
});
