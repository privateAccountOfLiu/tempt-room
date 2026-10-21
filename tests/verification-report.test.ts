import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseVerifyArgs, verify, type SourceInfo, type SourceSnapshot } from '../scripts/verify-collaboration-baseline.ts';

const base = resolve('.state/test-data');

function snapshot(head: string, status: string, overrides: Partial<SourceSnapshot> = {}): SourceSnapshot {
  return {
    head, dirty: Boolean(status), status, gitOk: true,
    trackedTreeHash: `tree-${head}`, workingContentHash: `work-${head}`,
    untrackedManifestHash: 'untracked-empty', lockfileHash: 'lock-hash',
    generatedAt: '2026-10-19T00:00:00.000Z', ...overrides
  };
}

function source(head: string, status: string, after?: SourceSnapshot): SourceInfo {
  const before = snapshot(head, status);
  return {
    cwd: '.', head, dirty: Boolean(status), status, statusHash: status ? 'status-hash' : 'clean-hash',
    node: 'v-test', npm: '10.0.0', git: 'git version test', generatedAt: '2026-10-19T00:00:00.000Z',
    sourceBefore: before, sourceAfter: after ?? before,
    trackedTreeHash: before.trackedTreeHash, workingContentHash: before.workingContentHash,
    untrackedManifestHash: before.untrackedManifestHash, lockfileHash: before.lockfileHash, gitOk: true
  };
}

