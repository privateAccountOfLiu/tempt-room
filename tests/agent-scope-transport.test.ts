import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {AddressInfo} from 'node:net';
import {AgentScopeTransport, agentScopeCapabilities} from '../apps/server/src/ports/agent-scope.ts';
import type {AdapterContext} from '../apps/server/src/adapters.ts';

test('AgentScope service transport maps session, output, input, cancel and outcome onto the port', async t => {
  const requests: Array<{method: string; url: string; body: string}> = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({method: request.method ?? '', url: request.url ?? '', body});
      response.setHeader('content-type', 'application/json');
      if (request.method === 'POST' && request.url === '/sessions') {
        response.end(JSON.stringify({sessionId: 'session_fixture', output: 'AGENT_SCOPE_FIXTURE_OK', events: [{type: 'usage', usage: {inputTokens: 3, outputTokens: 5}}]}));
      } else if (request.method === 'POST' && request.url === '/sessions/session_fixture/input') {
        response.end(JSON.stringify({accepted: true}));
      } else if (request.method === 'DELETE' && request.url === '/sessions/session_fixture') {
        response.end(JSON.stringify({canceled: true}));
      } else if (request.method === 'GET' && request.url === '/sessions/session_fixture/outcome') {
        response.end(JSON.stringify({status: 'completed'}));
      } else {
        response.statusCode = 404;
        response.end(JSON.stringify({error: {message: 'not found'}}));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const transport = new AgentScopeTransport({endpoint});
  const context = {
    prompt: 'fixture prompt',
    run: {id: 'run_fixture', roomId: 'room_fixture', generation: 1},
    executionId: 'exec_fixture',
    signal: new AbortController().signal
  } as unknown as AdapterContext;
  const outputs: any[] = [];
  for await (const output of transport.openExecution(context).outputs) outputs.push(output);
  assert.deepEqual(outputs[0], {type: 'session', id: 'session_fixture'});
  assert.ok(outputs.some(output => output.type === 'text' && output.text === 'AGENT_SCOPE_FIXTURE_OK'));
  assert.ok(outputs.some(output => output.type === 'usage'));
  assert.equal(transport.provideInput('exec_fixture', 'more context'), true);
  transport.cancel('exec_fixture', new Error('owner stop'));
  assert.deepEqual(await transport.queryOutcome('exec_fixture'), {status: 'completed'});
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(requests.some(request => request.method === 'POST' && request.url === '/sessions/session_fixture/input'));
  assert.ok(requests.some(request => request.method === 'DELETE' && request.url === '/sessions/session_fixture'));
  assert.ok(requests.some(request => request.method === 'GET' && request.url === '/sessions/session_fixture/outcome'));
  assert.equal(agentScopeCapabilities.streaming, 'unverified');
  assert.equal(agentScopeCapabilities.queryOutcome, 'unverified');
});
