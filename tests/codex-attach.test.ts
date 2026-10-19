import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { agentSchema, capabilitiesFor, commandSchema, type AgentOutput, type CodexRunState, type Run, type Message } from '../packages/protocol/src/index.ts';
import { runAdapter, diagnose, ExecutionUnknown, RemoteCanceled, type AdapterContext } from '../apps/server/src/adapters.ts';
import { AttachedCodexChannel } from '../apps/server/src/codex-attached-channel.ts';
import { reconcileAttachedRun } from '../apps/server/src/codex-attach.ts';
import { createApp } from '../apps/server/src/app.ts';
import { Store, uid } from '../apps/server/src/store.ts';

async function mockBackend(t: TestContext) {
  const credentialEnv = `ROOM_ATTACH_TEST_${randomBytes(5).toString('hex').toUpperCase()}`;
  const token = randomBytes(24).toString('hex'); process.env[credentialEnv] = token;
  const requests: any[] = [], queue: any[] = [], turns: any[] = [];
  const model = { loaded: true, active: false, cwd: resolve('.'), directInput: true, pin: '0.163.0-test', complete: true, interruptStops: true, clients: 0 };
  let handler: ((frame: any, socket: WebSocket) => boolean | void) | undefined;
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, verifyClient: (info, done) => done(info.req.headers.authorization === `Bearer ${token}`, 401) });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const binding = { transport: 'websocket' as const, endpoint: `ws://127.0.0.1:${(server.address() as any).port}`, credentialEnv, threadId: 'existing-thread', expectedCwd: model.cwd };
  const reply = (socket: WebSocket, frame: any, result: any) => socket.send(JSON.stringify({ id: frame.id, result }));
  const notify = (method: string, params: any) => { for (const socket of server.clients) socket.send(JSON.stringify({ method, params })); };
  server.on('connection', socket => {
    model.clients++;
    socket.on('message', data => {
      const frame = JSON.parse(String(data)); requests.push(frame);
      if (handler?.(frame, socket) || frame.id === undefined) return;
      const params = frame.params;
      switch (frame.method) {
        case 'initialize': reply(socket, frame, { userAgent: `Codex/${model.pin} test` }); break;
        case 'thread/loaded/list': reply(socket, frame, { data: model.loaded ? [binding.threadId] : [], nextCursor: null }); break;
        case 'thread/read': reply(socket, frame, { thread: { id: binding.threadId, cwd: model.cwd, status: { type: model.loaded ? model.active ? 'active' : 'idle' : 'notLoaded' }, canAcceptDirectInput: model.directInput,...(params.includeTurns?{turns}:{} ) } }); break;
        case 'thread/queue/list': reply(socket, frame, { data: queue, nextCursor: null }); break;
        case 'thread/turns/list': reply(socket, frame, { data: [...turns].reverse(), nextCursor: null }); break;
        case 'thread/queue/add': {
          const submission = { id: `submission_${queue.length + turns.length}`, ...params };
          queue.push(submission); reply(socket, frame, { queuedSubmission: submission }); break;
        }
        case 'thread/queue/start': {
          const index = queue.findIndex(item => item.id === params.queuedSubmissionId);
          if (model.active || index < 0) { socket.send(JSON.stringify({ id: frame.id, error: { code: -32600, message: 'busy' } })); break; }
          const submission = queue.splice(index, 1)[0];
          const turn = { id: `turn_${turns.length}`, status: model.complete ? 'completed' : 'inProgress', itemsView: 'full', items: [
            { type: 'userMessage', id: `user_${turns.length}`, clientId: submission.clientUserMessageId, content: submission.input },
            ...(model.complete ? [{ type: 'agentMessage', id: `answer_${turns.length}`, text: 'Own answer' }, { type: 'reasoning', id: 'hidden', text: 'must not publish' }] : [])
          ] };
          turns.push(turn); model.active = !model.complete;
          reply(socket, frame, { turn }); break;
        }
        case 'thread/queue/delete': {
          const index = queue.findIndex(item => item.id === params.queuedSubmissionId);
          if (index >= 0) queue.splice(index, 1);
          reply(socket, frame, {}); break;
        }
        case 'turn/interrupt': {
          const turn = turns.find(item => item.id === params.turnId);
          if (turn && model.interruptStops) { turn.status = 'interrupted'; model.active = false; }
          reply(socket, frame, {}); break;
        }
        default: socket.send(JSON.stringify({ id: frame.id, error: { code: -32601, message: 'unsupported' } }));
      }
    });
  });
  t.after(async () => { delete process.env[credentialEnv]; for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const agent = agentSchema.parse({ id: 'attached', name: 'Attached Codex', provider: 'codex', connectionMode: 'attach', executionMode: 'host', enabled: true, version: model.pin, codexBinding: binding });
  const saved: CodexRunState[] = [];
  const controller = new AbortController();
  const ctx: AdapterContext = { agent, run: { id: uid('run'), roomId: 'room_test', agentId: agent.id, status: 'running', prompt: 'request', basedOnSeq: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, prompt: 'Room-owned request', workspace: model.cwd, home: '', stateRoot: '', host: {} as any, signal: controller.signal, saveCodexState: state => saved.push(state) };
  return { server, binding, agent, requests, queue, turns, model, reply, notify, saved, ctx, controller, intercept: (fn: typeof handler) => { handler = fn; } };
}
async function collect(ctx: AdapterContext) { const outputs: AgentOutput[] = []; for await (const item of runAdapter(ctx)) outputs.push(item); return outputs; }
async function until(check: () => boolean, timeout = 6000) { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw new Error('test wait timed out'); await delay(20); } }

test('attachment configuration rejects wrong providers, sandbox claims, remote URLs and inline credentials', async t => {
  const f = await mockBackend(t), base = { ...f.agent };
  assert.equal(commandSchema.safeParse({ version: '0.1', commandId: 'save', type: 'agent.save', payload: base }).success, true);
  assert.equal(agentSchema.safeParse({ ...base, provider: 'claude' }).success, false);
  assert.equal(agentSchema.safeParse({ ...base, executionMode: 'sandbox' }).success, false);
  for (const endpoint of ['ws://localhost:4500', 'ws://10.0.0.1:4500', 'ws://127.0.0.1:4500/?token=secret', 'ws://secret@127.0.0.1:4500']) assert.equal(agentSchema.safeParse({ ...base, codexBinding: { ...f.binding, endpoint } }).success, false);
  assert.equal(capabilitiesFor('codex', base).input, false);
  assert.equal(capabilitiesFor('codex', base).usage, false);
});
test('read-only diagnosis verifies loaded ownership and cwd, closes only its connection', async t => {
  const f = await mockBackend(t);
  assert.equal((await diagnose(f.agent, {} as any)).ready, true);
  assert.ok(f.requests.every(frame => ['initialize', 'initialized', 'thread/loaded/list', 'thread/read', 'thread/queue/list', 'thread/turns/list'].includes(frame.method)));
  f.model.loaded = false;
  const wrong = await diagnose(f.agent, {} as any); assert.equal(wrong.ready, false); assert.match(wrong.checks.at(-1)!.detail, /未加载/);
  f.model.loaded = true; f.model.cwd = resolve('other-project');
  assert.equal((await diagnose(f.agent, {} as any)).ready, false);
  assert.ok(!f.requests.some(frame => ['thread/resume', 'thread/start'].includes(frame.method)));
});
test('authentication and version mismatches fail before any writes, without leaking token', async t => {
  const f = await mockBackend(t);
  const report = await diagnose({ ...f.agent, version: 'other-version' }, {} as any); assert.equal(report.ready, false);
  const token = process.env[f.binding.credentialEnv]!; process.env[f.binding.credentialEnv] = 'incorrect';
  const rejected = await diagnose(f.agent, {} as any); assert.equal(rejected.ready, false); assert.ok(!JSON.stringify(rejected).includes(token));
  assert.ok(!f.requests.some(frame => frame.method === 'thread/queue/add'));
});
test('queue submissions persist intent first, complete as agent output and never override thread settings', async t => {
  const f = await mockBackend(t);
  f.intercept(frame => { if (frame.method === 'thread/queue/add') assert.equal(f.saved[0]?.phase, 'prepared'); });
  const output = await collect(f.ctx);
  assert.deepEqual(output.filter(item => item.type === 'text'), [{ type: 'text', text: 'Own answer' }]);
  const start = f.requests.find(frame => frame.method === 'thread/queue/start');
  assert.deepEqual(Object.keys(start.params).sort(), ['queuedSubmissionId', 'threadId']);
  assert.equal(f.saved.at(-1)!.phase, 'completed'); assert.equal(f.saved.at(-1)!.nativeStatus, 'completed');
  assert.ok(!f.requests.some(frame => ['thread/resume', 'thread/start', 'turn/start', 'turn/steer'].includes(frame.method)));
  const channel = await AttachedCodexChannel.connect(f.binding); channel.close();
  assert.ok(f.model.clients >= 2); // Existing backend survives an execution and a disconnect.
});
test('busy desktop work stays untouched; only the Room queue item starts after idle', async t => {
  const f = await mockBackend(t); f.model.active = true;
  f.queue.push({ id: 'human-queued', clientUserMessageId: 'human-client', input: [] });
  const pending = collect(f.ctx);
  await until(() => f.saved.some(state => state.phase === 'queued')); await delay(300);
  assert.ok(!f.requests.some(frame => ['thread/queue/start', 'turn/interrupt', 'turn/steer'].includes(frame.method)));
  f.model.active = false; await pending;
  assert.equal(f.queue[0].id, 'human-queued');
  assert.notEqual(f.requests.find(frame => frame.method === 'thread/queue/start').params.queuedSubmissionId, 'human-queued');
});

test('legacy history uses complete thread reads when the backend explicitly lacks turn pagination',async t=>{
  const f=await mockBackend(t);f.intercept((frame,socket)=>{if(frame.method==='thread/turns/list'){socket.send(JSON.stringify({id:frame.id,error:{code:-32601,message:'list_turns is not supported yet'}}));return true;}});
  const output=await collect(f.ctx);assert.equal(output.filter(item=>item.type==='text').map(item=>item.text).join(''),'Own answer');
  assert.ok(f.requests.some(frame=>frame.method==='thread/read'&&frame.params.includeTurns===true));assert.ok(!f.requests.some(frame=>frame.method==='thread/resume'));
});

test('legacy history never treats summary-only items as a confirmed full result',async t=>{
  const f=await mockBackend(t);f.intercept((frame,socket)=>{
    if(frame.method==='thread/turns/list'){socket.send(JSON.stringify({id:frame.id,error:{code:-32601,message:'list_turns is not supported yet'}}));return true;}
    if(frame.method==='thread/read'&&frame.params.includeTurns){f.reply(socket,frame,{thread:{id:f.binding.threadId,turns:[{id:'summary',status:'completed',itemsView:'summary'}]}});return true;}
  });
  await assert.rejects(collect(f.ctx),ExecutionUnknown);assert.notEqual(f.saved.at(-1)?.phase,'completed');
});
test('canceling a busy queued run deletes only its own submission and confirms removal', async t => {
  const f = await mockBackend(t); f.model.active = true;
  f.queue.push({ id: 'human-queued', clientUserMessageId: 'human-client', input: [] });
  const pending = collect(f.ctx); const rejected = assert.rejects(pending, RemoteCanceled);
  await until(() => f.saved.some(state => state.phase === 'queued')); f.controller.abort(); await rejected;
  assert.equal(f.saved.at(-1)!.phase, 'canceled'); assert.equal(f.queue.length, 1); assert.equal(f.queue[0].id, 'human-queued');
  assert.ok(!f.requests.some(frame => frame.method === 'turn/interrupt'));
});
test('canceling an owned active turn interrupts that turn, leaving backend usable', async t => {
  const f = await mockBackend(t); f.model.complete = false;
  const pending = collect(f.ctx), rejected = assert.rejects(pending, RemoteCanceled);
  await until(() => !!f.saved.at(-1)?.nativeTurnId); f.controller.abort(); await rejected;
  assert.equal(f.requests.find(frame => frame.method === 'turn/interrupt').params.turnId, f.saved.at(-1)!.nativeTurnId);
  assert.equal(f.saved.at(-1)!.nativeStatus, 'interrupted');
  const channel = await AttachedCodexChannel.connect(f.binding); channel.close();
});
test('streamed output is scoped by thread and turn, then reconciled without duplication', async t => {
  const f = await mockBackend(t); f.model.complete = false;
  const pending = collect(f.ctx);
  await until(() => !!f.saved.at(-1)?.nativeTurnId);
  const turn = f.turns[0];
  f.notify('item/agentMessage/delta', { threadId: 'other-thread', turnId: turn.id, itemId: 'wrong', delta: 'Wrong room' });
  f.notify('item/agentMessage/delta', { threadId: f.binding.threadId, turnId: 'human-turn', itemId: 'wrong2', delta: 'Human work' });
  f.notify('item/agentMessage/delta', { threadId: f.binding.threadId, turnId: turn.id, itemId: 'answer', delta: 'Own ' });
  await delay(30); turn.items.push({ type: 'agentMessage', id: 'answer', text: 'Own answer' }); turn.status = 'completed';
  const output = await pending;
  assert.equal(output.filter(item => item.type === 'text').map(item => item.text).join(''), 'Own answer');
});
test('a lost queue-add response becomes unknown, preserves the server submission and never sends twice', async t => {
  const f = await mockBackend(t); f.model.active = true;
  f.intercept((frame, socket) => {
    if (frame.method !== 'thread/queue/add') return;
    f.queue.push({ id: 'accepted-without-receipt', ...frame.params }); socket.terminate(); return true;
  });
  await assert.rejects(collect(f.ctx), ExecutionUnknown);
  assert.equal(f.saved.at(-1)!.queuedSubmissionId, 'accepted-without-receipt');
  assert.equal(f.requests.filter(frame => frame.method === 'thread/queue/add').length, 1);
  assert.equal(f.requests.filter(frame => frame.method === 'thread/queue/start').length, 0);
});
test('deltas arriving before the start receipt are buffered until turn ownership is proven',async t=>{
  const f=await mockBackend(t);
  f.intercept((frame,socket)=>{
    if(frame.method!=='thread/queue/start')return;
    const submission=f.queue.splice(0,1)[0],turn={id:'early-turn',status:'inProgress',itemsView:'full',items:[{type:'userMessage',id:'early-user',clientId:submission.clientUserMessageId}] as any[]};
    f.turns.push(turn);
    socket.send(JSON.stringify({method:'item/agentMessage/delta',params:{threadId:f.binding.threadId,turnId:turn.id,itemId:'early-answer',delta:'Early '}}));
    f.reply(socket,frame,{turn});
    const timer=setTimeout(()=>{turn.items.push({type:'agentMessage',id:'early-answer',text:'Early answer'});turn.status='completed';},100);t.after(()=>clearTimeout(timer));return true;
  });
  const output=await collect(f.ctx);
  assert.equal(output.filter(item=>item.type==='text').map(item=>item.text).join(''),'Early answer');
  assert.ok(output.some(item=>item.type==='text'&&item.text==='Early '));
});
test('a lost start receipt is reconciled by clientUserMessageId without starting again', async t => {
  const f = await mockBackend(t);
  f.intercept((frame, socket) => {
    if (frame.method !== 'thread/queue/start') return;
    const submission = f.queue.splice(0, 1)[0];
    f.turns.push({ id: 'accepted-turn', status: 'completed', itemsView: 'full', items: [{ type: 'userMessage', id: 'native-user-item', clientId: submission.clientUserMessageId, content: [] }, { type: 'agentMessage', id: 'recovered', text: 'Recovered answer' }] });
    socket.terminate(); return true;
  });
  const result = await collect(f.ctx);
  assert.equal(result.filter(item => item.type === 'text').map(item => item.text).join(''), 'Recovered answer');
  assert.equal(f.requests.filter(frame => frame.method === 'thread/queue/start').length, 1);
  assert.equal(f.saved.at(-1)!.nativeTurnId, 'accepted-turn');
});
test('missing ownership evidence never permits guessing a turn or resending a write', async t => {
  const f = await mockBackend(t);
  f.intercept((frame, socket) => { if (frame.method !== 'thread/queue/add') return; socket.terminate(); return true; });
  await assert.rejects(collect(f.ctx), ExecutionUnknown);
  assert.equal(f.requests.filter(frame => frame.method === 'thread/queue/add').length, 1);
  assert.ok(!f.requests.some(frame => frame.method === 'turn/interrupt'));
});
test('native automatic queue consumption waits for turn materialization without sending a second start',async t=>{
  const f=await mockBackend(t);
  f.intercept((frame,socket)=>{
    if(frame.method!=='thread/queue/add')return;
    f.reply(socket,frame,{queuedSubmission:{id:'native-auto-consumed',...frame.params}});
    const timer=setTimeout(()=>f.turns.push({id:'automatic-turn',status:'completed',itemsView:'full',items:[{type:'userMessage',id:'auto-user',clientId:frame.params.clientUserMessageId},{type:'agentMessage',id:'auto-answer',text:'Automatic queue answer'}]}),300);
    t.after(()=>clearTimeout(timer));return true;
  });
  const output=await collect(f.ctx);
  assert.equal(output.filter(item=>item.type==='text').map(item=>item.text).join(''),'Automatic queue answer');
  assert.equal(f.saved.at(-1)!.nativeTurnId,'automatic-turn');
  assert.ok(!f.requests.some(frame=>frame.method==='thread/queue/start'));
});
test('stopping the output consumer cancels owned work instead of leaving a hidden native run',async t=>{
  const f=await mockBackend(t);f.model.active=true;
  for await(const _item of runAdapter(f.ctx))break;
  assert.equal(f.saved.at(-1)!.phase,'canceled');assert.equal(f.queue.length,0);
  assert.ok(!f.requests.some(frame=>frame.method==='turn/interrupt'));
});
test('an interrupt receipt without a stopped turn remains unknown and never kills the backend',async t=>{
  const f=await mockBackend(t);f.model.complete=false;f.model.interruptStops=false;
  const pending=collect(f.ctx),rejected=assert.rejects(pending,ExecutionUnknown);
  await until(()=>!!f.saved.at(-1)?.nativeTurnId);f.controller.abort();await rejected;
  assert.equal(f.saved.at(-1)!.phase,'uncertain');assert.equal(f.turns[0].status,'inProgress');
  const channel=await AttachedCodexChannel.connect(f.binding);channel.close();
});
test('diagnosis tolerates only the native unused-thread history response, and handles loaded pagination',async t=>{
  const f=await mockBackend(t);
  f.intercept((frame,socket)=>{
    if(frame.method==='thread/loaded/list'){
      f.reply(socket,frame,frame.params.cursor?{data:[f.binding.threadId],nextCursor:null}:{data:['another'],nextCursor:'second'});return true;
    }
    if(frame.method==='thread/turns/list'){
      socket.send(JSON.stringify({id:frame.id,error:{code:-32600,message:`thread ${f.binding.threadId} is not materialized yet; thread/turns/list is unavailable before first user message`}}));return true;
    }
  });
  assert.equal((await diagnose(f.agent,{} as any)).ready,true);
  assert.ok(f.requests.some(frame=>frame.method==='thread/loaded/list'&&frame.params.cursor==='second'));
});
test('duplicate queue ownership and a thread that cannot accept input are rejected', async t => {
  const f = await mockBackend(t); f.model.directInput = false;
  assert.equal((await diagnose(f.agent, {} as any)).ready, false);
  f.model.directInput = true;
  const state: CodexRunState = { binding: f.binding, clientUserMessageId: 'duplicate', phase: 'uncertain' };
  f.queue.push({ id: 'one', clientUserMessageId: 'duplicate' }, { id: 'two', clientUserMessageId: 'duplicate' });
  await assert.rejects(reconcileAttachedRun(state), /重复/);
});

async function appFixture(t: TestContext, f: Awaited<ReturnType<typeof mockBackend>>) {
  const parent = resolve('.state/test-data'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'codex-attach-'));
  const bundle = await createApp({ root, token: 'attach-fixture-owner', startWorker: false });
  t.after(async () => { await bundle.app.close(); assert.equal(resolve(root).startsWith(parent + '\\') || resolve(root).startsWith(parent + '/'), true); rmSync(root, { recursive: true, force: true }); });
  const { store, service } = bundle, roomId = store.rooms()[0].id;
  const command = (type: any, payload: any, room = roomId) => service.execute({ version: '0.1', commandId: uid(), roomId: room, type, payload });
  command('agent.save', f.agent); command('room.members.set', { members: [f.agent.id] });
  return { ...bundle, root, roomId, command };
}
test('Worker persists native state and posts the final reply under the Agent identity without touching its cwd', async t => {
  const f = await mockBackend(t), a = await appFixture(t, f);
  const marker = join(a.root, 'do-not-commit.txt'); writeFileSync(marker, 'unchanged');
  a.command('message.send', { text: 'test', mentions: [f.agent.id] }); a.worker.tick();
  await until(() => a.store.list<Run>('runs')[0].status === 'completed');
  const run = a.store.list<Run>('runs')[0]; assert.ok(run.codex?.nativeTurnId); assert.equal(run.nativeSessionId, f.binding.threadId); assert.equal(run.sandbox, undefined);
  assert.equal((a.store.db.prepare('SELECT count(*) AS count FROM sessions').get() as any).count,0);
  const answer = a.store.list<Message>('messages').find(message => message.runId === run.id)!;
  assert.deepEqual(answer.actor, { kind: 'agent', id: f.agent.id }); assert.equal(answer.text, 'Own answer');
  assert.equal(existsSync(join(a.root, 'workspaces', 'rooms', a.roomId)), false);
});

