import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verify, type SourceInfo } from '../scripts/verify-collaboration-baseline.ts';

const base = resolve('.state/test-data');

function source(head: string, status: string): SourceInfo {
  return {
    cwd: '.', head, dirty: Boolean(status), status, statusHash: status ? 'status-hash' : 'clean-hash',
    node: 'v-test', npm: '10.0.0', git: 'git version test', generatedAt: '2026-10-19T00:00:00.000Z'
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
    source: source('abc123', ''),
    now: () => new Date('2026-10-19T00:00:00.000Z')
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.ok, true);
  assert.equal(result.report.modelRequests, 0);
  assert.equal(result.report.schemaVersion, 1);
  assert.equal(result.report.source.head, 'abc123');
  assert.equal(result.report.source.dirty, false);
  assert.deepEqual(result.report.totals, {total: 2, passed: 2, failed: 0, notRun: 0});
  assert.equal(result.report.commands[0].status, 'passed');
  assert.equal(result.report.commands[0].exitCode, 0);
  assert.ok(existsSync(result.reportPath));
  const saved = JSON.parse(readFileSync(result.reportPath, 'utf8'));
  assert.equal(saved.commands[0].stdoutSha256.length, 64);
  assert.match(saved.commands[0].stdoutPath, /typecheck\.stdout\.txt$/);
});

test('baseline report fails the process when any command fails and distinguishes dirty sources', t => {
  mkdirSync(base, {recursive: true});
  const root = mkdtempSync(join(base, 'verify-baseline-fail-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const result = verify({
    cwd: root,
    evidenceDir: join(root, 'evidence'),
    commands: [{name: 'typecheck', argv: ['npm', 'run', 'typecheck']}, {name: 'test', argv: ['npm', 'test']}],
    runner: spec => spec.name === 'test' ? {exitCode: 1, stdout: 'failed output', stderr: 'failure'} : {exitCode: 0, stdout: '', stderr: ''},
    source: source('def456', '?? scratch.txt'),
    now: () => new Date('2026-10-19T01:00:00.000Z')
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.ok, false);
  assert.equal(result.report.source.dirty, true);
  assert.equal(result.report.source.statusHash, 'status-hash');
  assert.deepEqual(result.report.totals, {total: 2, passed: 1, failed: 1, notRun: 0});
  assert.equal(result.report.commands[1].status, 'failed');
  assert.equal(result.report.commands[1].stderr, 'failure');
});
