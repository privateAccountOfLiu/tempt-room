// Claude Code configuration smoke test.
// Reads the Claude Agent configured in the main .state database, copies it into
// an isolated test room and exercises either the no-model sandbox/protocol
// precheck or one explicit paid model turn with room MCP tools.
//
//   npm run test:claude -- --check       # no model request
//   npm run test:claude -- --allow-paid  # one real model turn (costs quota)
//
// The configured endpoint/credentialEnv are reused; no secrets are printed.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../apps/server/src/app.ts';
import { probeAgentProtocol } from '../apps/server/src/adapters.ts';
import { agentSchema, type AgentDescriptor, type Run } from '../packages/protocol/src/index.ts';
import { now, OWNER, uid } from '../apps/server/src/store.ts';

const project = resolve('.');
const checkOnly = process.argv.includes('--check');
const allowPaid = process.argv.includes('--allow-paid');
if (!checkOnly && !allowPaid) {
  console.error('用法：npm run test:claude -- --check（不调用模型） 或 --allow-paid（一次真实模型轮次，会产生费用）');
  process.exit(2);
}
const source = resolve(process.env.ROOM_STATE_DIR ?? '.state');
if (existsSync(join(source, 'server.lock'))) throw new Error('请先关闭使用该数据目录的 Tempt Room 服务');
const dbFile = join(source, 'room.sqlite');
if (!existsSync(dbFile)) throw new Error('没有找到配置数据库：请先在应用中配置 Claude 成员');
const database = new DatabaseSync(dbFile, {readOnly: true});
const configured = database.prepare('SELECT body FROM agents').all().map(row => agentSchema.parse(JSON.parse((row as any).body)) as AgentDescriptor);
database.close();
const configuredClaude = configured.find(agent => agent.provider === 'claude' && agent.enabled);
if (!configuredClaude) throw new Error('没有已启用的 Claude 成员');
const endpoint = configuredClaude.endpoint || 'https://api.deepseek.com/anthropic';
const credentialEnv = configuredClaude.credentialEnv || 'DEEPSEEK_API_KEY';
if (!process.env[credentialEnv]) throw new Error(`启动终端缺少密钥环境变量 ${credentialEnv}`);
const claude: AgentDescriptor = agentSchema.parse({
  ...configuredClaude,
  id: 'claude-smoke',
  name: 'Claude 冒烟',
  connectionMode: 'managed',
  executionMode: 'sandbox',
  endpoint,
  credentialEnv
});

const parent = join(project, '.state', 'claude-smoke');
mkdirSync(parent, {recursive: true});
const runDir = mkdtempSync(join(parent, 'run-'));
const root = join(runDir, 'state');
const report: {startedAt: string; finishedAt?: string; mode: string; ok: boolean; error?: string; checks: Array<{name: string; ok: boolean; detail?: string}>; run?: Record<string, unknown>; reply?: string; reportPath?: string} = {
  startedAt: now(), mode: checkOnly ? 'no-model-check' : 'paid-one-turn', ok: false, checks: []
};
const step = (name: string, ok: boolean, detail?: string) => { report.checks.push({name, ok, ...(detail ? {detail} : {})}); console.log(`${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ' - ' + detail : ''}`); if (!ok) throw new Error(`${name}: ${detail ?? 'failed'}`); };

const {app, store, service, worker} = await createApp({root, startWorker: false});
try {
  store.put('agents', claude);
  const roomReceipt = service.execute({version: '0.1', commandId: uid('smoke'), type: 'room.create', payload: {name: 'Claude 沙箱冒烟', members: [claude.id]}});
  const roomId = roomReceipt.result.roomId as string;
  const probe = await worker.host.probe();
  writeFileSync(join(runDir, 'sandbox.json'), JSON.stringify(probe, null, 2));
  step('sandbox-probe', probe.ready === true, `${(probe.checks ?? []).filter((c: any) => c.passed).length}/${(probe.checks ?? []).length} checks`);
  const protocol = await probeAgentProtocol(claude, worker.host);
  writeFileSync(join(runDir, 'protocol.json'), JSON.stringify(protocol, null, 2));
  step('claude-protocol-precheck', protocol.ready === true, protocol.checks.filter((c: any) => !c.passed).map((c: any) => c.detail).join('; ') || '版本查询与 room MCP 控制帧通过');
  if (checkOnly) {
    report.ok = true;
    report.reportPath = join(runDir, 'report.json');
    console.log('claude-smoke: ready-for-paid-run');
  } else {
    worker.start();
    const marker = `CLAUDE_SANDBOX_OK_${Date.now() % 100000}`;
    const receipt = service.execute({version: '0.1', commandId: uid('smoke'), roomId, type: 'message.send', payload: {text: `只回复 ${marker}，不要调用工具。`, mentions: [claude.id]}});
    const runs = (): Run[] => store.list<Run>('runs', roomId);
    const deadline = Date.now() + 240_000;
    let run: Run | undefined;
    while (Date.now() < deadline) {
      run = runs().filter(item => item.agentId === claude.id).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
      if (run && ['completed', 'failed', 'canceled', 'interrupted', 'unknown'].includes(run.status)) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 500));
    }
    if (!run) throw new Error('等待 Claude 运行超时');
    const messages = store.list<{text: string; actor: {id: string}; runId?: string} & Record<string, any>>('messages', roomId).filter(message => message.runId === run!.id);
    const reply = messages.map(message => String(message.text)).join('\n').trim();
    report.run = {id: run.id, status: run.status, error: run.error ?? null, sandbox: run.sandbox ? {appContainer: (run.sandbox as any).appContainer, job: (run.sandbox as any).job, verifiedAt: (run.sandbox as any).verifiedAt} : null, nativeSessionId: run.nativeSessionId ? run.nativeSessionId.slice(0, 8) : null};
    report.reply = reply.slice(0, 500);
    writeFileSync(join(runDir, 'run.json'), JSON.stringify(run, null, 2));
    step('run-completed', run.status === 'completed', run.error ?? '');
    step('sandbox-verified', Boolean(run.sandbox && (run.sandbox as any).verifiedAt), 'AppContainer 执行记录存在');
    step('native-session', Boolean(run.nativeSessionId), run.nativeSessionId ? '已保存原生会话' : '缺少原生会话');
    step('expected-reply', reply.includes(marker), reply.slice(0, 200));
    report.ok = true;
    console.log('claude-smoke: PASS');
  }
} catch (error) {
  report.error = (error as Error).message;
  console.error(`claude-smoke: FAIL - ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  report.finishedAt = now();
  const reportPath = join(runDir, 'report.json');
  report.reportPath = reportPath;
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  writeFileSync(join(parent, 'latest.json'), JSON.stringify({run: runDir, report: reportPath, ok: report.ok, mode: report.mode, finishedAt: report.finishedAt}, null, 2));
  console.log(`claude-smoke report: ${reportPath}`);
  await app.close();
  try {
    const runs = readdirSync(parent).filter(name => name.startsWith('run-')).map(name => ({name, path: join(parent, name), mtime: statSync(join(parent, name)).mtimeMs}));
    for (const old of runs.sort((a, b) => b.mtime - a.mtime).slice(5)) { try { rmSync(old.path, {recursive: true, force: true}); } catch { /* best effort */ } }
  } catch { /* best effort */ }
}
