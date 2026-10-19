// Account-login host task smoke test: ask one managed host Agent (default
// Claude) to modify a file in an isolated fixture project and finish the task.
// This does not replace the sandbox acceptance; it verifies the account-login
// daily path for real file edits.
//
//   npm run test:host-task -- --allow-paid
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../apps/server/src/app.ts';
import { agentSchema, type AgentDescriptor, type Task } from '../packages/protocol/src/index.ts';
import { now, uid } from '../apps/server/src/store.ts';

if (!process.argv.includes('--allow-paid')) {
  console.error('用法：npm run test:host-task -- --allow-paid（一次真实模型轮次，会产生费用）');
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
const sourceClaude = configured.find(agent => agent.provider === 'claude' && agent.enabled);
if (!sourceClaude) throw new Error('没有已启用的 Claude 成员');
if (!process.env.DEEPSEEK_API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY（Claude 兼容端点需要）');
const claude: AgentDescriptor = agentSchema.parse({...sourceClaude, id: 'smoke-claude-task', name: 'Claude 任务冒烟', connectionMode: 'managed', executionMode: 'host', endpoint: sourceClaude.endpoint || 'https://api.deepseek.com/anthropic', credentialEnv: 'DEEPSEEK_API_KEY'});

const parent = join(project, '.state', 'host-task-smoke');
mkdirSync(parent, {recursive: true});
const runDir = mkdtempSync(join(parent, 'run-'));
const root = join(runDir, 'state');
const fixture = join(runDir, 'project');
mkdirSync(fixture, {recursive: true});
writeFileSync(join(fixture, 'answer.txt'), 'before\n');
writeFileSync(join(fixture, 'README.md'), '# host task fixture\n');
const report: {startedAt: string; finishedAt?: string; ok: boolean; error?: string; task?: Record<string, unknown>; run?: Record<string, unknown>; answer?: string; reportPath?: string} = {startedAt: now(), ok: false};
try {
  const {app, store, service, worker} = await createApp({root, startWorker: false});
  try {
    store.put('agents', claude);
    const roomId = service.execute({version: '0.1', commandId: uid('hosttask'), type: 'room.create', payload: {name: 'Host 任务冒烟', members: [claude.id]}}).result.roomId as string;
    worker.start();
    const title = '请直接把项目根目录 answer.txt 的内容修改为 HOST_TASK_OK（只改这一行），完成后调用 task_complete 结束任务。';
    const created = service.execute({version: '0.1', commandId: uid('hosttask'), roomId, type: 'task.create', payload: {title, agentId: claude.id, projectPath: fixture}}).result as {taskId: string};
    const deadline = Date.now() + 300_000;
    let task: Task | undefined;
    while (Date.now() < deadline) {
      const tasks = store.list<Task>('tasks', roomId);
      task = tasks.find(item => item.id === created.taskId);
      const run = store.list<any>('runs', roomId).find(item => item.taskId === created.taskId);
      if (run?.status === 'waiting_input') throw new Error('Agent 请求人工输入，自动场景停止');
      if (task && ['completed', 'failed', 'canceled', 'interrupted'].includes(task.status)) break;
      if (run && ['failed', 'canceled', 'interrupted'].includes(run.status)) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 500));
    }
    const run = store.list<any>('runs', roomId).find(item => item.taskId === created.taskId);
    report.task = task ? {id: task.id, status: task.status, title: task.title} : {missing: true};
    report.run = run ? {status: run.status, error: run.error ?? null, host: !run.sandbox, nativeSessionId: run.nativeSessionId ? run.nativeSessionId.slice(0, 8) : null} : {missing: true};
    report.answer = readFileSync(join(fixture, 'answer.txt'), 'utf8').trim();
    writeFileSync(join(runDir, 'task.json'), JSON.stringify({task, run}, null, 2));
    if (!task || task.status !== 'completed') throw new Error(`任务未完成：${task?.status ?? 'missing'}`);
    if (report.answer !== 'HOST_TASK_OK') throw new Error(`answer.txt 未按预期修改：${report.answer}`);
    report.ok = true;
    console.log('host-task: PASS');
  } finally { await app.close(); }
} catch (error) {
  report.error = (error as Error).message;
  console.error(`host-task: FAIL - ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  report.finishedAt = now();
  const reportPath = join(runDir, 'report.json');
  report.reportPath = reportPath;
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  writeFileSync(join(parent, 'latest.json'), JSON.stringify({run: runDir, report: reportPath, ok: report.ok, finishedAt: report.finishedAt}, null, 2));
  console.log(`host-task report: ${reportPath}`);
  try {
    const runs = readdirSync(parent).filter(name => name.startsWith('run-')).map(name => ({name, path: join(parent, name), mtime: statSync(join(parent, name)).mtimeMs}));
    for (const old of runs.sort((a, b) => b.mtime - a.mtime).slice(5)) { try { rmSync(old.path, {recursive: true, force: true}); } catch { /* best effort */ } }
  } catch { /* best effort */ }
}
