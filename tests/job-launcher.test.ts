import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HostChannel } from '../apps/server/src/host.ts';

const launcher = resolve('.state/tools/job-launcher.exe');
const available = process.platform === 'win32' && existsSync(launcher);

test('job launcher kills its child tree when the launcher process dies', async t => {
  if (!available) { t.skip('job-launcher.exe not built (run npm run build:job-launcher)'); return; }
  const script = "const cp=require('child_process');const g=cp.spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});console.log('GRAND='+g.pid);setTimeout(()=>{},60000)";
  const helper = spawn(launcher, ['--', process.execPath, '-e', script], {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
  t.after(() => { try { helper.kill(); } catch {} });
  const grandPid = await new Promise<number>((done, fail) => {
    let output = '';
    const timer = setTimeout(() => fail(new Error('launcher produced no GRAND pid')), 10000);
    helper.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/GRAND=(\d+)/);
      if (match) { clearTimeout(timer); done(Number(match[1])); }
    });
  });
  helper.kill();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { process.kill(grandPid, 0); } catch { return; }
    await new Promise(done => setTimeout(done, 150));
  }
  assert.fail('grandchild survived launcher termination');
});

test('HostChannel records a job-object cleanup proof when launched through the job launcher', async t => {
  if (!available) { t.skip('job-launcher.exe not built (run npm run build:job-launcher)'); return; }
  const script = "console.log(JSON.stringify({jsonrpc:'2.0',method:'ready'}));setTimeout(()=>{},60000)";
  const child = spawn(launcher, ['--', process.execPath, '-e', script], {stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
  const channel = new HostChannel(child as any, 'run_job_launcher', {jobLauncher: true});
  t.after(() => { try { child.kill(); } catch {} });
  await channel.terminate();
  assert.equal(channel.cleanupProof?.evidence, 'job-object-kill-on-close');
  assert.equal(channel.cleanupProof?.remainingProcesses, 0);
});
