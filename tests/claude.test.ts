import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeMcpConfig, requireClaudeRoomMcp, checkClaudeRoomMcp } from '../apps/server/src/claude.ts';

test('Claude MCP uses an environment map and preserves the room pipe value', () => {
  const pipe = String.raw`\\.\pipe\LOCAL\TemptRoom-run_1`;
  const config = claudeMcpConfig({ command: 'C:/tools/node.exe', args: ['C:/tools/room-bridge.mjs'], env: [{ name: 'ROOM_PIPE', value: pipe }] });
  assert.deepEqual(config.mcpServers.room, { command: 'C:/tools/node.exe', args: ['C:/tools/room-bridge.mjs'], env: { ROOM_PIPE: pipe } });
});

test('Claude no-model check sends only correlated control requests and requires a connected room server', async () => {
  const sent: any[] = [];
  const channel: any = { exit: new Promise(() => {}), write: async (data: string) => {
    const frame = JSON.parse(data); sent.push(frame);
    queueMicrotask(() => {
      channel.onFrame({ type: 'control_response', response: { subtype: 'success', request_id: 'unrelated', response: {} } });
      channel.onFrame({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id,
        response: frame.request.subtype === 'mcp_status' ? { mcpServers: [{ name: 'room', status: 'connected' }] } : {} } });
    });
  } };
  await checkClaudeRoomMcp(channel, 1000);
  assert.deepEqual(sent.map(frame => [frame.type, frame.request.subtype]), [['control_request', 'initialize'], ['control_request', 'mcp_status']]);
  assert.equal(channel.onFrame, undefined);
  channel.write = async (data: string) => { const frame = JSON.parse(data); queueMicrotask(() => channel.onFrame({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { mcpServers: [] } } })); };
  await assert.rejects(checkClaudeRoomMcp(channel, 1000), /Claude 房间 MCP 未连接/);
});

test('Claude startup refuses absent or failed room tools even when the model can reply', () => {
  assert.doesNotThrow(() => requireClaudeRoomMcp({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'room', status: 'connected' }] }));
  for (const servers of [undefined, [], [{ name: 'room', status: 'failed' }], [{ name: 'other', status: 'connected' }]]) {
    assert.throws(() => requireClaudeRoomMcp({ type: 'system', subtype: 'init', mcp_servers: servers }), /Claude 房间 MCP 未连接/);
  }
  assert.throws(() => requireClaudeRoomMcp({ type: 'system', subtype: 'init', mcp_server_errors: [{ name: 'room', error: 'env invalid' }] }), /env invalid/);
  assert.doesNotThrow(() => requireClaudeRoomMcp({ type: 'result' }));
});
