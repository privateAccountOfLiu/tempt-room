// Release preflight: run the no-model checks against the current workspace in a
// fixed order and write a machine-readable report. This does not call any model
// and does not replace the explicit paid real-Agent scenarios.
//
// Run: npm run test:preflight
// Optional: --skip-browser  --skip-sdk  --with-native
import {spawn} from 'node:child_process';
import {mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

interface StepResult {name: string; command: string; ok: boolean; skipped?: boolean; durationMs: number; exitCode: number | null; stdoutTail?: string; stderrTail?: string}
interface Report {startedAt: string; finishedAt?: string; ok: boolean; project: string; steps: StepResult[]}

const project = resolve('.');
const parent = join(project, '.state', 'preflight');
mkdirSync(parent, {recursive: true});
const runDir = mkdtempSync(join(parent, 'run-'));
const report: Report = {startedAt: new Date().toISOString(), ok: false, project, steps: []};
const reportPath = join(runDir, 'report.json');
const flags = new Set(process.argv.slice(2));
const skipBrowser = flags.has('--skip-browser');
const skipSdk = flags.has('--skip-sdk');
const withNative = flags.has('--with-native');
const npmCli = process.env.npm_execpath;
function runNpm(args: string[], timeoutMs: number): Promise<{code: number | null; stdout: string; stderr: string}> {
  return new Promise(resolveRun => {
    const command = npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
    const argv = npmCli ? [npmCli, ...args] : args;
    const child = spawn(command, argv, {cwd: project, windowsHide: true, shell: !npmCli && process.platform === 'win32'});
    let stdout = '', stderr = '', settled = false;
    const finish = (code: number | null) => { if (settled) return; settled = true; clearTimeout(timer); resolveRun({code, stdout, stderr}); };
    const timer = setTimeout(() => { child.kill(); finish(null); }, timeoutMs);
    child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => { stderr += String(error); finish(null); });
    child.once('exit', code => finish(code));
  });
}
async function step(name: string, args: string[], timeoutMs = 600_000) {
  const started = Date.now();
  const display = `npm ${args.join(' ')}`;
  console.log(`\n=== ${name} (${display}) ===`);
  const result = await runNpm(args, timeoutMs);
  const durationMs = Date.now() - started;
  const ok = result.code === 0;
  const tail = (text: string) => text.trim().slice(-4000);
  report.steps.push({name, command: display, ok, durationMs, exitCode: result.code, stdoutTail: tail(result.stdout), stderrTail: tail(result.stderr)});
  console.log(`${name}: ${ok ? 'PASS' : 'FAIL'} (${(durationMs / 1000).toFixed(1)}s)`);
  if (!ok) {
    const detail = (result.stderr || result.stdout).trim().split('\n').slice(-12).join('\n');
    console.error(`${name} 失败${result.code === null ? '（超时或无法启动）' : `：退出码 ${result.code}`}\n${detail}`);
    throw new Error(`${name} failed`);
  }
}
try {
  await step('typecheck', ['run', 'typecheck']);
  await step('unit-tests', ['test']);
  await step('secret-scan', ['run', 'check:secrets'], 120_000);
  await step('build', ['run', 'build']);
  if (skipSdk) { report.steps.push({name: 'sdk-consumer', command: 'npm run test:sdk', ok: true, skipped: true, durationMs: 0, exitCode: 0}); console.log('\n=== sdk-consumer (skipped) ==='); }
  else await step('sdk-consumer', ['run', 'test:sdk']);
  if (skipBrowser) { report.steps.push({name: 'browser-e2e', command: 'npm run test:browser', ok: true, skipped: true, durationMs: 0, exitCode: 0}); console.log('\n=== browser-e2e (skipped) ==='); }
  else await step('browser-e2e', ['run', 'test:browser']);
  await step('production-smoke', ['run', 'test:production']);
  if (withNative) {
    await step('connectors', ['run', 'test:connectors']);
    await step('sandbox-probe', ['run', 'test:sandbox'], 900_000);
  }
  report.ok = true;
  console.log('\nrelease preflight: PASS');
} catch (error) {
  report.ok = false;
  console.error(`\nrelease preflight: FAIL - ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  writeFileSync(join(parent, 'latest.json'), JSON.stringify({run: runDir, report: reportPath, ok: report.ok, finishedAt: report.finishedAt}, null, 2));
  console.log(`preflight report: ${reportPath}`);
  const total = report.steps.reduce((sum, step) => sum + step.durationMs, 0);
  console.log(`steps=${report.steps.length} total=${(total / 1000).toFixed(1)}s`);
  try {
    const runs = readdirSync(parent).filter(name => name.startsWith('run-')).map(name => ({name, path: join(parent, name), mtime: statSync(join(parent, name)).mtimeMs}));
    for (const old of runs.sort((a, b) => b.mtime - a.mtime).slice(5)) {
      try { rmSync(old.path, {recursive: true, force: true}); } catch { /* best effort */ }
    }
  } catch { /* best effort cleanup only */ }
}
