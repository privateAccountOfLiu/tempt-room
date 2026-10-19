// A2A 1.0 compatibility over real HTTP.
// The adapter's normal transport enforces public HTTPS; this fixture injects a
// loopback HTTP transport so the full request/response wire format (agent card,
// message:send, task polling, cancel, JSON-RPC) is exercised without a model or
// external network. Production egress policy is covered by dedicated security
// tests, not relaxed here.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import type {IncomingMessage} from 'node:http';
import {runAdapter, RemoteCanceled, type AdapterContext} from '../apps/server/src/adapters.ts';
import {agentSchema} from '../packages/protocol/src/index.ts';

type Recorded = {method: string; path: string; headers: http.IncomingHttpHeaders; body?: any};

async function startMock(handler: (request: http.IncomingMessage, response: http.ServerResponse, body: string) => void) {
  const requests: Recorded[] = [];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    let parsed: unknown;
    try { parsed = body ? JSON.parse(body) : undefined; } catch { parsed = undefined; }
    requests.push({method: request.method ?? '', path: request.url ?? '', headers: request.headers, body: parsed});
    handler(request, response, body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server 没有地址');
  return {base: `http://127.0.0.1:${address.port}`, port: address.port, requests, close: () => new Promise<void>(resolve => server.close(() => resolve()))};
}

function transport(url: string, options?: {method?: string; body?: unknown; token?: string; signal?: AbortSignal; headers?: Record<string, string>}): Promise<IncomingMessage> {
  const settings = options ?? {};
  const target = new URL(url);
  const body = settings.body === undefined ? undefined : JSON.stringify(settings.body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname, port: target.port, path: target.pathname + target.search,
      method: settings.method ?? (body === undefined ? 'GET' : 'POST'),
      signal: settings.signal,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : {'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body))}),
        ...(settings.token ? {authorization: `Bearer ${settings.token}`} : {}),
        ...settings.headers
      }
    }, resolve);
    request.on('error', reject);
    request.end(body);
  });
}

function context(base: string, extra: Partial<AdapterContext> = {}): AdapterContext {
  return {
    agent: agentSchema.parse({id: 'remote', name: 'Remote', provider: 'a2a', endpoint: `${base}/`, credentialEnv: 'A2A_TEST_TOKEN'}),
    run: {id: 'run-http', roomId: 'room-http', agentId: 'remote', status: 'running', prompt: 'hello', basedOnSeq: 1, createdAt: '', updatedAt: ''},
    prompt: 'hello', workspace: '', home: '', stateRoot: '', signal: new AbortController().signal, host: {} as any, transport, ...extra
  };
}

const json = (response: http.ServerResponse, value: unknown, status = 200) => {
  response.writeHead(status, {'content-type': 'application/json'});
  response.end(JSON.stringify(value));
};
const card = (base: string, binding = 'HTTP+JSON', path = '/a2a') => ({supportedInterfaces: [{protocolVersion: '1.0', protocolBinding: binding, url: `${base}${path}`}]});

