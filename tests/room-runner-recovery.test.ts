import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecoveryPrompt } from '../scripts/room-runner-recovery.mjs';

test('runner recovery prompt keeps pending deliveries in source order and deduplicates', () => {
  const plan = buildRecoveryPrompt([
    {deliveryId: 'd2', eventId: 'e2', seq: 2, text: 'second'},
    {deliveryId: 'd1', eventId: 'e1', seq: 1, text: 'first'},
    {deliveryId: 'd2', eventId: 'e2', seq: 2, text: 'second'}
  ]);
  assert.deepEqual(plan.deliveryIds, ['d1', 'd2']);
  assert.equal(plan.maxSeq, 2);
  assert.ok(plan.prompt.startsWith('以下是你离线期间待处理的会话输入'));
  assert.ok(plan.prompt.indexOf('first') < plan.prompt.indexOf('second'));
});

test('missing recovery text is explicit rather than silently consumed', () => {
  const plan = buildRecoveryPrompt([{deliveryId: 'd3', eventId: 'e3', seq: 3, text: '   '}]);
  assert.match(plan.prompt, /未取得事件正文/);
  assert.deepEqual(plan.deliveryIds, ['d3']);
  assert.equal(buildRecoveryPrompt([]).prompt, '');
});
