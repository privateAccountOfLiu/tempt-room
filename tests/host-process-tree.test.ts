import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { killProcessTreeWithProof } from '../apps/server/src/host.ts';

test('host process tree proof verifies tracked descendants are gone after taskkill', async () => {
  if (process.platform !== 'win32') return;
  const script = "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});setTimeout(()=>{},60000)";
  const child = spawn(process.execPath, ['-e', script], {stdio: 'ignore', windowsHide: true});
  await new Promise<void>(done => setTimeout(done, 800));
  const proof = killProcessTreeWithProof(child.pid);
  assert.ok(proof);
  assert.equal(proof!.remainingProcesses, 0);
  assert.ok(proof!.trackedProcesses >= 2);
  assert.equal(proof!.evidence, 'taskkill-tree-scan');
  assert.ok(proof!.checkedAt);
  await new Promise<void>(done => { if (child.exitCode !== null) return done(); child.once('exit', () => done()); });
});
