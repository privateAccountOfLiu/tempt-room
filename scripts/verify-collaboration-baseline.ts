// Record a verifiable collaboration baseline: source identity, command argv,
// outputs, hashes, and a machine-readable summary. This script never calls a
// model; every command is local. Development runs may be dirty; release runs
// require a clean tree, an explicit expected HEAD and identical source content
// before and after verification.
//
// Run: npm run verify:collaboration
// Release: npm run verify:collaboration -- --release --expected-head <full-sha>
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type VerificationMode = 'development' | 'release';
export type CommandName = 'typecheck' | 'test' | 'replay' | string;
export interface CommandSpec { name: string; argv: string[] }
export interface CommandResult { exitCode: number | null; stdout: string; stderr: string }
export interface SourceSnapshot {
  head: string | null;
  dirty: boolean;
  status: string;
  gitOk: boolean;
  gitError?: string;
  trackedTreeHash: string;
  workingContentHash: string;
  untrackedManifestHash: string;
  lockfileHash: string;
  generatedAt: string;
}
export interface SourceInfo {
  cwd: string;
  /** Compatibility fields from schema version 1. */
  head: string | null;
  dirty: boolean;
  status: string;
  statusHash: string;
  node: string;
  npm: string;
  git: string;
  generatedAt: string;
  sourceBefore?: SourceSnapshot;
  sourceAfter?: SourceSnapshot;
  trackedTreeHash?: string;
  workingContentHash?: string;
  untrackedManifestHash?: string;
  lockfileHash?: string;
  gitOk?: boolean;
  gitError?: string;
}
export interface ReportedCommand extends CommandResult {
  name: string;
  argv: string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: 'passed' | 'failed' | 'not_run';
  stdoutPath: string;
  stderrPath: string;
  stdoutSha256: string;
  stderrSha256: string;
  cwd?: string;
}
export interface VerificationReport {
  schemaVersion: 2;
  mode: VerificationMode;
  generatedAt: string;
  expectedHead?: string;
  source: SourceInfo;
  sourceBefore: SourceSnapshot;
  sourceAfter: SourceSnapshot;
  sourceStable: boolean;
  modelRequests: 0;
  commands: ReportedCommand[];
  totals: {total: number; passed: number; failed: number; notRun: number};
  checksPassed: boolean;
  releaseEligible: boolean;
  ok: boolean;
  releaseBlockers: string[];
}

export type Runner = (spec: CommandSpec, cwd: string) => CommandResult;
export interface VerificationOptions {
  cwd?: string;
  evidenceRoot?: string;
  evidenceDir?: string;
  commands?: CommandSpec[];
  runner?: Runner;
  source?: SourceInfo;
  sourceAfter?: SourceInfo;
  mode?: VerificationMode;
  expectedHead?: string;
  now?: () => Date;
}

const defaultCommands: CommandSpec[] = [
  {name: 'typecheck', argv: ['npm', 'run', 'typecheck']},
  {name: 'test', argv: ['npm', 'test']},
  {name: 'replay', argv: ['npm', 'run', 'test:replay']}
];

