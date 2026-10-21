// Release preflight: run the no-model checks against the current workspace in a
// fixed order and write a machine-readable report. It never calls a model and
// never invokes itself. The collaboration manifest (typecheck, unit tests,
// replay/fencing) runs once here; later steps add secrets, build, SDK, browser,
// production and image/connector checks.
//
// Run: npm run test:preflight [-- --expected-head <full-sha>] [--skip-browser] [--skip-sdk] [--with-native]
// CI: set ROOM_EXPECTED_HEAD to github.sha on a clean checkout.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readSourceInfo, type SourceSnapshot } from './verify-collaboration-baseline.ts';

interface StepResult { name: string; command: string; ok: boolean; skipped?: boolean; durationMs: number; exitCode: number | null; stdoutTail?: string; stderrTail?: string }
interface Report {
  startedAt: string; finishedAt?: string; ok: boolean; project: string; mode: 'development' | 'release';
  expectedHead?: string; sourceBefore?: SourceSnapshot; sourceAfter?: SourceSnapshot; sourceStable?: boolean;
  releaseEligible: boolean; verdict: string; notVerified: string[]; steps: StepResult[];
}

const project = resolve('.');
const args = process.argv.slice(2);
const allowed = new Set(['--skip-browser', '--skip-sdk', '--with-native']);
let expectedHead = process.env.ROOM_EXPECTED_HEAD?.trim() || undefined;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--expected-head') { const value = args[++index]; if (!value || value.startsWith('--')) throw new Error('--expected-head 需要一个完整 SHA'); expectedHead = value; }
  else if (!allowed.has(arg)) throw new Error(`未知 preflight 参数：${arg}`);
}
const skipBrowser = args.includes('--skip-browser');
const skipSdk = args.includes('--skip-sdk');
const withNative = args.includes('--with-native');
const parent = join(project, '.state', 'preflight');
mkdirSync(parent, { recursive: true });
const runDir = mkdtempSync(join(parent, 'run-'));
const report: Report = { startedAt: new Date().toISOString(), ok: false, project, mode: expectedHead ? 'release' : 'development', ...(expectedHead ? { expectedHead } : {}), releaseEligible: false, verdict: 'running', notVerified: [], steps: [] };
const reportPath = join(runDir, 'report.json');
const sourceBefore = readSourceInfo(project).sourceBefore!;
report.sourceBefore = sourceBefore;
const npmCli = process.env.npm_execpath;
function runNpm(commandArgs: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolveRun => {
    const command = npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
    const argv = npmCli ? [npmCli, ...commandArgs] : commandArgs;
    const child = spawn(command, argv, { cwd: project, windowsHide: true, shell: !npmCli && process.platform === 'win32' });
    let stdout = '', stderr = '', settled = false;
    const finish = (code: number | null) => { if (settled) return; settled = true; clearTimeout(timer); resolveRun({ code, stdout, stderr }); };
    const timer = setTimeout(() => { child.kill(); finish(null); }, timeoutMs);
    child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => { stderr += String(error); finish(null); });
    child.once('exit', code => finish(code));
  });
}
async function step(name: string, commandArgs: string[], timeoutMs = 1_500_000) {
  const started = Date.now();
  const display = `npm ${commandArgs.join(' ')}`;
  console.log(`\n=== ${name} (${display}) ===`);
  const result = await runNpm(commandArgs, timeoutMs);
  const durationMs = Date.now() - started;
  const ok = result.code === 0;
  const tail = (text: string) => text.trim().slice(-4000);
  report.steps.push({ name, command: display, ok, durationMs, exitCode: result.code, stdoutTail: tail(result.stdout), stderrTail: tail(result.stderr) });
  console.log(`${name}: ${ok ? 'PASS' : 'FAIL'} (${(durationMs / 1000).toFixed(1)}s)`);
  if (!ok) {
    const detail = (result.stderr || result.stdout).trim().split('\n').slice(-12).join('\n');
    console.error(`${name} 失败${result.code === null ? '（超时或无法启动）' : `：退出码 ${result.code}`}\n${detail}`);
    throw new Error(`${name} failed`);
  }
}
try {
  const collaboration = expectedHead ? ['run', 'verify:collaboration:release', '--', '--expected-head', expectedHead] : ['run', 'verify:collaboration'];
  await step(expectedHead ? 'collaboration-release' : 'collaboration-development', collaboration, 1_500_000);
  await step('secret-scan', ['run', 'check:secrets'], 120_000);
  await step('room-plugin-sync', ['run', 'check:room-plugin'], 120_000);
  await step('mcp-connectors', ['run', 'test:mcp-connectors'], 300_000);
  await step('acceptance-parallel', ['run', 'acceptance:parallel', '--', '--check'], 900_000);
  await step('acceptance-room-images', ['run', 'acceptance:room-images'], 300_000);
  await step('job-launcher', ['run', 'build:job-launcher'], 180_000);
  await step('build', ['run', 'build']);
  if (skipSdk) { report.steps.push({ name: 'sdk-consumer', command: 'npm run test:sdk', ok: true, skipped: true, durationMs: 0, exitCode: 0 }); console.log('\n=== sdk-consumer (skipped) ==='); }
  else await step('sdk-consumer', ['run', 'test:sdk']);
  if (skipBrowser) { report.steps.push({ name: 'browser-e2e', command: 'npm run test:browser', ok: true, skipped: true, durationMs: 0, exitCode: 0 }); console.log('\n=== browser-e2e (skipped) ==='); }
  else await step('browser-e2e', ['run', 'test:browser']);
  await step('production-smoke', ['run', 'test:production']);
  if (withNative) {
    await step('connectors', ['run', 'test:connectors']);
    await step('sandbox-probe', ['run', 'test:sandbox'], 900_000);
  } else {
    report.notVerified.push('native-image-pipe: run with --with-native on a machine with the Windows sandbox host');
  }
  report.ok = true;
} catch (error) {
  report.ok = false;
  console.error(`\nrelease preflight: FAIL - ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  const sourceAfterInfo = readSourceInfo(project);
  report.sourceAfter = sourceAfterInfo.sourceAfter;
  const before = report.sourceBefore!, after = report.sourceAfter!;
  report.sourceStable = before.head === after.head && before.trackedTreeHash === after.trackedTreeHash && before.workingContentHash === after.workingContentHash && before.untrackedManifestHash === after.untrackedManifestHash && before.lockfileHash === after.lockfileHash;
  const skipped = report.steps.filter(item => item.skipped);
  report.releaseEligible = report.ok && report.mode === 'release' && Boolean(expectedHead) && report.sourceStable && skipped.length === 0;
  if (!report.ok) report.verdict = 'checks_failed';
  else if (report.mode !== 'release') report.verdict = 'development_only';
  else if (!report.sourceStable) report.verdict = 'source_changed';
  else if (skipped.length) report.verdict = 'skipped_required_checks';
  else if (!report.releaseEligible) report.verdict = 'not_release_eligible';
  else report.verdict = 'release_eligible';
  report.finishedAt = new Date().toISOString();
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  writeFileSync(join(parent, 'latest.json'), JSON.stringify({ run: runDir, report: reportPath, ok: report.ok, releaseEligible: report.releaseEligible, verdict: report.verdict, finishedAt: report.finishedAt }, null, 2));
  console.log(`preflight report: ${reportPath}`);
  console.log(`verdict=${report.verdict} releaseEligible=${report.releaseEligible} sourceStable=${report.sourceStable}`);
  const total = report.steps.reduce((sum, item) => sum + item.durationMs, 0);
  console.log(`steps=${report.steps.length} total=${(total / 1000).toFixed(1)}s`);
  try {
    const runs = readdirSync(parent).filter(name => name.startsWith('run-')).map(name => ({ name, path: join(parent, name), mtime: statSync(join(parent, name)).mtimeMs }));
    for (const old of runs.sort((a, b) => b.mtime - a.mtime).slice(5)) {
      try { rmSync(old.path, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  } catch { /* best effort cleanup only */ }
}
