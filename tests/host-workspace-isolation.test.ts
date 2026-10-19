import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { hostChangeReport, hostStatus, prepareHostChatWorkspace } from '../apps/server/src/host-workspace.ts';
import type { Run } from '../packages/protocol/src/index.ts';

const base = resolve('.state/test-data');
function git(cwd: string, args: string[]) {
  const result = spawnSync('git', ['-C', cwd, ...args], {encoding: 'utf8', windowsHide: true, timeout: 30000});
  assert.equal(result.status, 0, result.stderr);
}
function repo(t: import('node:test').TestContext) {
  mkdirSync(base, {recursive: true});
  const root = mkdtempSync(join(base, 'host-workspace-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  git(root, ['init', '--quiet']);
  writeFileSync(join(root, 'tracked.txt'), 'committed\n');
  git(root, ['add', 'tracked.txt']);
  git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '--quiet', '-m', 'baseline']);
  return root;
}
function run(id: string, roomId = 'room-1'): Run {
  return {id, roomId, agentId: 'demo-planner', prompt: '', basedOnSeq: 0, status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()};
}

test('content hash detects a second edit while the Git status stays modified', t => {
  const root = repo(t);
  writeFileSync(join(root, 'tracked.txt'), 'first dirty edit\n');
  const baseline = hostStatus(root)!;
  writeFileSync(join(root, 'tracked.txt'), 'second dirty edit\n');
  const after = hostStatus(root)!;
  assert.notEqual(baseline.get('tracked.txt'), after.get('tracked.txt'));
  const report = hostChangeReport(root, baseline);
  assert.match(report, /tracked\.txt/);
  assert.match(report, /observed|观察到/);
  assert.match(report, /未证明这些变化由该 Agent 独占产生/);
});

test('content snapshot covers untracked additions, deletions and path union', t => {
  const root = repo(t);
  writeFileSync(join(root, 'scratch.txt'), 'scratch one\n');
  const baseline = hostStatus(root)!;
  rmSync(join(root, 'scratch.txt'));
  writeFileSync(join(root, 'result.txt'), 'result\n');
  const report = hostChangeReport(root, baseline);
  assert.match(report, /scratch\.txt/);
  assert.match(report, /result\.txt/);
  assert.match(report, /absent|missing/);
});

test('host chat workspaces are independent per run and never use the old room-shared directory', t => {
  mkdirSync(base, {recursive: true});
  const root = mkdtempSync(join(base, 'host-workspace-root-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const first = prepareHostChatWorkspace(root, run('run-first')), second = prepareHostChatWorkspace(root, run('run-second'));
  assert.notEqual(first, second);
  assert.ok(first.includes(`${sep}host-chat${sep}`));
  assert.ok(second.includes(`${sep}host-chat${sep}`));
  assert.notEqual(first, join(root, 'workspaces', 'rooms', 'room-1'));
  assert.ok(hostStatus(first), 'independent host workspace should be a Git worktree');
});
