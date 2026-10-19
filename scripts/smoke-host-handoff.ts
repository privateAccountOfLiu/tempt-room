// Account-login host task handoff smoke test: Claude completes the first pass,
// then the task is handed to DeepSeek which re-runs and completes it. Verifies
// real multi-agent task relay in the account-login daily path.
//
//   npm run test:host-handoff -- --allow-paid
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../apps/server/src/app.ts';
import { agentSchema, type AgentDescriptor, type Run, type Task } from '../packages/protocol/src/index.ts';
import { now, uid } from '../apps/server/src/store.ts';

if (!process.argv.includes('--allow-paid')) {
  console.error('用法：npm run test:host-handoff -- --allow-paid（两次真实模型轮次，会产生费用）');
  process.exit(2);
}
const project = resolve('.');
const source = resolve(process.env.ROOM_STATE_DIR ?? '.state');
if (existsSync(join(source, 'server.lock'))) throw new Error('请先关闭使用该数据目录的 Tempt Room 服务');
const dbFile = join(source, 'room.sqlite');
if (!existsSync(dbFile)) throw new Error('没有找到配置数据库');
const database = new DatabaseSync(dbFile, {readOnly: true});
const configured = database.prepare('SELECT body FROM agents').all().map(row => agentSchema.parse(JSON.parse((row as any).body)) as AgentDescriptor);
database.close();
const findAgent = (provider: 'claude' | 'deepseek') => {
  const source = configured.find(agent => agent.provider === provider && agent.enabled);
  if (!source) throw new Error(`没有已启用的 ${provider} 成员`);
  return agentSchema.parse({...source, id: `smoke-${provider}-handoff`, name: `${provider} 接力冒烟`, connectionMode: 'managed', executionMode: 'host',
    endpoint: provider === 'claude' ? source.endpoint || 'https://api.deepseek.com/anthropic' : source.endpoint,
    credentialEnv: provider === 'claude' ? 'DEEPSEEK_API_KEY' : source.credentialEnv || 'DEEPSEEK_API_KEY'});
};
const claude = findAgent('claude'), deepseek = findAgent('deepseek');
if (!process.env.DEEPSEEK_API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY（Claude 兼容端点与 DeepSeek host 需要）');

const parent = join(project, '.state', 'host-handoff-smoke');
mkdirSync(parent, {recursive: true});
const runDir = mkdtempSync(join(parent, 'run-'));
const root = join(runDir, 'state');
const fixture = join(runDir, 'project');
mkdirSync(fixture, {recursive: true});
writeFileSync(join(fixture, 'answer.txt'), 'before\n');
const report: {startedAt: string; finishedAt?: string; ok: boolean; error?: string; task?: Record<string, unknown>; runs?: Array<Record<string, unknown>>; answer?: string; reportPath?: string} = {startedAt: now(), ok: false};
const finished = (store: any, roomId: string, taskId: string, version: number) => {
  const tasks = store.list('tasks', roomId) as Task[];
  const runs = store.list('runs', roomId) as Run[];
  const task = tasks.find((item: Task) => item.id === taskId);
  const run = runs.find((item: Run) => item.taskId === taskId && item.taskVersion === version);
  return {task, run};
};
try {
  const {app, store, service, worker} = await createApp({root, startWorker: false});
  try {
    store.put('agents', claude); store.put('agents', deepseek);
    const roomId = service.execute({version: '0.1', commandId: uid('handoff'), type: 'room.create', payload: {name: 'Host 接力冒烟', members: [claude.id, deepseek.id]}}).result.roomId as string;
    worker.start();
    const title = '请把项目根目录 answer.txt 的内容精确修改为 HANDOFF_STEP1，然后调用 task_complete 完成任务。';
    const created = service.execute({version: '0.1', commandId: uid('handoff'), roomId, type: 'task.create', payload: {title, agentId: claude.id, projectPath: fixture}}).result as {taskId: string};
    const waitFor = async (version: number, timeoutMs = 300_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const {task, run} = finished(store, roomId, created.taskId, version);
        if (run?.status === 'waiting_input') throw new Error('Agent 请求人工输入，自动场景停止');
        if (task && ['completed', 'failed', 'canceled', 'interrupted'].includes(task.status)) return {task, run};
        if (run && ['failed', 'canceled', 'interrupted'].includes(run.status)) return {task, run};
        await new Promise(resolveWait => setTimeout(resolveWait, 500));
      }
      throw new Error(`等待任务 v${version} 超时`);
    };
    const first = await waitFor(1);
    if (!first.task || first.task.status !== 'completed') throw new Error(`第一棒任务未完成：${first.task?.status ?? 'missing'}`);
    if (readFileSync(join(fixture, 'answer.txt'), 'utf8').trim() !== 'HANDOFF_STEP1') throw new Error('第一棒未按要求修改 answer.txt');
    service.execute({version: '0.1', commandId: uid('handoff'), roomId, type: 'task.handoff', payload: {taskId: created.taskId, agentId: deepseek.id, note: '复核 answer.txt 为 HANDOFF_STEP1 并结束任务。'}});
    const second = await waitFor(2);
    const task = store.get<Task>('tasks', created.taskId)!;
    const runs = store.list<Run>('runs', roomId).filter(item => item.taskId === created.taskId).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    report.task = {id: task.id, status: task.status, version: task.version, agentId: task.agentId};
    report.runs = runs.map(run => ({agent: run.agentId, version: run.taskVersion, status: run.status, host: !run.sandbox, error: run.error ?? null}));
    report.answer = readFileSync(join(fixture, 'answer.txt'), 'utf8').trim();
    writeFileSync(join(runDir, 'task.json'), JSON.stringify({task, runs}, null, 2));
    if (task.version !== 2 || task.agentId !== deepseek.id || task.status !== 'completed') throw new Error(`交接后任务状态不符合预期：${JSON.stringify(report.task)}`);
    if (!runs.some(run => run.agentId === claude.id) || !runs.some(run => run.agentId === deepseek.id)) throw new Error('没有看到两位 Agent 的真实运行记录');
    if (report.answer !== 'HANDOFF_STEP1') throw new Error(`交接后 answer.txt 不符合预期：${report.answer}`);
    report.ok = true;
    console.log('host-handoff: PASS');
  } finally { await app.close(); }
} catch (error) {
  report.error = (error as Error).message;
  console.error(`host-handoff: FAIL - ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  report.finishedAt = now();
  const reportPath = join(runDir, 'report.json');
  report.reportPath = reportPath;
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  writeFileSync(join(parent, 'latest.json'), JSON.stringify({run: runDir, report: reportPath, ok: report.ok, finishedAt: report.finishedAt}, null, 2));
  console.log(`host-handoff report: ${reportPath}`);
  try {
    const runs = readdirSync(parent).filter(name => name.startsWith('run-')).map(name => ({name, path: join(parent, name), mtime: statSync(join(parent, name)).mtimeMs}));
    for (const old of runs.sort((a, b) => b.mtime - a.mtime).slice(5)) { try { rmSync(old.path, {recursive: true, force: true}); } catch { /* best effort */ } }
  } catch { /* best effort */ }
}
