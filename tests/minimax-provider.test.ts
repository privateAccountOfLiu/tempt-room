import test from 'node:test';
import assert from 'node:assert/strict';
import {agentSchema, capabilitiesFor, providerSchema} from '../packages/protocol/src/index.ts';

test('MiniMax Code is an external-only provider in the agent contract', () => {
  assert.equal(providerSchema.parse('minimax'), 'minimax');
  assert.throws(
    () => agentSchema.parse({id: 'minimax-managed', name: 'MiniMax Code', provider: 'minimax'}),
    /外部会话|外部/
  );
  const external = agentSchema.parse({
    id: 'minimax-code',
    name: 'MiniMax Code',
    provider: 'minimax',
    connectionMode: 'external',
    enabled: true
  });
  assert.equal(external.connectionMode, 'external');
  assert.deepEqual(capabilitiesFor('minimax', {connectionMode: 'external', responseFormat: 'text'}), {
    streaming: false,
    resume: false,
    cancel: false,
    execute: false,
    artifacts: true,
    input: false,
    usage: false
  });
});
