import test from 'node:test';
import assert from 'node:assert/strict';
import { issueAgentToken, verifyAgentToken } from '../apps/server/src/agent-tokens.ts';

test('Agent room tokens are scoped, rotatable and tamper-proof', () => {
  const secret = 'startup-secret';
  const claude = issueAgentToken(secret, 'claude', 'room_1');
  assert.equal(verifyAgentToken(secret, claude, 'room_1'), 'claude');
  assert.notEqual(claude, issueAgentToken(secret, 'deepseek', 'room_1'));
  assert.notEqual(claude, issueAgentToken(secret, 'claude', 'room_2'));
  assert.equal(verifyAgentToken(secret, issueAgentToken(secret, 'deepseek', 'room_1'), 'room_1'), 'deepseek');
  // Tampered signature, wrong secret, missing signature and forged agent id all fail.
  assert.equal(verifyAgentToken(secret, claude.slice(0, -1) + (claude.endsWith('a') ? 'b' : 'a'), 'room_1'), undefined);
  assert.equal(verifyAgentToken('other-secret', claude, 'room_1'), undefined);
  assert.equal(verifyAgentToken(secret, 'claude', 'room_1'), undefined);
  assert.equal(verifyAgentToken(secret, claude.replace(/^claude\./, 'deepseek.'), 'room_1'), undefined);
  assert.equal(verifyAgentToken(secret, claude, 'room_2'), undefined);
  assert.equal(verifyAgentToken(secret, claude.replace('.room_1.', '.room_2.'), 'room_2'), undefined);
  assert.equal(verifyAgentToken(secret, 'claude.' + claude.split('.').at(-1), 'room_1'), undefined);
  assert.equal(verifyAgentToken(secret, claude + '.extra', 'room_1'), undefined);
});
