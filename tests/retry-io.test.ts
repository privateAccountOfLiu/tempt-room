import test from 'node:test';
import assert from 'node:assert/strict';
import { retryIo } from '../apps/server/src/retry.ts';

test('retryIo retries transient Windows filesystem errors', async () => {
  let calls = 0;
  const result = await retryIo(async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error('locked'), {code: 'EPERM'});
    return 'ok';
  }, {delayMs: 1});
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('retryIo does not retry permanent errors and eventually gives up', async () => {
  let permanent = 0;
  await assert.rejects(() => retryIo(async () => { permanent++; throw Object.assign(new Error('bad'), {code: 'EINVAL'}); }, {delayMs: 1}), /bad/);
  assert.equal(permanent, 1);
  let transient = 0;
  await assert.rejects(() => retryIo(async () => { transient++; throw Object.assign(new Error('locked'), {code: 'EBUSY'}); }, {attempts: 3, delayMs: 1}), /locked/);
  assert.equal(transient, 3);
});
