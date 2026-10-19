// Two-Agent sandbox handoff smoke test: Claude and DeepSeek both run as managed
// AppContainer Agents on a git fixture project, with the task handed from Claude
// (v1) to DeepSeek (v2). Verifies real sandbox multi-Agent collaboration without
// a Codex API key.
//
//   $env:DEEPSEEK_API_KEY = '<Claude endpoint + DeepSeek key>'
//   npm run test:sandbox-handoff -- --allow-paid
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../apps/server/src/app.ts';
import { agentSchema, type AgentDescriptor, type Artifact, type Run, type Task } from '../packages/protocol/src/index.ts';
import { now, uid } from '../apps/server/src/store.ts';

if (!process.argv.includes('--allow-paid')) {
  console.error('用法：npm run test:sandbox-handoff -- --allow-paid（两次真实沙箱模型轮次，会产生费用；需 DEEPSEEK_API_KEY）');
  process.exit(2);
}
const project = resolve('.');
const source = resolve(process.env.ROOM_STATE_DIR ?? '.state');
if (existsSync(join(source, 'server.lock'))) throw new Error('请先关闭使用该数据目录的 Tempt Room 服务');
const dbFile = join(source, 'room.sqlite');
if (!existsSync(dbFile)) throw new Error('没有找到配置数据库');
const database = new DatabaseSync(dbFile, { readOnly: true });
const configured = database.prepare('SELECT body FROM agents').all().map(row => agentSchema.parse(JSON.parse((row as any).body)) as AgentDescriptor);
database.close();
if (!process.env.DEEPSEEK_API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY');
const findAgent = (provider: 'claude' | 'deepseek') => {
  const raw = configured.find(agent => agent.provider === provider && agent.enabled);
  if (!raw) throw new Error(`没有已启用的 ${provider} 成员`);
  return agentSchema.parse({...raw, id: `sandbox-${provider}-handoff`, name: `${provider} 沙箱接力`, connectionMode: 'managed', executionMode: 'sandbox',
    endpoint: provider === 'claude' ? raw.endpoint || 'https://api.deepseek.com/anthropic' : raw.endpoint,
    credentialEnv: 'DEEPSEEK_API_KEY'});
};
const claude = findAgent('claude'), deepseek = findAgent('deepseek');

const parent = join(project, '.state', 'sandbox-handoff-smoke');
mkdirSync(parent, { recursive: true });
const runDir = mkdtempSync(join(parent, 'run-'));
const root = join(runDir, 'state');
const fixture = join(runDir, 'project');
mkdirSync(fixture, { recursive: true });
writeFileSync(join(fixture, 'answer.txt'), 'before\n');
const git = (args: string[]) => {
  const result = spawnSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@local', '-c', 'commit.gpgsign=false', ...args], { cwd: fixture, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr ?? '').slice(-500)}`);
};
git(['init', '-q']); git(['add', '.']); git(['commit', '-q', '-m', 'initial']);
const report: {startedAt: string; finishedAt?: string; ok: boolean; error?: string; task?: Record<string, unknown>; runs?: Array<Record<string, unknown>>; answer?: string; reportPath?: string} = {startedAt: now(), ok: false};
try {
  const { app, store, service, worker } = await createApp({ root, startWorker: false });
  try {
    store.put('agents', claude); store.put('agents', deepseek);
    const roomId = service.execute({version: '0.1', commandId: uid('sbhandoff'), type: 'room.create', payload: {name: '沙箱接力冒烟', members: [claude.id, deepseek.id]}}).result.roomId as string;
    worker.start();
    const title = '请把项目根目录 answer.txt 的内容精确修改为 SANDBOX_HANDOFF_OK，然后调用 task_complete 完成任务。';
    const created = service.execute({version: '0.1', commandId: uid('sbhandoff'), roomId, type: 'task.create', payload: {title, agentId: claude.id, projectPath: fixture}}).result as {taskId: string};
    const waitFor = async (version: number, timeoutMs = 300_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const task = store.list<Task>('tasks', roomId).find(item => item.id === created.taskId);
        const run = store.list<Run>('runs', roomId).find(item => item.taskId === created.taskId && item.taskVersion === version);
        if (run?.status === 'waiting_input') throw new Error('Agent 请求人工输入，自动场景停止');
        if (task && ['completed', 'failed', 'canceled', 'interrupted'].includes(task.status)) return {task, run};
        if (run && ['failed', 'canceled', 'interrupted'].includes(run.status)) return {task, run};
        await new Promise(resolveWait => setTimeout(resolveWait, 500));
      }
      throw new Error(`等待任务 v${version} 超时`);
    };
    const first = await waitFor(1);
    if (!first.task || first.task.status !== 'completed') throw new Error(`第一棒任务未完成：${first.task?.status ?? 'missing'}`);
    const firstPatch = store.list<Artifact>('artifacts', roomId).find(artifact => artifact.runId === first.run?.id && artifact.kind === 'patch');
    if (!firstPatch) throw new Error('第一棒没有生成可应用的差异交付物');
    service.execute({version: '0.1', commandId: uid('sbhandoff'), roomId, type: 'artifact.apply', payload: {artifactId: firstPatch.id}});
    if (readFileSync(join(fixture, 'answer.txt'), 'utf8').trim() !== 'SANDBOX_HANDOFF_OK') throw new Error('第一棒成果应用到原项目后内容不符合预期');
    service.execute({version: '0.1', commandId: uid('sbhandoff'), roomId, type: 'task.handoff', payload: {taskId: created.taskId, agentId: deepseek.id, note: '复核 answer.txt 为 SANDBOX_HANDOFF_OK 并结束任务。'}});
    const second = await waitFor(2);
    const secondPatch = store.list<Artifact>('artifacts', roomId).find(artifact => artifact.runId === second.run?.id && artifact.kind === 'patch');
    if (secondPatch && !store.get<Artifact>('artifacts', secondPatch.id)?.applied) {
      service.execute({version: '0.1', commandId: uid('sbhandoff'), roomId, type: 'artifact.apply', payload: {artifactId: secondPatch.id}});
    }
    const task = store.get<Task>('tasks', created.taskId)!;
    const runs = store.list<Run>('runs', roomId).filter(item => item.taskId === created.taskId).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    report.task = {id: task.id, status: task.status, version: task.version, agentId: task.agentId};
    report.runs = runs.map(run => ({agent: run.agentId, version: run.taskVersion, status: run.status, sandboxVerified: Boolean(run.sandbox?.verifiedAt), error: run.error ?? null}));
    report.answer = readFileSync(join(fixture, 'answer.txt'), 'utf8').trim();
    writeFileSync(join(runDir, 'task.json'), JSON.stringify({task, runs}, null, 2));
    if (task.version !== 2 || task.agentId !== deepseek.id || task.status !== 'completed') throw new Error(`交接后任务状态不符合预期：${JSON.stringify(report.task)}`);
    if (runs.length < 2 || runs.some(run => !run.sandbox?.verifiedAt)) throw new Error('两位 Agent 的运行都应带已验证的 AppContainer 记录');
    if (report.answer !== 'SANDBOX_HANDOFF_OK') throw new Error(`answer.txt 不符合预期：${report.answer}`);
    report.ok = true;
    console.log('sandbox-handoff: PASS');
  } finally { await app.close(); }
} catch (error) {
  report.error = (error as Error).message;
  console.error(`sandbox-handoff: FAIL - ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  report.finishedAt = now();
  const reportPath = join(runDir, 'report.json');
  report.reportPath = reportPath;
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  writeFileSync(join(parent, 'latest.json'), JSON.stringify({ run: runDir, report: reportPath, ok: report.ok, finishedAt: report.finishedAt }, null, 2));
  console.log(`sandbox-handoff report: ${reportPath}`);
  try {
    const runs = readdirSync(parent).filter(name => name.startsWith('run-')).map(name => ({ name, path: join(parent, name), mtime: statSync(join(parent, name)).mtimeMs }));
    for (const old of runs.sort((a, b) => b.mtime - a.mtime).slice(5)) { try { rmSync(old.path, { recursive: true, force: true }); } catch { /* best effort */ } }
  } catch { /* best effort */ }
}