function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function iso(now: () => Date): string { return now().toISOString(); }
interface GitResult { ok: boolean; stdout: string; stderr: string; }
function git(cwd: string, args: string[]): GitResult {
  const result = spawnSync('git', args, {cwd, encoding: 'utf8', windowsHide: true, timeout: 15000});
  return {ok: result.status === 0 && !result.error, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? result.error?.message ?? '')};
}
function gitText(cwd: string, args: string[]): string {
  const result = git(cwd, args);
  return result.ok ? result.stdout.trim() : '';
}
function splitZ(value: string): string[] { return value.split('\0').filter(Boolean); }
function fileHash(cwd: string, path: string): {type: string; size: number; hash: string} {
  const absolute = join(cwd, path);
  try {
    const info = lstatSync(absolute);
    if (info.isSymbolicLink()) return {type: 'symlink', size: Buffer.byteLength(path), hash: sha256(`symlink:${readlinkSync(absolute)}`)};
    if (!info.isFile()) return {type: 'other', size: 0, hash: sha256(`${typeOf(info)}`)};
    return {type: 'file', size: info.size, hash: sha256(readFileSync(absolute))};
  } catch { return {type: 'missing', size: 0, hash: sha256('missing')}; }
}
function typeOf(info: {isDirectory(): boolean; isSymbolicLink(): boolean}): string { return info.isDirectory() ? 'directory' : 'other'; }
function manifest(cwd: string, paths: string[]): {hash: string; entries: number} {
  const records = paths.map(path => ({path, ...fileHash(cwd, path)})).sort((a, b) => a.path.localeCompare(b.path));
  return {hash: sha256(JSON.stringify(records)), entries: records.length};
}
function lockfileHash(cwd: string): string {
  for (const name of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) {
    const path = join(cwd, name);
    if (existsSync(path)) return sha256(readFileSync(path));
  }
  return sha256('no-lockfile');
}
function snapshot(cwd: string, now: () => Date, statusOverride?: string): SourceSnapshot {
  const statusResult = statusOverride === undefined ? git(cwd, ['status', '--porcelain=v1']) : {ok: true, stdout: statusOverride, stderr: ''};
  const headResult = git(cwd, ['rev-parse', 'HEAD']);
  const trackedResult = git(cwd, ['ls-files', '-z']);
  const untrackedResult = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  const tracked = trackedResult.ok ? splitZ(trackedResult.stdout) : [];
  const untracked = untrackedResult.ok ? splitZ(untrackedResult.stdout) : [];
  const trackedManifest = manifest(cwd, tracked), untrackedManifest = manifest(cwd, untracked);
  const combined = [...tracked, ...untracked].sort();
  const working = manifest(cwd, combined);
  const status = statusResult.ok ? statusResult.stdout : '';
  const gitError = !statusResult.ok ? statusResult.stderr.trim() || 'git status failed' : !headResult.ok ? headResult.stderr.trim() || 'git rev-parse failed' : !trackedResult.ok ? trackedResult.stderr.trim() || 'git ls-files failed' : !untrackedResult.ok ? untrackedResult.stderr.trim() || 'git ls-files --others failed' : undefined;
  return {
    head: headResult.ok ? headResult.stdout.trim() : null,
    dirty: Boolean(status.trim()),
    status,
    gitOk: !gitError,
    ...(gitError ? {gitError} : {}),
    trackedTreeHash: trackedManifest.hash,
    workingContentHash: working.hash,
    untrackedManifestHash: untrackedManifest.hash,
    lockfileHash: lockfileHash(cwd),
    generatedAt: iso(now)
  };
}
export function readSourceInfo(cwd = resolve('.'), now = () => new Date()): SourceInfo {
  const base = snapshot(cwd, now);
  const npm = (() => { const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], {cwd, encoding: 'utf8', windowsHide: true, timeout: 15000, shell: process.platform === 'win32'}); return result.status === 0 ? String(result.stdout ?? '').trim() : 'unknown'; })();
  const info: SourceInfo = {
    cwd,
    head: base.head,
    dirty: base.dirty,
    status: base.status,
    statusHash: sha256(base.status),
    node: process.version,
    npm,
    git: gitText(cwd, ['--version']) || 'unknown',
    generatedAt: base.generatedAt,
    sourceBefore: base,
    sourceAfter: base,
    trackedTreeHash: base.trackedTreeHash,
    workingContentHash: base.workingContentHash,
    untrackedManifestHash: base.untrackedManifestHash,
    lockfileHash: base.lockfileHash,
    gitOk: base.gitOk,
    ...(base.gitError ? {gitError: base.gitError} : {})
  };
  return info;
}
export function defaultRunner(spec: CommandSpec, cwd: string): CommandResult {
  const [command, ...args] = spec.argv;
  const result = spawnSync(command, args, {cwd, encoding: 'utf8', windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32'});
  return {exitCode: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '')};
}

function beforeSnapshot(source: SourceInfo): SourceSnapshot {
  return source.sourceBefore ?? {
    head: source.head, dirty: source.dirty, status: source.status, gitOk: source.gitOk ?? true,
    ...(source.gitError ? {gitError: source.gitError} : {}),
    trackedTreeHash: source.trackedTreeHash ?? '', workingContentHash: source.workingContentHash ?? '', untrackedManifestHash: source.untrackedManifestHash ?? '',
    lockfileHash: source.lockfileHash ?? '', generatedAt: source.generatedAt
  };
}
function sameSource(a: SourceSnapshot, b: SourceSnapshot): boolean {
  return a.head === b.head && a.trackedTreeHash === b.trackedTreeHash && a.workingContentHash === b.workingContentHash && a.untrackedManifestHash === b.untrackedManifestHash && a.lockfileHash === b.lockfileHash;
}
function emptyCommand(spec: CommandSpec, cwd: string, now: () => Date, evidenceDir: string): ReportedCommand {
  const at = iso(now);
  const stdoutPath = join(evidenceDir, `${spec.name}.stdout.txt`), stderrPath = join(evidenceDir, `${spec.name}.stderr.txt`);
  writeFileSync(stdoutPath, ''); writeFileSync(stderrPath, '');
  return {name: spec.name, argv: spec.argv, exitCode: null, stdout: '', stderr: '', startedAt: at, finishedAt: at, durationMs: 0, status: 'not_run', stdoutPath, stderrPath, stdoutSha256: sha256(''), stderrSha256: sha256(''), cwd};
}

export function verify(options: VerificationOptions = {}): {report: VerificationReport; reportPath: string; exitCode: number} {
  const cwd = resolve(options.cwd ?? '.'), now = options.now ?? (() => new Date());
  const mode = options.mode ?? 'development';
  const evidenceRoot = resolve(options.evidenceRoot ?? join(cwd, '.state', 'collaboration-baseline'));
  const evidenceDir = resolve(options.evidenceDir ?? join(evidenceRoot, `run-${now().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`));
  mkdirSync(evidenceDir, {recursive: true});
  const source = options.source ?? readSourceInfo(cwd, now);
  const before = beforeSnapshot(source);
  const commands = options.commands ?? defaultCommands, runner = options.runner ?? defaultRunner;
  const blockers: string[] = [];
  if (mode === 'release') {
    if (!options.expectedHead) blockers.push('expected_head_required');
    else if (!/^[a-f0-9]{40}$/i.test(options.expectedHead)) blockers.push('expected_head_format');
    else if (!before.head || before.head.toLowerCase() !== options.expectedHead.toLowerCase()) blockers.push('expected_head_mismatch');
    if (!before.gitOk) blockers.push('source_unknown');
    if (before.dirty) blockers.push('source_dirty');
  }
  const reported: ReportedCommand[] = [];
  if (mode === 'release' && blockers.length) {
    for (const spec of commands) reported.push(emptyCommand(spec, cwd, now, evidenceDir));
  } else {
    for (const spec of commands) {
      const startedAt = iso(now), started = Date.now();
      const result = runner(spec, cwd);
      const finishedAt = iso(now);
      const stdoutPath = join(evidenceDir, `${spec.name}.stdout.txt`), stderrPath = join(evidenceDir, `${spec.name}.stderr.txt`);
      writeFileSync(stdoutPath, result.stdout); writeFileSync(stderrPath, result.stderr);
      reported.push({...result, name: spec.name, argv: spec.argv, startedAt, finishedAt, durationMs: Date.now() - started, status: result.exitCode === 0 ? 'passed' : 'failed', stdoutPath, stderrPath, stdoutSha256: sha256(result.stdout), stderrSha256: sha256(result.stderr), cwd});
    }
  }
  const failed = reported.filter(command => command.status === 'failed').length;
  const notRun = reported.filter(command => command.status === 'not_run').length;
  const checksPassed = failed === 0 && notRun === 0;
  const sourceAfterInfo = options.sourceAfter ?? (options.source ? source : mode === 'release' ? readSourceInfo(cwd, now) : source);
  const after = sourceAfterInfo.sourceAfter ?? beforeSnapshot(sourceAfterInfo);
  const sourceStable = sameSource(before, after);
  if (mode === 'release' && !sourceStable) blockers.push('source_changed_during_verification');
  if (mode === 'release' && !checksPassed) blockers.push('checks_not_passed');
  const releaseEligible = mode === 'release' && blockers.length === 0 && checksPassed && sourceStable;
  const info: SourceInfo = {...source, sourceAfter: after};
  const report: VerificationReport = {
    schemaVersion: 2,
    mode,
    generatedAt: iso(now),
    ...(options.expectedHead ? {expectedHead: options.expectedHead} : {}),
    source: info,
    sourceBefore: before,
    sourceAfter: after,
    sourceStable,
    modelRequests: 0,
    commands: reported,
    totals: {total: reported.length, passed: reported.length - failed - notRun, failed, notRun},
    checksPassed,
    releaseEligible,
    ok: mode === 'release' ? releaseEligible : checksPassed,
    releaseBlockers: blockers
  };
  const reportPath = join(evidenceDir, 'report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  return {report, reportPath, exitCode: report.ok ? 0 : 1};
}

export function parseVerifyArgs(argv: string[]): {mode: VerificationMode; expectedHead?: string} {
  let mode: VerificationMode = 'development', expectedHead: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--release') mode = 'release';
    else if (arg === '--expected-head') { const value = argv[++index]; if (!value || value.startsWith('--')) throw new Error('--expected-head 需要一个完整 SHA'); expectedHead = value; }
    else throw new Error(`未知参数：${arg}`);
  }
  return {mode, ...(expectedHead ? {expectedHead} : {})};
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const args = parseVerifyArgs(process.argv.slice(2));
    const result = verify(args);
    console.log(`collaboration baseline (${result.report.mode}): ${result.report.ok ? 'PASS' : 'FAIL'}`);
    console.log(`source HEAD: ${result.report.sourceBefore.head ?? 'unknown'}${result.report.sourceBefore.dirty ? ' (dirty)' : ''}`);
    for (const blocker of result.report.releaseBlockers) console.log(`release blocker: ${blocker}`);
    for (const command of result.report.commands) console.log(`${command.name}: ${command.status} (exit ${command.exitCode ?? 'null'})`);
    console.log(`checksPassed=${result.report.checksPassed} releaseEligible=${result.report.releaseEligible}`);
    console.log(`report: ${result.reportPath}`);
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(`collaboration baseline: ERROR ${(error as Error).message}`);
    process.exitCode = 2;
  }
}
