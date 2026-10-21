import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

const scripts = ['scripts/room-agent-mcp.mjs', 'plugins/tempt-room-claude/server/room-agent-mcp.mjs'];

test('both room MCP server copies parse', () => {
  for (const script of scripts) {
    const check = spawnSync(process.execPath, ['--check', resolve(script)], {encoding: 'utf8'});
    assert.equal(check.status, 0, `${script}: ${check.stderr}`);
  }
});

test('room MCP server exposes the full room tool set over stdio', async t => {
  const child = spawn(process.execPath, [resolve(scripts[0])], {
    env: {...process.env, ROOM_URL: 'http://127.0.0.1:9', ROOM_AGENT_TOKEN: 'fixture-token', ROOM_ROOM_ID: 'room_fixture'},
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  t.after(() => { try { child.kill(); } catch {} });
  let buffer = '';
  const pending = new Map<number, {resolve: (value: any) => void; reject: (error: Error) => void}>();
  let id = 0;
  const request = (method: string, params: unknown) => new Promise<any>((resolvePromise, reject) => {
    const requestId = ++id;
    pending.set(requestId, {resolve: resolvePromise, reject});
    child.stdin.write(JSON.stringify({jsonrpc: '2.0', id: requestId, method, params}) + '\n');
    setTimeout(() => { if (pending.delete(requestId)) reject(new Error(`timeout: ${method}`)); }, 10000);
  });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const entry = message.id ? pending.get(message.id) : undefined;
      if (!entry) continue;
      pending.delete(message.id);
      message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
    }
  });
  const initialized = await request('initialize', {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'contract', version: '1'}});
  assert.equal(initialized.serverInfo.name, 'tempt-room-connector');
  child.stdin.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) + '\n');
  const listed = await request('tools/list', {});
  const names = listed.tools.map((tool: any) => tool.name);
  for (const required of ['room_read', 'room_post', 'room_wait', 'session_inbox', 'session_ack', 'task_claim', 'task_complete', 'artifact_publish']) {
    assert.ok(names.includes(required), `missing ${required}`);
  }
  assert.equal(names.length, 13);
});
