// Record a verifiable collaboration baseline: source identity, command argv,
// outputs, hashes, and a machine-readable summary. This script never calls a
// model; every command is local and can be faked by tests.
//
// Run: npm run verify:collaboration
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type CommandName = 'typecheck' | 'test' | 'replay' | string;
export interface CommandSpec { name: string; argv: string[] }
export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}
export interface SourceInfo {
  cwd: string;
  head: string | null;
  dirty: boolean;
  status: string;
  statusHash: string;
  node: string;
  npm: string;
  git: string;
  generatedAt: string;
}
export interface ReportedCommand extends CommandResult {
  name: string;
  argv: string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: 'passed' | 'failed';
  stdoutPath: string;
  stderrPath: string;
  stdoutSha256: string;
  stderrSha256: string;
}
export interface VerificationReport {
  schemaVersion: 1;
  generatedAt: string;
  source: SourceInfo;
  modelRequests: 0;
  commands: ReportedCommand[];
  totals: {total: number; passed: number; failed: number; notRun: number};
  ok: boolean;
}

export type Runner = (spec: CommandSpec, cwd: string) => CommandResult;
export interface VerificationOptions {
  cwd?: string;
  evidenceRoot?: string;
  evidenceDir?: string;
  commands?: CommandSpec[];
  runner?: Runner;
  source?: SourceInfo;
  now?: () => Date;
}

const defaultCommands: CommandSpec[] = [
  {name: 'typecheck', argv: ['npm', 'run', 'typecheck']},
  {name: 'test', argv: ['npm', 'test']},
  {name: 'replay', argv: ['npm', 'run', 'test:replay']}
];

function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function iso(now: () => Date): string { return now().toISOString(); }
function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, {cwd, encoding: 'utf8', windowsHide: true, timeout: 15000});
  return result.status === 0 ? String(result.stdout ?? '').trim() : '';
}
export function readSourceInfo(cwd = resolve('.'), now = () => new Date()): SourceInfo {
  const status = git(cwd, ['status', '--porcelain=v1']);
  const head = git(cwd, ['rev-parse', 'HEAD']) || null;
  return {
    cwd,
    head,
    dirty: Boolean(status),
    status,
    statusHash: sha256(status),
    node: process.version,
    npm: (() => { const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], {cwd, encoding: 'utf8', windowsHide: true, timeout: 15000, shell: process.platform === 'win32'}); return result.status === 0 ? String(result.stdout ?? '').trim() : 'unknown'; })(),
    git: git(cwd, ['--version']) || 'unknown',
    generatedAt: iso(now)
  };
}
export function defaultRunner(spec: CommandSpec, cwd: string): CommandResult {
  const [command, ...args] = spec.argv;
  const result = spawnSync(command, args, {cwd, encoding: 'utf8', windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32'});
  return {exitCode: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '')};
}
export function verify(options: VerificationOptions = {}): {report: VerificationReport; reportPath: string; exitCode: number} {
  const cwd = resolve(options.cwd ?? '.'), now = options.now ?? (() => new Date());
  const evidenceRoot = resolve(options.evidenceRoot ?? join(cwd, '.state', 'collaboration-baseline'));
  const evidenceDir = resolve(options.evidenceDir ?? join(evidenceRoot, `run-${now().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`));
  mkdirSync(evidenceDir, {recursive: true});
  const source = options.source ?? readSourceInfo(cwd, now);
  const commands = options.commands ?? defaultCommands, runner = options.runner ?? defaultRunner;
  const reported: ReportedCommand[] = [];
  for (const spec of commands) {
    const startedAt = iso(now), started = Date.now();
    const result = runner(spec, cwd);
    const finishedAt = iso(now);
    const stdoutPath = join(evidenceDir, `${spec.name}.stdout.txt`), stderrPath = join(evidenceDir, `${spec.name}.stderr.txt`);
    writeFileSync(stdoutPath, result.stdout);
    writeFileSync(stderrPath, result.stderr);
    reported.push({
      ...result,
      name: spec.name,
      argv: spec.argv,
      startedAt,
      finishedAt,
      durationMs: Date.now() - started,
      status: result.exitCode === 0 ? 'passed' : 'failed',
      stdoutPath,
      stderrPath,
      stdoutSha256: sha256(result.stdout),
      stderrSha256: sha256(result.stderr)
    });
  }
  const failed = reported.filter(command => command.status === 'failed').length;
  const report: VerificationReport = {
    schemaVersion: 1,
    generatedAt: iso(now),
    source,
    modelRequests: 0,
    commands: reported,
    totals: {total: reported.length, passed: reported.length - failed, failed, notRun: 0},
    ok: failed === 0
  };
  const reportPath = join(evidenceDir, 'report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  return {report, reportPath, exitCode: report.ok ? 0 : 1};
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const result = verify();
  console.log(`collaboration baseline: ${result.report.ok ? 'PASS' : 'FAIL'}`);
  console.log(`source HEAD: ${result.report.source.head ?? 'unknown'}${result.report.source.dirty ? ' (dirty)' : ''}`);
  for (const command of result.report.commands) console.log(`${command.name}: ${command.status} (exit ${command.exitCode ?? 'null'})`);
  console.log(`report: ${result.reportPath}`);
  process.exitCode = result.exitCode;
}
