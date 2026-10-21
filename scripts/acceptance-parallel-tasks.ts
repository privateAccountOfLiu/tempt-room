import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store, uid, now } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';
import { CommandExecutor } from '../apps/server/src/command-executor.ts';
import { ImmutableBaselines } from '../apps/server/src/immutable-baselines.ts';
import { createControllableAdapter, type ProbeEntry } from '../tests/helpers/controllable-adapter.ts';
import type { Artifact, Integration, ProjectBinding, Run, Task } from '../packages/protocol/src/index.ts';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

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
  verifierHash?: string;
  tasks: Array<{taskId: string; agentId: string; workspace?: string; artifactId?: string; artifactHash?: string; acceptanceStatus?: string}>;
  integrations: Array<{artifactId: string; integrationId: string; status: string}>;
  finalFiles: Record<string, string>;
  timeline: Array<{runId: string; agentId: string; phase: string; atNs: string}>;
  checks: Array<{name: string; pass: boolean; detail?: string}>;
}

async function waitUntil(check: () => boolean, message: string, timeoutMs = 90000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(done => setTimeout(done, 25));
  }
  throw new Error(message);
}

/**
 * Deterministic M1 acceptance fixture.
 *
 * This is not a fake "materialize()" path: two queued tasks are dispatched by
 * the real Worker through one controllable adapter, both adapters must be
 * entered before either is released, each writes its own isolated workspace,
 * then owner verification and the real integration queue produce the final
 * combined project. --check performs no model requests.
 */