test('Worker submits a distinct native queue item for the reconciled generation on the same loaded thread',async t=>{
  const f=await mockBackend(t),a=await appFixture(t,f);let submitted=0;
  f.intercept(frame=>{if(frame.method==='thread/queue/add'&&++submitted===1){const id=a.command('decision.propose',{text:'New criterion during native work'}).result.decisionId;a.command('decision.accept',{decisionId:id});}});
  a.command('message.send',{text:'Original request',mentions:[f.agent.id]});a.worker.tick();
  await until(()=>a.store.list<Run>('runs')[0].status==='completed');
  const run=a.store.list<Run>('runs')[0],adds=f.requests.filter(frame=>frame.method==='thread/queue/add');
  assert.equal(adds.length,2);assert.notEqual(adds[0].params.clientUserMessageId,adds[1].params.clientUserMessageId);
  assert.match(adds[0].params.clientUserMessageId,/_g1$/);assert.match(adds[1].params.clientUserMessageId,/_g2$/);
  assert.equal(adds[0].params.threadId,adds[1].params.threadId);assert.ok(adds[1].params.input[0].text.includes('New criterion during native work'));
  assert.equal(run.contextRound,1);assert.equal(run.generation,2);assert.equal(a.store.list<Message>('messages').filter(message=>message.runId===run.id).length,1);
});
test('Worker serializes one thread across rooms, rejects rebinding, and blocks behind an uncertain native run', async t => {
  const f = await mockBackend(t), a = await appFixture(t, f); f.model.active = true;
  const otherRoom = a.command('room.create', { name: 'another', members: [f.agent.id] }).result.roomId as string;
  a.command('message.send', { text: 'first', mentions: [f.agent.id] });
  a.command('message.send', { text: 'second', mentions: [f.agent.id] }, otherRoom);
  a.worker.tick(); await until(() => f.queue.length === 1); a.worker.tick(); await delay(150);
  assert.equal(f.requests.filter(frame => frame.method === 'thread/queue/add').length, 1);
  assert.throws(() => a.command('agent.save', { ...f.agent, codexBinding: { ...f.binding, threadId: 'another' } }), /先停止并核对/);
  const run = a.store.list<Run>('runs')[0]; a.command('run.cancel', { runId: run.id });
  assert.equal(a.store.get<Run>('runs', run.id)!.status, 'cancel_requested');
  await until(() => a.store.get<Run>('runs', run.id)!.status === 'canceled');
  const uncertain = { ...a.store.list<Run>('runs').find(candidate=>candidate.id!==run.id)!, status: 'unknown' as const, codex: { ...run.codex!, phase: 'uncertain' as const } }; a.store.put('runs', uncertain);
  a.worker.tick(); await delay(100); assert.equal(f.requests.filter(frame => frame.method === 'thread/queue/add').length, 1);
});
test('restart retains queue intent as unknown; explicit recovery confirms completion without resubmission', async t => {
  const f = await mockBackend(t), a = await appFixture(t, f);
  a.command('message.send', { text: 'first', mentions: [f.agent.id] });
  const run = a.store.list<Run>('runs')[0];
  run.codex = { binding: f.binding, clientUserMessageId: 'persisted-client', queuedSubmissionId: 'persisted-queue', phase: 'queued' }; a.store.put('runs', run);
  // A second Store is only ever used on this temporary fixture database.
  const reopened = new Store(join(a.root, 'room.sqlite')); assert.equal(reopened.get<Run>('runs', run.id)!.status, 'unknown'); reopened.close();
  f.turns.push({ id: 'finished-during-restart', status: 'completed', itemsView: 'full', items: [{ type: 'userMessage', id: 'native-user', clientId: 'persisted-client' }, { type: 'agentMessage', id: 'final', text: 'Finished while disconnected' }] });
  const response = await a.app.inject({ method: 'POST', url: `/api/runs/${run.id}/codex/reconcile`, headers: { host: '127.0.0.1:4317', authorization: 'Bearer attach-fixture-owner', 'room-protocol-version': '0.1' }, payload: { cancel: false } });
  assert.equal(response.statusCode, 200, response.body); assert.equal(a.store.get<Run>('runs', run.id)!.status, 'completed');
  const repeated=await a.worker.reconcileCodex(run.id,true);assert.equal(repeated.run!.status,'completed');
  assert.equal(a.store.list<Message>('messages').find(message => message.runId === run.id)!.text, 'Finished while disconnected');
  assert.ok(!f.requests.some(frame => frame.method === 'thread/queue/add'));
});
