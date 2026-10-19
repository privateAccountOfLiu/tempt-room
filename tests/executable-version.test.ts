import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeVersion, parseCodexVersion } from '../apps/server/src/executable-version.ts';

test('Codex CLI version output parser accepts common forms', () => {
  assert.equal(parseCodexVersion('codex-cli 0.163.0-alpha.10.2\n'), '0.163.0-alpha.10.2');
  assert.equal(parseCodexVersion('Codex CLI 1.2.3'), '1.2.3');
  assert.equal(parseCodexVersion('noise\ncodex 0.9.0\nmore'), '0.9.0');
  assert.equal(parseCodexVersion('unrelated output'), undefined);
});

test('Claude Code CLI version output parser accepts common forms', () => {
  assert.equal(parseClaudeVersion('2.1.271 (Claude Code)'), '2.1.271');
  assert.equal(parseClaudeVersion('v2.0.1'), '2.0.1');
  assert.equal(parseClaudeVersion('no version'), undefined);
});