export async function runAcceptance(options: {root?: string} = {}): Promise<{report: AcceptanceReport; workRoot: string}> {
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z');
  const evidenceParent = resolve('.state/acceptance-parallel-tasks');
  mkdirSync(evidenceParent, {recursive: true});
  const workRoot = options.root ?? mkdtempSync(join(evidenceParent, `work-${stamp}-`));
  mkdirSync(workRoot, {recursive: true});
  const report: AcceptanceReport = {schemaVersion: 1, mode: 'check', modelRequests: 0, startedAt: now(), pass: false, tasks: [], integrations: [], finalFiles: {}, timeline: [], checks: []};
  const check = (name: string, pass: boolean, detail?: string) => report.checks.push({name, pass, ...(detail ? {detail} : {})});
  let store: Store | undefined, worker: Worker | undefined;
  try {
    const project = join(workRoot, 'parallel-project');
    mkdirSync(project, {recursive: true});
    writeFileSync(join(project, 'README.md'), '# Parallel acceptance\n');
    store = new Store(join(workRoot, 'room.sqlite'));
    const service = new RoomService(store), roomId = store.rooms()[0].id;
    const command = (type: string, payload: unknown) => service.execute({version: '0.1', commandId: uid(), roomId, type, payload});
    const {adapter, probe} = createControllableAdapter({outputs: context => [context.agent.id === 'demo-planner' ? 'planner.txt' : 'reviewer.txt']});
    worker = new Worker(store, service, workRoot, {adapter});
    command('settings.update', {...store.settings(), concurrency: 4, maxConcurrentRunsPerRoom: 4});
    const executor = new CommandExecutor(service, new ImmutableBaselines(workRoot));
    const bindingId = (await executor.execute({version: '0.1', commandId: uid(), roomId, type: 'project.bind', payload: {sourcePath: project}}, {id: 'owner', kind: 'human'})).result.bindingId as string;
    const binding = store.get<ProjectBinding>('project_bindings', bindingId)!;
    const verifierScript = 'process.exit(0)';
    const verifier = {id: 'deterministic-check', description: 'deterministic staging check', command: 'node -e', argv: ['node', '-e', verifierScript], verifierVersion: '1.0.0'};
    const verifierHash = sha(JSON.stringify({command: verifier.command, argv: verifier.argv}));
    report.project = project;
    report.binding = {id: binding.id, version: binding.version, manifestHash: binding.manifestHash};
    report.verifierHash = verifierHash;
    check('project-baseline-frozen', binding.manifestFileCount === 1 && /^[a-f0-9]{64}$/.test(binding.manifestHash));

    const contract = (objective: string, output: string) => ({
      objective,
      workspaceMode: 'isolated' as const,
      projectBinding: {id: binding.id, version: binding.version, baselineRef: binding.baseCommit ?? 'fixture', manifestHash: binding.manifestHash, allowedPaths: [output]},
      acceptance: [{...verifier, verifierHash}],
      expectedArtifacts: [{path: output}],
      dependencies: []
    });
    const plannerTaskId = command('task.create', {title: 'Parallel planner deliverable', agentId: 'demo-planner', projectBindingId: binding.id, bindingVersion: binding.version, contract: contract('planner deliverable', 'planner.txt')}).result.taskId as string;
    const reviewerTaskId = command('task.create', {title: 'Parallel reviewer deliverable', agentId: 'demo-reviewer', projectBindingId: binding.id, bindingVersion: binding.version, contract: contract('reviewer deliverable', 'reviewer.txt')}).result.taskId as string;
    const plannerTask = store.get<Task>('tasks', plannerTaskId)!, reviewerTask = store.get<Task>('tasks', reviewerTaskId)!;
    check('strict-tasks-created', plannerTask.strict === true && reviewerTask.strict === true && plannerTask.acceptanceStatus === 'pending' && reviewerTask.acceptanceStatus === 'pending');

    worker.tick();
    let entered: ProbeEntry[];
    try {
      entered = await probe.waitForEntered(2, 15000);
    } catch (error) {
      check('parallel-barrier-entered', false, (error as Error).message);
      throw error;
    }
    check('parallel-barrier-entered', entered.length === 2 && new Set(entered.map(entry => entry.runId)).size === 2);
    const workspaces = entered.map(entry => entry.workspace);
    check('independent-workspaces', new Set(workspaces).size === 2 && workspaces.every(existsSync) && entered.every(entry => entry.baselineHash === binding.manifestHash));
    check('source-untouched-during-execution', readFileSync(join(project, 'README.md'), 'utf8') === '# Parallel acceptance\n' && !['planner.txt', 'reviewer.txt'].some(file => existsSync(join(project, file))));
    check('no-premature-completion', store.list<Task>('tasks', roomId).every(task => task.status !== 'completed') && store.list<Artifact>('artifacts', roomId).length === 0);

    probe.releaseAll();
    await waitUntil(() => {
      const runs = store!.list<Run>('runs', roomId);
      return runs.length === 2 && runs.every(run => run.status === 'completed');
    }, 'both Worker runs completed');
    await waitUntil(() => store!.list<Artifact>('artifacts', roomId).filter(artifact => artifact.kind === 'patch').length === 2, 'both patches published');
    const planner = store.get<Task>('tasks', plannerTaskId)!, reviewer = store.get<Task>('tasks', reviewerTaskId)!;
    check('execution-completed-not-accepted', planner.status === 'completed' && reviewer.status === 'completed' && planner.acceptanceStatus === 'pending' && reviewer.acceptanceStatus === 'pending');

    const artifacts = store.list<Artifact>('artifacts', roomId).filter(artifact => artifact.kind === 'patch');
    const artifactHash = (artifact: Artifact) => sha(readFileSync(join(workRoot, 'artifacts', artifact.id)));
    const taskArtifacts = [plannerTaskId, reviewerTaskId].map(taskId => ({taskId, artifact: artifacts.find(artifact => artifact.taskId === taskId)!}));
    for (const {taskId, artifact} of taskArtifacts) {
      const task = store.get<Task>('tasks', taskId)!;
      command('task.verification.record', {
        taskId,
        taskVersion: task.version,
        outcome: 'accepted',
        verificationId: `verification_${taskId}_owner`,
        artifactIds: [artifact.id],
        artifactHashes: {[artifact.id]: artifactHash(artifact)},
        commandRef: `owner check artifact bytes ${artifact.id}`,
        exitCode: 0,
        outputHash: sha(artifactHash(artifact)),
        reason: 'owner verified the actual patch bytes produced in the isolated workspace'
      });
    }
    const acceptedPlanner = store.get<Task>('tasks', plannerTaskId)!, acceptedReviewer = store.get<Task>('tasks', reviewerTaskId)!;
    check('owner-accepted-artifacts', acceptedPlanner.acceptanceStatus === 'accepted' && acceptedReviewer.acceptanceStatus === 'accepted');

    for (const {artifact} of taskArtifacts) {
      const integration = command('artifact.integrate', {artifactId: artifact.id});
      report.integrations.push({artifactId: artifact.id, integrationId: integration.result.integrationId as string, status: integration.result.status as string});
    }
    await waitUntil(() => {
      worker!.tick();
      return report.integrations.every(item => store!.get<Integration>('integrations', item.integrationId)?.status === 'applied');
    }, 'both integrations applied');
    for (const item of report.integrations) item.status = store.get<Integration>('integrations', item.integrationId)!.status;
    check('integrations-applied', report.integrations.every(item => item.status === 'applied'));
    const finalPlanner = readFileSync(join(project, 'planner.txt'), 'utf8'), finalReviewer = readFileSync(join(project, 'reviewer.txt'), 'utf8'), readme = readFileSync(join(project, 'README.md'), 'utf8');
    report.finalFiles = {'planner.txt': finalPlanner, 'reviewer.txt': finalReviewer, 'README.md': readme};
    check('combined-result-usable', finalPlanner.includes('completed planner.txt') && finalReviewer.includes('completed reviewer.txt') && readme === '# Parallel acceptance\n');
    report.tasks = [
      {taskId: plannerTaskId, agentId: 'demo-planner', workspace: entered.find(entry => entry.agentId === 'demo-planner')?.workspace, artifactId: taskArtifacts[0].artifact.id, artifactHash: artifactHash(taskArtifacts[0].artifact), acceptanceStatus: acceptedPlanner.acceptanceStatus},
      {taskId: reviewerTaskId, agentId: 'demo-reviewer', workspace: entered.find(entry => entry.agentId === 'demo-reviewer')?.workspace, artifactId: taskArtifacts[1].artifact.id, artifactHash: artifactHash(taskArtifacts[1].artifact), acceptanceStatus: acceptedReviewer.acceptanceStatus}
    ];
    report.timeline = probe.timeline();
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
  if (argv.includes('--real')) throw new Error('真实模型模式未启用：本脚本的 --check 不启动模型，任何真实成本/授权需沿 E02 显式批准');
  const {report, workRoot} = await runAcceptance();
  console.log(JSON.stringify({pass: report.pass, modelRequests: report.modelRequests, checks: report.checks, project: report.project, workRoot, integrations: report.integrations, timeline: report.timeline}, null, 2));
  return report.pass ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(code => process.exit(code)).catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
