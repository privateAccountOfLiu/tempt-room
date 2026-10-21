import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Contract tests for the two shipped external MCP connectors.
 *
 * These spawn the real `.mjs` entry points over stdio. They never reach the
 * room server: the token case fails before any HTTP request is made.
 */
const MAIN = 'scripts/room-agent-mcp.mjs';
const PLUGIN = 'plugins/tempt-room-claude/server/room-agent-mcp.mjs';

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type Connector = {
  request: (method: string, params?: unknown) => Promise<any>;
  sendRaw: (line: string) => void;
  stdoutLines: () => string[];
  stderrText: () => string;
  stop: () => void;
};

function startConnector(script: string, env: Record<string, string | undefined> = {}): Connector {
  const child = spawn(process.execPath, [resolve(script)], {
    env: { ...process.env, ROOM_URL: 'http://127.0.0.1:9', ROOM_AGENT_TOKEN: 'fixture-token', ROOM_ROOM_ID: 'room_fixture', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const lines: string[] = [];
  const errors: string[] = [];
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let buffer = '';
  let nextId = 0;

  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? '';
    for (const line of parts) {
      if (!line.trim()) continue;
      lines.push(line);
      const message = JSON.parse(line) as JsonRpcMessage;
      const entry = message.id === undefined ? undefined : pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id as number);
      message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => { errors.push(chunk.toString('utf8')); });

  return {
    request: (method, params) => new Promise((resolvePromise, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: resolvePromise, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`timeout: ${method}`));
      }, 10000).unref();
    }),
    sendRaw: (line) => { child.stdin.write(line + '\n'); },
    stdoutLines: () => [...lines],
    stderrText: () => errors.join(''),
    stop: () => { try { child.kill(); } catch { /* already gone */ } },
  };
}

const REQUIRED_TOOLS = [
  'room_read', 'room_inbox', 'room_post', 'room_wait',
  'task_propose', 'task_claim', 'task_context', 'task_complete', 'task_heartbeat',
  'artifact_publish', 'room_status', 'session_inbox', 'session_ack',
];

for (const script of [MAIN, PLUGIN]) {
  test(`${script} passes node --check`, () => {
    const check = spawnSync(process.execPath, ['--check', resolve(script)], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
  });

  test(`${script} speaks JSON-RPC over stdio`, async t => {
    const connector = startConnector(script);
    t.after(() => connector.stop());

    const initialized = await connector.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'contract', version: '1' } });
    assert.equal((initialized as any).serverInfo.name, 'tempt-room-connector');

    const ping = await connector.request('ping', {});
    assert.deepEqual(ping, {});

    const listed = await connector.request('tools/list', {});
    const names = (listed as any).tools.map((tool: any) => tool.name);
    for (const required of REQUIRED_TOOLS) assert.ok(names.includes(required), `missing ${required}`);

    for (const line of connector.stdoutLines()) {
      const message = JSON.parse(line) as JsonRpcMessage;
      assert.equal(message.jsonrpc, '2.0', `bad envelope: ${line}`);
      assert.equal(typeof message.id, 'number', `bad id: ${line}`);
      assert.ok(message.result !== undefined || message.error !== undefined, `missing result/error: ${line}`);
      assert.ok(!('result' in message && 'error' in message), `result and error together: ${line}`);
    }
  });

  test(`${script} reports unknown methods and unknown tools`, async t => {
    const connector = startConnector(script);
    t.after(() => connector.stop());

    await assert.rejects(
      () => connector.request('does/not/exist', {}),
      (error: Error) => {
        const payload = JSON.parse(error.message);
        assert.equal(payload.code, -32601);
        return true;
      },
    );

    await assert.rejects(
      () => connector.request('tools/call', { name: 'room_not_a_tool', arguments: {} }),
      (error: Error) => {
        const payload = JSON.parse(error.message);
        assert.equal(payload.code, -32603);
        assert.match(payload.message, /Unknown room tool/);
        return true;
      },
    );
  });

  test(`${script} survives invalid JSON and oversized frames`, async t => {
    const connector = startConnector(script);
    t.after(() => connector.stop());

    connector.sendRaw('{ this is not json');
    connector.sendRaw('x'.repeat(2 ** 20 + 16));

    const ping = await connector.request('ping', {});
    assert.deepEqual(ping, {});
    for (const line of connector.stdoutLines()) JSON.parse(line);
  });

  test(`${script} fails explicitly without a token and leaks nothing`, async t => {
    const connector = startConnector(script, { ROOM_AGENT_TOKEN: '', ROOM_ROOM_ID: '' });
    t.after(() => connector.stop());

    await assert.rejects(
      () => connector.request('tools/call', { name: 'room_read', arguments: {} }),
      (error: Error) => {
        const payload = JSON.parse(error.message);
        assert.equal(payload.code, -32603);
        assert.match(payload.message, /ROOM_AGENT_TOKEN/);
        return true;
      },
    );

    const stdout = connector.stdoutLines().join('\n');
    assert.doesNotMatch(stdout, /fixture-token/);
    assert.doesNotMatch(connector.stderrText(), /fixture-token/);
  });

  test(`${script} keeps diagnostics off the protocol stream`, async t => {
    const connector = startConnector(script);
    t.after(() => connector.stop());

    await connector.request('ping', {});
    assert.doesNotMatch(connector.stderrText(), /"jsonrpc"/);
    for (const line of connector.stdoutLines()) assert.doesNotMatch(line, /^\s*\[/);
  });
}

test('both connectors expose identical tool schemas', async t => {
  const main = startConnector(MAIN);
  const plugin = startConnector(PLUGIN);
  t.after(() => { main.stop(); plugin.stop(); });
  const [a, b] = await Promise.all([main.request('tools/list', {}), plugin.request('tools/list', {})]);
  assert.deepEqual((a as any).tools, (b as any).tools);
});

test('plugin copy matches the workspace source of truth', () => {
  const check = spawnSync(process.execPath, [resolve('scripts/sync-room-agent-plugin.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

test('plugin copy is byte-identical to the main connector', () => {
  const main = readFileSync(resolve(MAIN));
  const plugin = readFileSync(resolve(PLUGIN));
  assert.ok(main.equals(plugin), 'plugin connector drifted from scripts/room-agent-mcp.mjs');
});
