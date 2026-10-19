// Codex host-mode smoke test.
// Reads the configured Codex Agent, runs it as a managed host Agent (the user's
// own CODEX_HOME / ChatGPT login, full local permissions) and optionally sends
// one real model prompt. This does NOT replace the sandbox acceptance, which
// requires an explicit API key.
//
//   npm run test:codex -- --check       # binary/version check, no model
//   npm run test:codex -- --allow-paid  # one real model turn (uses ChatGPT quota)
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../apps/server/src/app.ts';
import { agentSchema, type AgentDescriptor, type Run } from '../packages/protocol/src/index.ts';
import { now, uid } from '../apps/server/src/store.ts';

const checkOnly = process.argv.includes('--check');
const allowPaid = process.argv.includes('--allow-paid');
if (!checkOnly && !allowPaid) {
  console.error('用法：npm run test:codex -- --check（不调用模型）或 --allow-paid（一次真实模型轮次，消耗 ChatGPT 配额）');
  process.exit(2);
}
const project = resolve('.');
const source = resolve(process.env.ROOM_STATE_DIR ?? '.state');
if (existsSync(join(source, 'server.lock'))) throw new Error('请先关闭使用该数据目录的 Tempt Room 服务');
const dbFile = join(source, 'room.sqlite');
if (!existsSync(dbFile)) throw new Error('没有找到配置数据库：请先在应用中配置 Codex 成员');
const database = new DatabaseSync(dbFile, {readOnly: true});
const configured = database.prepare('SELECT body FROM agents').all().map(row => agentSchema.parse(JSON.parse((row as any).body)) as AgentDescriptor);
database.close();
const sourceCodex = configured.find(agent => agent.provider === 'codex' && agent.enabled);
if (!sourceCodex) throw new Error('没有已启用的 Codex 成员');
const codex: AgentDescriptor = agentSchema.parse({...sourceCodex, id: 'codex-smoke', name: 'Codex 冒烟', connectionMode: 'managed', executionMode: 'host'});

const parent = join(project, '.state', 'codex-smoke');
mkdirSync(parent, {recursive: true});
const runDir = mkdtempSync(join(parent, 'run-'));
const root = join(runDir, 'state');
const report: {startedAt: string; finishedAt?: string; mode: string; ok: boolean; error?: string; checks: Array<{name: string; ok: boolean; detail?: string}>; run?: Record<string, unknown>; reply?: string; reportPath?: string} = {startedAt: now(), mode: checkOnly ? 'no-model-check' : 'paid-host-one-turn', ok: false, checks: []};
const step = (name: string, ok: boolean, detail?: string) => { report.checks.push({name, ok, ...(detail ? {detail} : {})}); console.log(`${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ' - ' + detail : ''}`); if (!ok) throw new Error(`${name}: ${detail ?? 'failed'}`); };

try {
  const version = spawnSync(codex.executable, ['--version'], {encoding: 'utf8', windowsHide: true, timeout: 30_000});
  step('codex-binary', version.status === 0, String(version.stdout ?? '').trim() || String(version.stderr ?? '').trim());
  step('codex-home', Boolean(process.env.CODEX_HOME ?? true), process.env.CODEX_HOME ? `CODEX_HOME=${process.env.CODEX_HOME}` : '将使用用户默认 ~/.codex（ChatGPT 登录）');
  if (checkOnly) { report.ok = true; console.log('codex-smoke: ready-for-paid-run'); }
  else {
    const {app, store, service, worker} = await createApp({root, startWorker: false});
    try {
      store.put('agents', codex);
      const roomId = service.execute({version: '0.1', commandId: uid('smoke'), type: 'room.create', payload: {name: 'Codex host 冒烟', members: [codex.id]}}).result.roomId as string;
      worker.start();
      const marker = `CODEX_HOST_OK_${Date.now() % 100000}`;
      service.execute({version: '0.1', commandId: uid('smoke'), roomId, type: 'message.send', payload: {text: `只回复 ${marker}，不要调用工具。`, mentions: [codex.id]}});
      const deadline = Date.now() + 240_000;
      let run: Run | undefined;
      while (Date.now() < deadline) {
        run = store.list<Run>('runs', roomId).filter(item => item.agentId === codex.id).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
        if (run && ['completed', 'failed', 'canceled', 'interrupted', 'unknown', 'waiting_input'].includes(run.status)) break;
        await new Promise(resolveWait => setTimeout(resolveWait, 500));
      }
      if (!run) throw new Error('等待 Codex 运行超时');
      const messages = store.list<any>('messages', roomId).filter(message => message.runId === run!.id);
      const reply = messages.map(message => String(message.text)).join('\n').trim();
      report.run = {id: run.id, status: run.status, error: run.error ?? null, host: !run.sandbox, nativeSessionId: run.nativeSessionId ? run.nativeSessionId.slice(0, 8) : null};
      report.reply = reply.slice(0, 500);
      writeFileSync(join(runDir, 'run.json'), JSON.stringify(run, null, 2));
      step('run-completed', run.status === 'completed', run.error ?? '');
      step('host-mode', !run.sandbox, run.sandbox ? '意外出现沙箱记录' : '使用当前用户环境与 ChatGPT 登录');
      step('expected-reply', reply.includes(marker), reply.slice(0, 300));
      report.ok = true;
      console.log('codex-smoke: PASS');
    } finally { await app.close(); }
  }
} catch (error) {
  report.error = (error as Error).message;
  console.error(`codex-smoke: FAIL - ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  report.finishedAt = now();
  const reportPath = join(runDir, 'report.json');
  report.reportPath = reportPath;
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  writeFileSync(join(parent, 'latest.json'), JSON.stringify({run: runDir, report: reportPath, ok: report.ok, mode: report.mode, finishedAt: report.finishedAt}, null, 2));
  console.log(`codex-smoke report: ${reportPath}`);
  try {
    const runs = readdirSync(parent).filter(name => name.startsWith('run-')).map(name => ({name, path: join(parent, name), mtime: statSync(join(parent, name)).mtimeMs}));
    for (const old of runs.sort((a, b) => b.mtime - a.mtime).slice(5)) { try { rmSync(old.path, {recursive: true, force: true}); } catch { /* best effort */ } }
  } catch { /* best effort */ }
}
