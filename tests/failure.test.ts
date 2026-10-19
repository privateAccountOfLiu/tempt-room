import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure } from '../packages/protocol/src/index.ts';

test('failure classification maps actionable error families without changing status', () => {
  assert.equal(classifyFailure('运行超出 Token 预算：已上报 10 / 上限 5', 'failed').kind, 'budget');
  assert.equal(classifyFailure('运行达到时间上限', 'canceled').kind, 'timeout');
  assert.equal(classifyFailure('上下文已变化', 'failed').kind, 'context');
  assert.equal(classifyFailure('401 invalid credential', 'failed').kind, 'auth');
  assert.equal(classifyFailure('connect ECONNREFUSED 127.0.0.1', 'failed').kind, 'network');
  assert.equal(classifyFailure('依赖任务未成功', 'failed').kind, 'dependency');
  assert.equal(classifyFailure('tool operation unknown', 'unknown').kind, 'tool');
  assert.equal(classifyFailure(undefined, 'canceled').kind, 'canceled');
  assert.equal(classifyFailure(undefined, 'interrupted').kind, 'canceled');
  assert.equal(classifyFailure(undefined, 'unknown').kind, 'unknown');
  assert.equal(classifyFailure('random failure text', 'failed').kind, 'unknown');
  assert.equal(classifyFailure('random failure text', 'failed').retryable, true);
});
