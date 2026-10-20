import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionKey } from '../apps/server/src/sessions.ts';
import { agentSchema, type Run } from '../packages/protocol/src/index.ts';

const now = new Date().toISOString();
const runtime: Run = {id: 'run_1', roomId: 'room_1', agentId: 'demo-planner', status: 'queued', prompt: 'hello', basedOnSeq: 0, createdAt: now, updatedAt: now};

test('legacy chat runs keep the v2 native session scope', () => {
  const agent = agentSchema.parse({id: 'demo-planner', name: 'Demo', provider: 'demo'});
  assert.match(sessionKey(runtime, agent, 'C:/workspace'), /^v2:/);
  assert.equal(sessionKey(runtime, agent, 'C:/workspace'), sessionKey({...runtime, id: 'run_2'}, agent, 'C:/workspace'));
});

test('logical AgentSessions get isolated v3 scopes and mode changes invalidate them', () => {
  const agent = agentSchema.parse({id: 'demo-planner', name: 'Demo', provider: 'demo'});
  const first = sessionKey({...runtime, agentSessionId: 'as_1'}, agent, 'C:/workspace');
  assert.match(first, /^v3:/);
  assert.equal(first, sessionKey({...runtime, id: 'run_2', agentSessionId: 'as_1'}, agent, 'C:/workspace'));
  assert.notEqual(first, sessionKey({...runtime, agentSessionId: 'as_2'}, agent, 'C:/workspace'));
  assert.notEqual(first, sessionKey({...runtime, agentSessionId: 'as_1'}, {...agent, executionMode: 'host'}, 'C:/workspace'));
  assert.notEqual(first, sessionKey({...runtime, agentSessionId: 'as_1'}, {...agent, connectionMode: 'external'}, 'C:/workspace'));
});