test('baseline report records successful commands, hashes, and source identity', t => {
  mkdirSync(base, {recursive: true});
  const root = mkdtempSync(join(base, 'verify-baseline-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const result = verify({
    cwd: root,
    evidenceDir: join(root, 'evidence'),
    commands: [{name: 'typecheck', argv: ['npm', 'run', 'typecheck']}, {name: 'test', argv: ['npm', 'test']}],
    runner: (_spec, cwd) => ({exitCode: 0, stdout: `cwd=${cwd}`, stderr: ''}),
    source: source('a'.repeat(40), ''),
    now: () => new Date('2026-10-19T00:00:00.000Z')
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.ok, true);
  assert.equal(result.report.mode, 'development');
  assert.equal(result.report.checksPassed, true);
  assert.equal(result.report.releaseEligible, false);
  assert.equal(result.report.modelRequests, 0);
  assert.equal(result.report.schemaVersion, 2);
  assert.equal(result.report.sourceBefore.head, 'a'.repeat(40));
  assert.equal(result.report.sourceBefore.dirty, false);
  assert.deepEqual(result.report.totals, {total: 2, passed: 2, failed: 0, notRun: 0});
  assert.equal(result.report.commands[0].status, 'passed');
  assert.equal(result.report.commands[0].exitCode, 0);
  assert.ok(existsSync(result.reportPath));
  const saved = JSON.parse(readFileSync(result.reportPath, 'utf8'));
  assert.equal(saved.commands[0].stdoutSha256.length, 64);
  assert.match(saved.commands[0].stdoutPath, /typecheck\.stdout\.txt$/);
});

test('baseline report fails the process when any command fails and dirty development sources stay explicit', t => {
  mkdirSync(base, {recursive: true});
  const root = mkdtempSync(join(base, 'verify-baseline-fail-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const result = verify({
    cwd: root,
    evidenceDir: join(root, 'evidence'),
    commands: [{name: 'typecheck', argv: ['npm', 'run', 'typecheck']}, {name: 'test', argv: ['npm', 'test']}],
    runner: spec => spec.name === 'test' ? {exitCode: 1, stdout: 'failed output', stderr: 'failure'} : {exitCode: 0, stdout: '', stderr: ''},
    source: source('b'.repeat(40), '?? scratch.txt'),
    now: () => new Date('2026-10-19T01:00:00.000Z')
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.ok, false);
  assert.equal(result.report.checksPassed, false);
  assert.equal(result.report.sourceBefore.dirty, true);
  assert.deepEqual(result.report.totals, {total: 2, passed: 1, failed: 1, notRun: 0});
  assert.equal(result.report.commands[1].status, 'failed');
  assert.equal(result.report.commands[1].stderr, 'failure');
});

test('release requires a clean tree, expected HEAD and stable source content', t => {
  mkdirSync(base, {recursive: true});
  const root = mkdtempSync(join(base, 'verify-release-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const head = 'c'.repeat(40);
  const passing = () => verify({
    cwd: root, evidenceDir: join(root, `evidence-${Math.random()}`), mode: 'release', expectedHead: head,
    commands: [{name: 'typecheck', argv: ['npm', 'run', 'typecheck']}],
    runner: () => ({exitCode: 0, stdout: '', stderr: ''}),
    source: source(head, ''),
    now: () => new Date('2026-10-19T02:00:00.000Z')
  });
  const clean = passing();
  assert.equal(clean.exitCode, 0);
  assert.equal(clean.report.releaseEligible, true);
  assert.equal(clean.report.releaseBlockers.length, 0);
  assert.equal(clean.report.commands[0].status, 'passed');
  const dirty = verify({
    cwd: root, evidenceDir: join(root, 'dirty'), mode: 'release', expectedHead: head,
    commands: [{name: 'typecheck', argv: ['npm', 'run', 'typecheck']}],
    runner: () => ({exitCode: 0, stdout: '', stderr: ''}),
    source: source(head, ' M src.ts'),
    now: () => new Date('2026-10-19T02:00:00.000Z')
  });
  assert.equal(dirty.exitCode, 1);
  assert.equal(dirty.report.releaseEligible, false);
  assert.equal(dirty.report.totals.notRun, 1);
  assert.ok(dirty.report.releaseBlockers.includes('source_dirty'));
  assert.equal(dirty.report.commands[0].status, 'not_run');
  assert.equal(dirty.report.commands[0].exitCode, null);
  const mismatch = verify({
    cwd: root, evidenceDir: join(root, 'mismatch'), mode: 'release', expectedHead: 'd'.repeat(40),
    commands: [], runner: () => ({exitCode: 0, stdout: '', stderr: ''}),
    source: source(head, ''), now: () => new Date('2026-10-19T02:00:00.000Z')
  });
  assert.ok(mismatch.report.releaseBlockers.includes('expected_head_mismatch'));
  assert.equal(mismatch.report.releaseEligible, false);
});

test('a release fails when tracked content changes after the commands ran', t => {
  mkdirSync(base, {recursive: true});
  const root = mkdtempSync(join(base, 'verify-release-change-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const head = 'e'.repeat(40);
  const after = snapshot(head, '', {trackedTreeHash: 'tree-changed'});
  const result = verify({
    cwd: root, evidenceDir: join(root, 'evidence'), mode: 'release', expectedHead: head,
    commands: [{name: 'test', argv: ['npm', 'test']}],
    runner: () => ({exitCode: 0, stdout: '', stderr: ''}),
    source: source(head, ''), sourceAfter: source(head, '', after),
    now: () => new Date('2026-10-19T03:00:00.000Z')
  });
  assert.equal(result.report.checksPassed, true);
  assert.equal(result.report.sourceStable, false);
  assert.equal(result.report.releaseEligible, false);
  assert.ok(result.report.releaseBlockers.includes('source_changed_during_verification'));
  assert.equal(result.exitCode, 1);
});

test('CLI arguments reject unknown flags and require an expected head value', () => {
  assert.deepEqual(parseVerifyArgs([]), {mode: 'development'});
  const release = parseVerifyArgs(['--release', '--expected-head', 'f'.repeat(40)]);
  assert.equal(release.mode, 'release');
  assert.equal(release.expectedHead, 'f'.repeat(40));
  assert.throws(() => parseVerifyArgs(['--relase']), /未知参数/);
  assert.throws(() => parseVerifyArgs(['--release', '--expected-head']), /需要/);
  assert.throws(() => parseVerifyArgs(['--release', '--expected-head', '--other']), /需要/);
});
