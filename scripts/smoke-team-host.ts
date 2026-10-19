// Three-agent host-mode collaboration smoke test (account-login reality).
// Claude Code and Codex are normally used through their own account logins, not
// API keys. This script takes the configured Codex/Claude/DeepSeek members,
// runs them as managed host Agents (own login + full local permissions) in one
// isolated room and verifies each member actually answers one discussion turn.
//
//   npm run test:team-host -- --allow-paid
//
// Requirements: configured members in the source state, DEEPSEEK_API_KEY in the
// environment (Claude gateway + DeepSeek host), and ROOM_CODEX_PROXY when the
// local proxy is needed for Codex's ChatGPT login.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../apps/server/src/app.ts';
import { agentSchema, type AgentDescriptor, type Message, type Run } from '../packages/protocol/src/index.ts';
import { now, uid } from '../apps/server/src/store.ts';

if (!process.argv.includes('--allow-paid')) {
  console.error('用法：npm run test:team-host -- --allow-paid（三位成员各一次真实模型轮次，会消耗配额）');
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
const providers = ['codex', 'claude', 'deepseek'] as const;
const team = providers.map(provider => {
  const source = configured.find(agent => agent.provider === provider && agent.enabled);
  if (!source) throw new Error(`没有已启用的 ${provider} 成员`);
  return agentSchema.parse({...source, id: `smoke-${provider}`, name: `冒烟 ${provider}`, connectionMode: 'managed', executionMode: 'host',
    endpoint: provider === 'claude' ? source.endpoint || 'https://api.deepseek.com/anthropic' : source.endpoint,
    credentialEnv: provider === 'codex' ? '' : 'DEEPSEEK_API_KEY'});
});
if (!process.env.DEEPSEEK_API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY（Claude 兼容端点与 DeepSeek host 需要）');
const parent = join(project, '.state', 'team-smoke');
mkdirSync(parent, {recursive: true});
const runDir = mkdtempSync(join(parent, 'run-'));
const root = join(runDir, 'state');
const report: {startedAt: string; finishedAt?: string; ok: boolean; error?: string; roomId?: string; runs?: Array<Record<string, unknown>>; replies?: Array<{agent: string; text: string}>; reportPath?: string} = {startedAt: now(), ok: false};
try {
  const {app, store, service, worker} = await createApp({root, startWorker: false});
  try {
    for (const agent of team) store.put('agents', agent);
    const roomId = service.execute({version: '0.1', commandId: uid('team'), type: 'room.create', payload: {name: '三 Agent host 冒烟', members: team.map(agent => agent.id)}}).result.roomId as string;
    report.roomId = roomId;
    worker.start();
    service.execute({version: '0.1', commandId: uid('team'), roomId, type: 'message.send', payload: {text: '三位好：请各自用一句话说明你能在这个项目里承担的角色。只回复这一句话，不要调用工具，不要展开。', mentions: team.map(agent => agent.id)}});
    const deadline = Date.now() + 300_000;
    let runs: Run[] = [];
    while (Date.now() < deadline) {
      runs = store.list<Run>('runs', roomId).filter(run => run.agentId.startsWith('smoke-'));
      if (runs.length >= 3 && runs.every(run => ['completed', 'failed', 'canceled', 'interrupted', 'unknown', 'waiting_input'].includes(run.status))) break;
      if (runs.some(run => run.status === 'waiting_input')) throw new Error('有 Agent 请求人工输入，自动场景停止');
      await new Promise(resolveWait => setTimeout(resolveWait, 500));
    }
    const messages = store.list<Message>('messages', roomId);
    report.runs = runs.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).map(run => ({agent: run.agentId, status: run.status, error: run.error ?? null, host: !run.sandbox, nativeSessionId: run.nativeSessionId ? run.nativeSessionId.slice(0, 8) : null}));
    report.replies = runs.map(run => ({agent: run.agentId, text: String(messages.filter(message => message.runId === run.id).map(message => message.text).join(' ')).slice(0, 300)}));
    console.log('runs:', JSON.stringify(report.runs));
    for (const reply of report.replies) if (!reply.text.trim()) throw new Error(`${reply.agent} 没有回复`);
    if (runs.length !== 3) throw new Error(`预期 3 个运行，实际 ${runs.length}`);
    if (runs.some(run => run.status !== 'completed')) throw new Error('至少一个运行未完成');
    report.ok = true;
    console.log('team-host: PASS');
  } finally { await app.close(); }
} catch (error) {
  report.error = (error as Error).message;
  console.error(`team-host: FAIL - ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  report.finishedAt = now();
  const reportPath = join(runDir, 'report.json');
  report.reportPath = reportPath;
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  writeFileSync(join(parent, 'latest.json'), JSON.stringify({run: runDir, report: reportPath, ok: report.ok, finishedAt: report.finishedAt}, null, 2));
  console.log(`team-host report: ${reportPath}`);
  try {
    const runs = readdirSync(parent).filter(name => name.startsWith('run-')).map(name => ({name, path: join(parent, name), mtime: statSync(join(parent, name)).mtimeMs}));
    for (const old of runs.sort((a, b) => b.mtime - a.mtime).slice(5)) { try { rmSync(old.path, {recursive: true, force: true}); } catch { /* best effort */ } }
  } catch { /* best effort */ }
}
