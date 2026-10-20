import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store, uid, now } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';
import type { Artifact, Integration, ProjectBinding, Run, Task } from '../packages/protocol/src/index.ts';

const HASH = 'a'.repeat(64);

export interface AcceptanceReport {
  schemaVersion: 1;
  mode: 'check';
  modelRequests: 0;
  startedAt: string;
  finishedAt?: string;
  pass: boolean;
  error?: string;
  project?: string;
  binding?: {id: string; version: number; manifestHash: string};
  tasks: Array<{taskId: string; agentId: string; workspace?: string; artifactId?: string; artifactHash?: string; acceptanceStatus?: string}>;
  integrations: Array<{artifactId: string; integrationId: string; status: string}>;
  finalFiles: Record<string, string>;
  checks: Array<{name: string; pass: boolean; detail?: string}>;
}

/**
 * Deterministic M1 acceptance fixture. --check runs two different agents in
 * independent workspaces, records reviewable patches, accepts both task
 * results, then applies them through the durable integration queue.
 */
export async function runAcceptance(options: {root?: string} = {}): Promise<{report: AcceptanceReport; workRoot: string}> {
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z');
  const evidenceParent = resolve('.state/acceptance-parallel-tasks');
  mkdirSync(evidenceParent, {recursive: true});
  const workRoot = options.root ?? mkdtempSync(join(evidenceParent, `work-${stamp}-`));
  mkdirSync(workRoot, {recursive: true});
  const report: AcceptanceReport = {schemaVersion: 1, mode: 'check', modelRequests: 0, startedAt: now(), pass: false, tasks: [], integrations: [], finalFiles: {}, checks: []};
  const check = (name: string, pass: boolean, detail?: string) => report.checks.push({name, pass, ...(detail ? {detail} : {})});
  let store: Store | undefined, worker: Worker | undefined;
  try {
    const project = join(workRoot, 'parallel-project');
    mkdirSync(project, {recursive: true});
    writeFileSync(join(project, 'README.md'), '# Parallel acceptance\n');
    store = new Store(join(workRoot, 'room.sqlite'));
    const service = new RoomService(store), roomId = store.rooms()[0].id;
    const command = (type: string, payload: unknown) => service.execute({version: '0.1', commandId: uid(), roomId, type, payload});
    worker = new Worker(store, service, workRoot, {adapter: async function* () { yield {type: 'text', text: 'fixture'}; }});
    const bindingId = command('project.bind', {sourcePath: project}).result.bindingId as string;
    const binding = store.get<ProjectBinding>('project_bindings', bindingId)!;
    report.project = project;
    report.binding = {id: binding.id, version: binding.version, manifestHash: binding.manifestHash};
    check('project-baseline-frozen', binding.manifestFileCount === 1 && /^[a-f0-9]{64}$/.test(binding.manifestHash));

    const contract = (objective: string, output: string) => ({
      objective,
      projectBinding: {id: binding.id, version: binding.version, baselineRef: binding.baseCommit ?? 'fixture', manifestHash: binding.manifestHash, allowedPaths: [output]},
      acceptance: [{id: 'staging-check', description: 'staging fixture exits successfully', command: 'node -e "process.exit(0)"', verifierVersion: '1.0.0', verifierHash: HASH}],
      expectedArtifacts: [{path: output}], dependencies: []
    });
    const plannerTaskId = command('task.create', {title: 'Parallel planner deliverable', agentId: 'demo-planner', projectBindingId: binding.id, bindingVersion: binding.version, contract: contract('planner deliverable', 'planner.txt')}).result.taskId as string;
    const reviewerTaskId = command('task.create', {title: 'Parallel reviewer deliverable', agentId: 'demo-reviewer', projectBindingId: binding.id, bindingVersion: binding.version, contract: contract('reviewer deliverable', 'reviewer.txt')}).result.taskId as string;
    const plannerTask = store.get<Task>('tasks', plannerTaskId)!, reviewerTask = store.get<Task>('tasks', reviewerTaskId)!;
    check('strict-tasks-created', plannerTask.strict === true && reviewerTask.strict === true && plannerTask.acceptanceStatus === 'pending' && reviewerTask.acceptanceStatus === 'pending');

    const materialize = (task: Task, fileName: string): {artifact: Artifact; run: Run; workspace: string} => {
      const run = store!.list<Run>('runs', roomId).find(item => item.taskId === task.id)!;
      run.status = 'running'; store!.event(roomId, 'run.started', {id: 'system', kind: 'system'}, {run});
      const snapshot = worker!.workspaces.snapshot(project, run.id);
      writeFileSync(join(snapshot.workspace, fileName), `${task.agentId} completed ${fileName}\n`);
      const changes = worker!.workspaces.changes(run.id);
      const artifact = worker!.publishArtifact(run, `${fileName}.patch`, changes.patch, 'text/x-diff', 'patch');
      writeFileSync(join(workRoot, 'artifacts', artifact.id + '.changes.json'), JSON.stringify(changes));
      worker!.finish(run, 'completed');
      return {artifact, run: store!.get<Run>('runs', run.id)!, workspace: snapshot.workspace};
    };
    const planner = materialize(plannerTask, 'planner.txt'), reviewer = materialize(reviewerTask, 'reviewer.txt');
    check('independent-workspaces', planner.workspace !== reviewer.workspace && [planner.workspace, reviewer.workspace].every(existsSync));
    check('execution-completed-not-accepted', planner.run.status === 'completed' && store.get<Task>('tasks', plannerTaskId)!.acceptanceStatus === 'pending');
    const accept = (taskId: string, artifactId: string) => command('task.verification.record', {taskId, taskVersion: 1, outcome: 'accepted', verificationId: `verification_${taskId}_fixture`, artifactIds: [artifactId], artifactHashes: {}, commandRef: 'staging fixture', exitCode: 0, outputHash: HASH, reason: 'deterministic M1 acceptance fixture'});
    accept(plannerTaskId, planner.artifact.id); accept(reviewerTaskId, reviewer.artifact.id);
    check('owner-accepted-artifacts', store.get<Task>('tasks', plannerTaskId)!.acceptanceStatus === 'accepted' && store.get<Task>('tasks', reviewerTaskId)!.acceptanceStatus === 'accepted');

    for (const artifact of [planner.artifact, reviewer.artifact]) {
      const integration = command('artifact.integrate', {artifactId: artifact.id});
      report.integrations.push({artifactId: artifact.id, integrationId: integration.result.integrationId as string, status: integration.result.status as string});
    }
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && report.integrations.some(item => store!.get<Integration>('integrations', item.integrationId)?.status !== 'applied')) worker.tick();
    for (const item of report.integrations) item.status = store.get<Integration>('integrations', item.integrationId)!.status;
    const finalPlanner = readFileSync(join(project, 'planner.txt'), 'utf8'), finalReviewer = readFileSync(join(project, 'reviewer.txt'), 'utf8'), readme = readFileSync(join(project, 'README.md'), 'utf8');
    report.finalFiles = {'planner.txt': finalPlanner, 'reviewer.txt': finalReviewer, 'README.md': readme};
    check('integrations-applied', report.integrations.every(item => item.status === 'applied'));
    check('combined-result-usable', finalPlanner.includes('completed planner.txt') && finalReviewer.includes('completed reviewer.txt') && readme === '# Parallel acceptance\n');
    report.tasks = [
      {taskId: plannerTaskId, agentId: 'demo-planner', workspace: planner.workspace, artifactId: planner.artifact.id, acceptanceStatus: 'accepted'},
      {taskId: reviewerTaskId, agentId: 'demo-reviewer', workspace: reviewer.workspace, artifactId: reviewer.artifact.id, acceptanceStatus: 'accepted'}
    ];
    report.pass = report.checks.every(item => item.pass);
  } catch (error) {
    report.error = (error as Error).message;
    report.checks.push({name: 'uncaught', pass: false, detail: report.error});
    report.pass = false;
  } finally {
    if (worker) await worker.close().catch(() => {});
    if (store) store.close();
    report.finishedAt = now();
    const evidence = resolve('.state/acceptance-parallel-tasks', `run-${stamp}-${uid('x').slice(-8)}`);
    mkdirSync(evidence, {recursive: true});
    writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  }
  return {report, workRoot};
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--real')) throw new Error('真实模型模式未启用：本脚本的 --check 不启动模型，任何真实成本/授权需沿用 E02 显式批准');
  const {report, workRoot} = await runAcceptance();
  console.log(JSON.stringify({pass: report.pass, modelRequests: report.modelRequests, checks: report.checks, project: report.project, workRoot, integrations: report.integrations}, null, 2));
  return report.pass ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(code => process.exit(code)).catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