test('A2A HTTP+JSON real wire: card, send, input continuation and artifacts', async () => {
  let sends = 0;
  const mock = await startMock((request, response) => {
    if (request.url === '/.well-known/agent-card.json') return json(response, card(mock.base));
    if (request.url === '/a2a/message:send') {
      sends++;
      if (sends === 1) return json(response, {task: {id: 'task-http-1', contextId: 'ctx-http-1', status: {state: 'TASK_STATE_INPUT_REQUIRED', message: {parts: [{text: '请补充目标'}]}}}});
      return json(response, {task: {id: 'task-http-1', contextId: 'ctx-http-1', status: {state: 'TASK_STATE_COMPLETED', message: {parts: [{text: 'HTTP 完成'}]}}, artifacts: [{name: 'http-report', parts: [{text: 'HTTP artifact'}]}]}});
    }
    return json(response, {error: `unexpected ${request.method} ${request.url}`}, 404);
  });
  process.env.A2A_TEST_TOKEN = 'a2a-secret';
  try {
    const outputs: any[] = [];
    for await (const item of runAdapter(context(mock.base, {requestInput: async question => { assert.equal(question, '请补充目标'); return '继续输入'; }}))) outputs.push(item);
    const paths = mock.requests.map(request => request.path);
    assert.deepEqual(paths.slice(0, 2), ['/.well-known/agent-card.json', '/a2a/message:send']);
    assert.equal(mock.requests[1].headers.authorization, 'Bearer a2a-secret');
    assert.equal(mock.requests[1].headers['a2a-version'], '1.0');
    assert.equal(mock.requests[1].body.message.parts[0].text, 'hello');
    assert.ok(mock.requests[1].body.message.metadata['https://temptroom.local/protocol/0.1'].runId === 'run-http');
    assert.deepEqual(mock.requests[2].body.message.taskId, 'task-http-1');
    assert.deepEqual(mock.requests[2].body.message.contextId, 'ctx-http-1');
    assert.equal(mock.requests[2].body.message.parts[0].text, '继续输入');
    assert.ok(outputs.some(output => output.type === 'remote-task' && output.id === 'task-http-1'));
    assert.ok(outputs.some(output => output.type === 'session' && output.id === 'ctx-http-1'));
    assert.ok(outputs.some(output => output.type === 'text' && output.text === 'HTTP 完成'));
    assert.ok(outputs.some(output => output.type === 'artifact' && output.name === 'http-report'));
  } finally {
    delete process.env.A2A_TEST_TOKEN;
    await mock.close();
  }
});

test('A2A HTTP+JSON real wire: abort confirms CancelTask over HTTP', async () => {
  const controller = new AbortController();
  const mock = await startMock((request, response) => {
    if (request.url === '/.well-known/agent-card.json') return json(response, card(mock.base));
    if (request.url === '/a2a/message:send') return json(response, {task: {id: 'task-cancel-1', contextId: 'ctx-cancel', status: {state: 'TASK_STATE_WORKING'}}});
    if (request.url === '/a2a/tasks/task-cancel-1' && request.method === 'GET') return json(response, {id: 'task-cancel-1', status: {state: 'TASK_STATE_WORKING'}});
    if (request.url === '/a2a/tasks/task-cancel-1:cancel') return json(response, {task: {id: 'task-cancel-1', status: {state: 'TASK_STATE_CANCELED'}}});
    return json(response, {error: `unexpected ${request.method} ${request.url}`}, 404);
  });
  setTimeout(() => controller.abort(), 400);
  const iterator = runAdapter(context(mock.base, {signal: controller.signal}));
  await assert.rejects(async () => { for await (const _ of iterator) { /* keep polling */ } }, RemoteCanceled);
  assert.ok(mock.requests.some(request => request.path === '/a2a/tasks/task-cancel-1:cancel' && request.method === 'POST'));
  await mock.close();
});

test('A2A JSONRPC real wire: SendMessage returns a message', async () => {
  const mock = await startMock((request, response) => {
    if (request.url === '/.well-known/agent-card.json') return json(response, card(mock.base, 'JSONRPC'));
    if (request.url === '/a2a') {
      return json(response, {jsonrpc: '2.0', id: 'rpc', result: {message: {contextId: 'ctx-rpc', parts: [{text: 'JSONRPC OK'}]}}});
    }
    return json(response, {error: `unexpected ${request.method} ${request.url}`}, 404);
  });
  const outputs: any[] = [];
  for await (const item of runAdapter(context(mock.base))) outputs.push(item);
  assert.equal(mock.requests[0].path, '/.well-known/agent-card.json');
  assert.equal(mock.requests[1].path, '/a2a');
  assert.equal(mock.requests[1].body.jsonrpc, '2.0');
  assert.equal(mock.requests[1].body.method, 'SendMessage');
  assert.ok(outputs.some(output => output.type === 'session' && output.id === 'ctx-rpc'));
  assert.ok(outputs.some(output => output.type === 'text' && output.text === 'JSONRPC OK'));
  await mock.close();
});
