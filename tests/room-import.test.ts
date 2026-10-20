import test from 'node:test';
import assert from 'node:assert/strict';
import { planRoomImport } from '../apps/server/src/room-import.ts';

const exported = {
  version: '0.1',
  room: {id: 'room_old', name: 'Original', members: ['demo-planner', 'codex_1'], seq: 9, createdAt: '2026-01-01T00:00:00.000Z'},
  events: [
    {type: 'room.created', payload: {room: {id: 'room_old', name: 'Original', members: []}}},
    {type: 'chat.message.created', payload: {message: {id: 'msg_abc123', roomId: 'room_old', runId: 'run_def456', actor: {id: 'demo-planner', kind: 'agent'}, text: 'room_old is text'}}},
    {type: 'run.created', payload: {run: {id: 'run_def456', roomId: 'room_old', agentId: 'codex_1', taskId: 'task_fff999'}}}
  ]
};

test('room import remaps entity and room ids while preserving agents', () => {
  const plan = planRoomImport(exported, {newRoomId: 'room_new', name: 'Imported', salt: 'salt-1', now: '2026-02-01T00:00:00.000Z'});
  assert.equal(plan.room.id, 'room_new');
  assert.equal(plan.room.name, 'Imported');
  assert.equal(plan.room.seq, 0);
  assert.equal(plan.events.length, 2);
  const message = plan.events.find(event => event.type === 'chat.message.created')!.payload as any;
  assert.notEqual(message.message.id, 'msg_abc123');
  assert.match(message.message.id, /^msg_/);
  assert.notEqual(message.message.runId, 'run_def456');
  assert.equal(message.message.roomId, 'room_new');
  assert.equal(message.message.actor.id, 'demo-planner');
  assert.equal(message.message.text, 'room_old is text');
  const run = plan.events.find(event => event.type === 'run.created')!.payload as any;
  assert.equal(run.run.id, message.message.runId);
  assert.equal(run.run.agentId, 'codex_1');
  assert.match(run.run.taskId, /^task_/);
  assert.equal(plan.remappedIds, 3);
});

test('room import is deterministic per salt and distinct across imports', () => {
  const first = planRoomImport(exported, {newRoomId: 'room_new', salt: 'same'});
  const second = planRoomImport(exported, {newRoomId: 'room_new', salt: 'same'});
  assert.deepEqual(first.events, second.events);
  const third = planRoomImport(exported, {newRoomId: 'room_new', salt: 'different'});
  assert.notDeepEqual(first.events, third.events);
});
test('owner can import an exported room twice without entity collisions', async t => {
  const {mkdtempSync,rmSync,mkdirSync}=await import('node:fs');
  const {join,resolve}=await import('node:path');
  const {createApp}=await import('../apps/server/src/app.ts');
  const {uid}=await import('../apps/server/src/store.ts');
  const parent=resolve('.state/test-data');mkdirSync(parent,{recursive:true});
  const root=mkdtempSync(join(parent,'room-import-integration-'));
  const state=await createApp({root,startWorker:false,token:'import-owner'});
  t.after(async()=>{await state.app.close();rmSync(root,{recursive:true,force:true});});
  const roomId=state.store.rooms()[0].id;
  state.service.execute({version:'0.1',commandId:uid(),roomId,type:'message.send',payload:{text:'portable history'}});
  const headers={host:'127.0.0.1:4317',authorization:'Bearer import-owner','room-protocol-version':'0.1','content-type':'application/json'};
  const exported=await state.app.inject({url:'/api/rooms/'+roomId+'/export',headers});
  assert.equal(exported.statusCode,200);
  const first=await state.app.inject({method:'POST',url:'/api/rooms/import',headers,payload:{export:exported.json(),name:'Imported A'}});
  assert.equal(first.statusCode,200,first.body);
  const second=await state.app.inject({method:'POST',url:'/api/rooms/import',headers,payload:{export:exported.json(),name:'Imported B'}});
  assert.equal(second.statusCode,200,second.body);
  assert.notEqual(first.json().roomId,second.json().roomId);
  const snapshot=await state.app.inject({url:'/api/rooms/'+first.json().roomId+'/snapshot',headers});
  assert.equal(snapshot.statusCode,200);
  assert.ok((snapshot.json().snapshot.messages as {text:string}[]).some(message=>message.text==='portable history'));
  assert.equal((await state.app.inject({url:'/api/rooms/'+roomId+'/snapshot',headers})).statusCode,200);
  assert.equal((await state.app.inject({method:'POST',url:'/api/rooms/import',headers:{host:headers.host,'room-protocol-version':'0.1','content-type':'application/json'},payload:{export:exported.json()}})).statusCode,401);
});
