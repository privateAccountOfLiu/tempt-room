// Sandbox real-agent artifact smoke test: Claude runs in the AppContainer
// sandbox on a git fixture project, edits a file, publishes a diff artifact, and
// the owner applies that artifact back to the real project. Verifies the sandbox
// path end-to-end without Codex API keys.
//
//   $env:DEEPSEEK_API_KEY = '<Claude compatible endpoint token>'
//   npm run test:sandbox-artifact -- --allow-paid
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../apps/server/src/app.ts';
import { agentSchema, type AgentDescriptor, type Artifact, type Task } from '../packages/protocol/src/index.ts';
import { now, uid } from '../apps/server/src/store.ts';

if (!process.argv.includes('--allow-paid')) {
  console.error('用法：npm run test:sandbox-artifact -- --allow-paid（一次真实沙箱模型轮次，会产生费用；需 DEEPSEEK_API_KEY）');
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
const claude: AgentDescriptor = agentSchema.parse({...sourceClaude, id: 'smoke-claude-sandbox', name: 'Claude 沙箱成果冒烟', connectionMode: 'managed', executionMode: 'sandbox', endpoint: sourceClaude.endpoint || 'https://api.deepseek.com/anthropic', credentialEnv: 'DEEPSEEK_API_KEY'});

const parent = join(project, '.state', 'sandbox-artifact-smoke');
mkdirSync(parent, {recursive: true});
const runDir = mkdtempSync(join(parent, 'run-'));
const root = join(runDir, 'state');
const fixture = join(runDir, 'project');
mkdirSync(fixture, {recursive: true});
writeFileSync(join(fixture, 'answer.txt'), 'before\n');
const git = (args: string[]) => {
  const result = spawnSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@local', '-c', 'commit.gpgsign=false', ...args], {cwd: fixture, encoding: 'utf8', windowsHide: true, timeout: 60_000});
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr ?? '').slice(-500)}`);
};
try {
  git(['init', '-q']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'initial']);
} catch (error) {
  console.error(`初始化 fixture Git 仓库失败：${(error as Error).message}`);
  process.exit(1);
}
const report: {startedAt: string; finishedAt?: string; ok: boolean; error?: string; task?: Record<string, unknown>; run?: Record<string, unknown>; artifact?: Record<string, unknown>; answer?: string; reportPath?: string} = {startedAt: now(), ok: false};
try {
  const {app, store, service, worker} = await createApp({root, startWorker: false});
  try {
    store.put('agents', claude);
    const roomId = service.execute({version: '0.1', commandId: uid('sandbox'), type: 'room.create', payload: {name: '沙箱成果冒烟', members: [claude.id]}}).result.roomId as string;
    worker.start();
    const title = '请把项目根目录 answer.txt 的内容精确修改为 SANDBOX_ARTIFACT_OK，然后调用 task_complete 完成任务。';
    const created = service.execute({version: '0.1', commandId: uid('sandbox'), roomId, type: 'task.create', payload: {title, agentId: claude.id, projectPath: fixture}}).result as {taskId: string};
    const deadline = Date.now() + 300_000;
    let task: Task | undefined;
    while (Date.now() < deadline) {
      task = store.list<Task>('tasks', roomId).find(item => item.id === created.taskId);
      const run = store.list<any>('runs', roomId).find(item => item.taskId === created.taskId);
      if (run?.status === 'waiting_input') throw new Error('Agent 请求人工输入，自动场景停止');
      if (task && ['completed', 'failed', 'canceled', 'interrupted'].includes(task.status)) break;
      if (run && ['failed', 'canceled', 'interrupted'].includes(run.status)) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 500));
    }
    const run = store.list<any>('runs', roomId).find(item => item.taskId === created.taskId);
    const artifacts = store.list<Artifact>('artifacts', roomId).filter(artifact => artifact.runId === run?.id);
    report.task = task ? {id: task.id, status: task.status} : {missing: true};
    report.run = run ? {id: run.id, status: run.status, error: run.error ?? null, sandboxVerified: Boolean(run.sandbox?.verifiedAt), nativeSessionId: run.nativeSessionId ? run.nativeSessionId.slice(0, 8) : null} : {missing: true};
    report.artifact = artifacts[0] ? {id: artifacts[0].id, kind: artifacts[0].kind, name: artifacts[0].name, size: artifacts[0].size} : {missing: true};
    writeFileSync(join(runDir, 'task.json'), JSON.stringify({task, run, artifacts}, null, 2));
    if (!task || task.status !== 'completed') throw new Error(`任务未完成：${task?.status ?? 'missing'}`);
    if (!run?.sandbox?.verifiedAt) throw new Error('缺少已验证的 AppContainer 沙箱记录');
    const patch = artifacts.find(artifact => artifact.kind === 'patch');
    if (!patch) throw new Error('任务完成后没有生成可应用的差异交付物');
    service.execute({version: '0.1', commandId: uid('sandbox'), roomId, type: 'artifact.apply', payload: {artifactId: patch.id}});
    report.answer = readFileSync(join(fixture, 'answer.txt'), 'utf8').trim();
    const applied = store.get<Artifact>('artifacts', patch.id);
    if (!applied?.applied) throw new Error('交付物未被标记为已应用');
    if (report.answer !== 'SANDBOX_ARTIFACT_OK') throw new Error(`应用后 answer.txt 不符合预期：${report.answer}`);
    report.ok = true;
    console.log('sandbox-artifact: PASS');
  } finally { await app.close(); }
} catch (error) {
  report.error = (error as Error).message;
  console.error(`sandbox-artifact: FAIL - ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  report.finishedAt = now();
  const reportPath = join(runDir, 'report.json');
  report.reportPath = reportPath;
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  writeFileSync(join(parent, 'latest.json'), JSON.stringify({run: runDir, report: reportPath, ok: report.ok, finishedAt: report.finishedAt}, null, 2));
  console.log(`sandbox-artifact report: ${reportPath}`);
  try {
    const runs = readdirSync(parent).filter(name => name.startsWith('run-')).map(name => ({name, path: join(parent, name), mtime: statSync(join(parent, name)).mtimeMs}));
    for (const old of runs.sort((a, b) => b.mtime - a.mtime).slice(5)) { try { rmSync(old.path, {recursive: true, force: true}); } catch { /* best effort */ } }
  } catch { /* best effort */ }
}
