import test from 'node:test';
import assert from 'node:assert/strict';
import { runAcp } from '../apps/server/src/acp.ts';

function channel(replies: any[]) {
  let onFrame: ((frame: any) => void) | undefined;
  const request = async (method: string) => {
    if (method === 'initialize') return {protocolVersion: 1, agentCapabilities: {sessionCapabilities: {}}};
    if (method === 'session/new') return {sessionId: 'acp_session'};
    if (method === 'session/close') return {};
    if (method === 'session/prompt') {
      onFrame?.({method: 'session/request_permission', id: 7, params: {sessionId: 'acp_session', options: [{kind: 'allow_once', optionId: 'allow'}]}});
      await new Promise(done => setTimeout(done, 10));
      return {stopReason: 'end_turn'};
    }
    throw new Error('unexpected ' + method);
  };
  return {
    request,
    send: async () => {},
    reply: async (_id: unknown, result: unknown) => { replies.push(result); },
    get onFrame() { return onFrame; },
    set onFrame(value) { onFrame = value; }
  };
}

test('ACP permission requests are selected only when the authorization callback allows', async () => {
  for (const allowed of [false, true]) {
    const replies: any[] = [];
    await runAcp({channel: channel(replies) as any, workspace: '.', model: '', prompt: 'hello', mcpServers: [], signal: new AbortController().signal, emit: () => {}, setCancel: () => {}, onError: error => { throw error; }, authorizePermission: async () => allowed});
    assert.equal(replies.length, 1);
    if (allowed) assert.deepEqual(replies[0], {outcome: {outcome: 'selected', optionId: 'allow'}});
    else assert.deepEqual(replies[0], {outcome: {outcome: 'cancelled'}});
  }
});

test('cancellation after an async permission approval wins the race', async () => {
  const replies: any[] = [], controller = new AbortController();
  await assert.rejects(() => runAcp({channel: channel(replies) as any, workspace: '.', model: '', prompt: 'hello', mcpServers: [], signal: controller.signal, emit: () => {}, setCancel: () => {}, onError: error => { throw error; }, authorizePermission: () => { setTimeout(() => controller.abort(), 5); return new Promise<boolean>(resolve => setTimeout(() => resolve(true), 25)); }}), /abort/i);
  await new Promise(done => setTimeout(done, 40));
  assert.deepEqual(replies[0], {outcome: {outcome: 'cancelled'}});
});
