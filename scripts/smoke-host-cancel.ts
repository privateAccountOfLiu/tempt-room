// Account-login host cancellation smoke test: hand a long-running command to a
// managed host Agent, cancel the run while it is running, and verify the run
// reaches a terminal canceled state. Does not replace the sandbox acceptance.
//
//   npm run test:host-cancel -- --allow-paid
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../apps/server/src/app.ts';
import { agentSchema, type AgentDescriptor, type Task } from '../packages/protocol/src/index.ts';
import { now, uid } from '../apps/server/src/store.ts';

if (!process.argv.includes('--allow-paid')) {
  console.error('用法：npm run test:host-cancel -- --allow-paid（一次真实模型轮次，会产生费用）');
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
const claude: AgentDescriptor = agentSchema.parse({...sourceClaude, id: 'smoke-claude-cancel', name: 'Claude 取消冒烟', connectionMode: 'managed', executionMode: 'host', endpoint: sourceClaude.endpoint || 'https://api.deepseek.com/anthropic', credentialEnv: 'DEEPSEEK_API_KEY'});

const parent = join(project, '.state', 'host-cancel-smoke');
mkdirSync(parent, {recursive: true});
const runDir = mkdtempSync(join(parent, 'run-'));
const root = join(runDir, 'state');
const fixture = join(runDir, 'project');
mkdirSync(fixture, {recursive: true});
writeFileSync(join(fixture, 'package.json'), JSON.stringify({name: 'host-cancel-fixture', version: '1.0.0'}, null, 2) + '\n');
const report: {startedAt: string; finishedAt?: string; ok: boolean; error?: string; task?: Record<string, unknown>; run?: Record<string, unknown>; canceledAfterMs?: number; reportPath?: string} = {startedAt: now(), ok: false};
try {
  const {app, store, service, worker} = await createApp({root, startWorker: false});
  try {
    store.put('agents', claude);
    const roomId = service.execute({version: '0.1', commandId: uid('hostcancel'), type: 'room.create', payload: {name: 'Host 取消冒烟', members: [claude.id]}}).result.roomId as string;
    worker.start();
    const title = '请运行命令 node -e "setTimeout(()=>{}, 60000)" 并等待它结束；不要完成任务，也不要修改任何文件。';
    const created = service.execute({version: '0.1', commandId: uid('hostcancel'), roomId, type: 'task.create', payload: {title, agentId: claude.id, projectPath: fixture}}).result as {taskId: string};
    let run: any;
    const startDeadline = Date.now() + 120_000;
    while (Date.now() < startDeadline) {
      run = store.list<any>('runs', roomId).find(item => item.taskId === created.taskId);
      if (run?.status === 'running' || ['failed', 'canceled', 'interrupted', 'completed'].includes(run?.status)) break;
      if (run?.status === 'waiting_input') throw new Error('Agent 请求人工输入，自动场景停止');
      await new Promise(resolveWait => setTimeout(resolveWait, 300));
    }
    if (!run) throw new Error('没有创建运行');
    if (run.status !== 'running') throw new Error(`运行未进入 running 状态：${run.status}${run.error ? ' ' + run.error : ''}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 6000));
    const cancelStart = Date.now();
    service.execute({version: '0.1', commandId: uid('hostcancel'), roomId, type: 'run.cancel', payload: {runId: run.id}});
    const cancelDeadline = Date.now() + 60_000;
    while (Date.now() < cancelDeadline) {
      run = store.get<any>('runs', run.id);
      if (['completed', 'failed', 'canceled', 'interrupted', 'unknown'].includes(run.status)) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 250));
    }
    const task = store.list<Task>('tasks', roomId).find(item => item.id === created.taskId);
    report.canceledAfterMs = Date.now() - cancelStart;
    report.task = task ? {id: task.id, status: task.status} : {missing: true};
    report.run = {status: run.status, error: run.error ?? null, host: !run.sandbox};
    writeFileSync(join(runDir, 'task.json'), JSON.stringify({task, run}, null, 2));
    if (run.status !== 'canceled') throw new Error(`取消后运行状态应为 canceled，实际 ${run.status}${run.error ? ' ' + run.error : ''}`);
    report.ok = true;
    console.log('host-cancel: PASS');
  } finally { await app.close(); }
} catch (error) {
  report.error = (error as Error).message;
  console.error(`host-cancel: FAIL - ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  report.finishedAt = now();
  const reportPath = join(runDir, 'report.json');
  report.reportPath = reportPath;
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  writeFileSync(join(parent, 'latest.json'), JSON.stringify({run: runDir, report: reportPath, ok: report.ok, finishedAt: report.finishedAt}, null, 2));
  console.log(`host-cancel report: ${reportPath}`);
  try {
    const runs = readdirSync(parent).filter(name => name.startsWith('run-')).map(name => ({name, path: join(parent, name), mtime: statSync(join(parent, name)).mtimeMs}));
    for (const old of runs.sort((a, b) => b.mtime - a.mtime).slice(5)) { try { rmSync(old.path, {recursive: true, force: true}); } catch { /* best effort */ } }
  } catch { /* best effort */ }
}
