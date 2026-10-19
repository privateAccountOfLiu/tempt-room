// Environment mapping for native Agents, especially Claude Code behind an
// Anthropic-compatible gateway (the 3p desktop host uses DeepSeek's /anthropic
// endpoint with an auth token). These are pure environment checks: no model
// request and no subprocess.
import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeEnvironment} from '../apps/server/src/adapters.ts';
import {agentSchema} from '../packages/protocol/src/index.ts';

test('Claude native env uses the configured credential as ANTHROPIC_AUTH_TOKEN and endpoint as base URL', () => {
  process.env.TEST_CLAUDE_KEY = 'secret-claude-token';
  try {
    const agent = agentSchema.parse({id: 'claude-test', name: 'Claude', provider: 'claude', credentialEnv: 'TEST_CLAUDE_KEY', endpoint: 'https://api.deepseek.com/anthropic'});
    const env = nativeEnvironment({PATH: 'C:\\bin', ANTHROPIC_API_KEY: 'stale-key'}, agent);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'secret-claude-token');
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
    assert.equal(env.CLAUDE_CODE_HOST_AUTH_ENV_VAR, 'ANTHROPIC_AUTH_TOKEN');
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.TEST_CLAUDE_KEY, 'secret-claude-token');
    assert.equal(env.PATH, 'C:\\bin');
  } finally { delete process.env.TEST_CLAUDE_KEY; }
});

test('Codex and DeepSeek native env map compatible endpoint and provider key', () => {
  process.env.TEST_CODEX_KEY = 'codex-key';
  process.env.TEST_DEEPSEEK_KEY = 'deepseek-key';
  try {
    const codex = agentSchema.parse({id: 'codex-test', name: 'Codex', provider: 'codex', credentialEnv: 'TEST_CODEX_KEY', endpoint: 'https://openrouter.ai/api/v1'});
    const codexEnv = nativeEnvironment({}, codex);
    assert.equal(codexEnv.OPENAI_BASE_URL, 'https://openrouter.ai/api/v1');
    assert.equal(codexEnv.TEST_CODEX_KEY, 'codex-key');
    const deepseek = agentSchema.parse({id: 'deepseek-test', name: 'DeepSeek', provider: 'deepseek', credentialEnv: 'TEST_DEEPSEEK_KEY'});
    const deepseekEnv = nativeEnvironment({}, deepseek);
    assert.equal(deepseekEnv.DEEPSEEK_API_KEY, 'deepseek-key');
    assert.equal(deepseekEnv.ANTHROPIC_AUTH_TOKEN, undefined);
  } finally {
    delete process.env.TEST_CODEX_KEY;
    delete process.env.TEST_DEEPSEEK_KEY;
  }
});

test('Codex host proxy is opt-in through ROOM_CODEX_PROXY and not injected into sandbox', () => {
  process.env.ROOM_CODEX_PROXY = 'http://127.0.0.1:7897';
  try {
    const hostCodex = agentSchema.parse({id: 'codex-host', name: 'Codex', provider: 'codex', executionMode: 'host'});
    const hostEnv = nativeEnvironment({PATH: 'C:\\bin'}, hostCodex);
    assert.equal(hostEnv.HTTP_PROXY, 'http://127.0.0.1:7897');
    assert.equal(hostEnv.HTTPS_PROXY, 'http://127.0.0.1:7897');
    assert.equal(hostEnv.ALL_PROXY, 'http://127.0.0.1:7897');
    assert.equal(hostEnv.NO_PROXY, '127.0.0.1,localhost,::1');
    const sandboxCodex = agentSchema.parse({id: 'codex-sandbox', name: 'Codex', provider: 'codex', executionMode: 'sandbox'});
    const sandboxEnv = nativeEnvironment({}, sandboxCodex);
    assert.equal(sandboxEnv.HTTP_PROXY, undefined);
    assert.equal(sandboxEnv.HTTPS_PROXY, undefined);
  } finally { delete process.env.ROOM_CODEX_PROXY; }
});
