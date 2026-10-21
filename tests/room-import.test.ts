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
  const {mkdtempSync,rmSync,mkdirSync,writeFileSync}=await import('node:fs');
  const {join,resolve}=await import('node:path');
  const {createApp}=await import('../apps/server/src/app.ts');
  const {uid,digest}=await import('../apps/server/src/store.ts');
  const parent=resolve('.state/test-data');mkdirSync(parent,{recursive:true});
  const root=mkdtempSync(join(parent,'room-import-integration-'));
  const state=await createApp({root,startWorker:false,token:'import-owner'});
  t.after(async()=>{await state.app.close();rmSync(root,{recursive:true,force:true});});
  const roomId=state.store.rooms()[0].id;
  state.service.execute({version:'0.1',commandId:uid(),roomId,type:'message.send',payload:{text:'portable history'}});
  const artifact={id:'artifact_import1',roomId,name:'report.txt',kind:'file',mediaType:'text/plain',size:5,createdAt:new Date().toISOString()};
  mkdirSync(join(root,'artifacts'),{recursive:true});writeFileSync(join(root,'artifacts',artifact.id),'hello');
  state.store.event(roomId,'artifact.created',{id:'owner',kind:'human'}, {artifact});
  const headers={host:'127.0.0.1:4317',authorization:'Bearer import-owner','room-protocol-version':'0.1','content-type':'application/json'};
  const exported=await state.app.inject({url:'/api/rooms/'+roomId+'/export?includeArtifacts=1',headers});
  assert.equal(exported.statusCode,200);
  const first=await state.app.inject({method:'POST',url:'/api/rooms/import',headers,payload:{export:exported.json(),name:'Imported A'}});
  assert.equal(first.statusCode,200,first.body);
  const second=await state.app.inject({method:'POST',url:'/api/rooms/import',headers,payload:{export:exported.json(),name:'Imported B'}});
  assert.equal(second.statusCode,200,second.body);
  assert.notEqual(first.json().roomId,second.json().roomId);
  assert.equal(first.json().importedArtifacts,1);
  const importedSnapshot=(await state.app.inject({url:'/api/rooms/'+first.json().roomId+'/snapshot',headers})).json();
  const importedArtifact=importedSnapshot.snapshot.artifacts.find((item:{name:string})=>item.name==='report.txt');
  assert.ok(importedArtifact);
  const downloaded=await state.app.inject({url:'/api/artifacts/'+importedArtifact.id,headers});
  assert.equal(downloaded.statusCode,200);
  assert.equal(downloaded.body,'hello');
  const tampered=(exported.json() as any);tampered.exportHash='0'.repeat(64);
  const badHash=await state.app.inject({method:'POST',url:'/api/rooms/import',headers,payload:{export:tampered}});
  assert.equal(badHash.statusCode,400);
  const badArtifact=(exported.json() as any),replacement=[{...badArtifact.artifacts[0],contentBase64:Buffer.from('tampered').toString('base64')},...badArtifact.artifacts.slice(1)];
  badArtifact.artifacts=replacement;badArtifact.exportHash=digest({room:badArtifact.room,events:badArtifact.events,artifactHashes:replacement.map((item:any)=>[item.artifact.id,item.contentHash])});
  const tamperedImport=await state.app.inject({method:'POST',url:'/api/rooms/import',headers,payload:{export:badArtifact}});
  assert.equal(tamperedImport.statusCode,200,tamperedImport.body);
  assert.equal(tamperedImport.json().importedArtifacts,0);
  assert.equal(tamperedImport.json().artifactIntegrityFailures,1);
  const snapshot=await state.app.inject({url:'/api/rooms/'+first.json().roomId+'/snapshot',headers});
  assert.equal(snapshot.statusCode,200);
  assert.ok((snapshot.json().snapshot.messages as {text:string}[]).some(message=>message.text==='portable history'));
  assert.equal((await state.app.inject({url:'/api/rooms/'+roomId+'/snapshot',headers})).statusCode,200);
  assert.equal((await state.app.inject({method:'POST',url:'/api/rooms/import',headers:{host:headers.host,'room-protocol-version':'0.1','content-type':'application/json'},payload:{export:exported.json()}})).statusCode,401);
});

test('room import remaps basedOnSeq and context seq references after skipped room events', () => {
  const sequenced = {
    room: {id: 'room_old', name: 'Seq room', members: [], seq: 4},
    events: [
      {seq: 1, type: 'room.created', payload: {room: {id: 'room_old'}}},
      {seq: 2, type: 'chat.message.created', payload: {message: {id: 'msg_seq123', roomId: 'room_old', text: 'hi'}}},
      {seq: 3, type: 'run.created', payload: {run: {id: 'run_seq456', roomId: 'room_old', basedOnSeq: 2}}},
      {seq: 4, type: 'run.context.advanced', payload: {run: {id: 'run_seq456', roomId: 'room_old', contextSeq: 3}, delta: {fromSeq: 1, throughSeq: 3, headSeq: 3}}}
    ]
  };
  const plan = planRoomImport(sequenced, {newRoomId: 'room_newseq', salt: 'seq-salt'});
  assert.deepEqual(plan.seqMap, {'1': 0, '2': 1, '3': 2, '4': 3});
  const run = plan.events.find(event => event.type === 'run.created')!.payload as any;
  assert.equal(run.run.basedOnSeq, 1);
  const advanced = plan.events.find(event => event.type === 'run.context.advanced')!.payload as any;
  assert.equal(advanced.run.contextSeq, 2);
  assert.equal(advanced.delta.fromSeq, 0);
  assert.equal(advanced.delta.throughSeq, 2);
  assert.equal(advanced.delta.headSeq, 2);
});

test('importing a tombstoned room creates a fresh active identity and drops deletion facts', () => {
  const deletion = {requestedAt: '2026-01-02T00:00:00.000Z', requestedBy: 'owner', commandId: 'delete_old', deletedAt: '2026-01-02T00:01:00.000Z', pendingReasons: []};
  const deleted = {
    version: '0.1',
    room: {id: 'room_dead', name: 'Deleted source', members: [], seq: 4, revision: 3, status: 'deleted', deletion, createdAt: '2026-01-01T00:00:00.000Z'},
    events: [
      {type: 'room.created', payload: {room: {id: 'room_dead'}}},
      {type: 'room.deleting', payload: {room: {id: 'room_dead', status: 'deleting', revision: 2, deletion}}},
      {type: 'room.deletion.updated', payload: {room: {id: 'room_dead', status: 'deleting', revision: 2, deletion}}},
      {type: 'room.deleted', payload: {room: {id: 'room_dead', status: 'deleted', revision: 3, deletion}}},
      {type: 'chat.message.created', payload: {message: {id: 'msg_life123', roomId: 'room_dead', actor: {id: 'owner', kind: 'human'}, text: 'surviving history'}}}
    ]
  };
  const plan = planRoomImport(deleted, {newRoomId: 'room_fresh', name: 'Fresh', salt: 'import-lifecycle'});
  assert.equal(plan.room.id, 'room_fresh');
  assert.equal(plan.room.status, 'active');
  assert.equal(plan.room.revision, 1);
  assert.equal(plan.room.deletion, undefined);
  assert.ok(!plan.events.some(event => ['room.deleting', 'room.deletion.updated', 'room.deleted'].includes(event.type)));
  const message = plan.events.find(event => event.type === 'chat.message.created')!.payload as any;
  assert.equal(message.message.roomId, 'room_fresh');
  assert.equal(message.message.text, 'surviving history');
});
