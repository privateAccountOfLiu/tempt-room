import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {Store,SYSTEM,uid} from '../apps/server/src/store.ts';
import {RoomService} from '../apps/server/src/service.ts';
import {Worker} from '../apps/server/src/worker.ts';
import {runDrafts,appendDraftStream} from '../apps/web/src/run-drafts.ts';
import {PARTIAL_MAX_BYTES,terminalStates,type Run,type Message} from '../packages/protocol/src/index.ts';
function fixture(t:TestContext){
  const parent=resolve('.state/test-data');mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'partial-')),store=new Store(join(root,'room.sqlite')),service=new RoomService(store),worker=new Worker(store,service,root),roomId=store.rooms()[0].id;
  t.after(async()=>{await worker.close();store.close();rmSync(root,{recursive:true,force:true});});
  const command=(type:any,payload:any)=>service.execute({version:'0.1',commandId:uid(),roomId,type,payload});
  const start=(task=false)=>{
    if(task)command('task.create',{title:'Task',agentId:'demo-planner'});else command('message.send',{text:'Request',mentions:['demo-planner']});
    const run=store.list<Run>('runs',roomId).at(-1)!;run.status='running';run.executionId=uid('execution');store.event(roomId,'run.started',SYSTEM,{run});return run;
  };
  return {root,store,service,worker,roomId,command,start};
}

test('partial facts only update progress; the final reply replaces the current draft exactly once',t=>{
  const f=fixture(t),run=f.start(),count=f.store.list('messages').length,partial=f.worker.publishPartial(run,'Draft','stream',0)!;
  assert.equal(f.store.list('messages').length,count);assert.equal(f.store.events(f.roomId).at(-1)!.type,'run.partial');assert.equal(f.store.events(f.roomId).at(-1)!.baseSeq,run.basedOnSeq);
  f.worker.publishFinalMessage(run,'Final','stream');f.worker.finish(run,'completed');
  const current=f.store.get<Run>('runs',run.id)!,message=f.store.get<Message>('messages','stream')!;
  assert.equal(current.partial!.id,partial.id);assert.equal(message.final,true);assert.equal(message.supersedes,partial.id);assert.equal(current.finalMessageId,message.id);
  const seq=f.store.room(f.roomId)!.seq;f.worker.publishFinalMessage(current,'Final','stream');assert.equal(f.store.room(f.roomId)!.seq,seq);
  assert.equal(f.store.list('messages').length,count+1);assert.equal(runDrafts([current],[message],{}).length,0);
  const bytes=f.store.projectionBytes(f.roomId);f.store.rebuildProjections(f.roomId);assert.equal(f.store.projectionBytes(f.roomId),bytes);
});

test('partial rate limiting is persistent and direct event writes cannot bypass it',t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});const f=fixture(t),run=f.start(),first=f.worker.publishPartial(run,'First','stream',0)!,seq=f.store.room(f.roomId)!.seq;
  assert.equal(f.worker.publishPartial(run,'Too soon','stream',1),undefined);assert.equal(f.store.room(f.roomId)!.seq,seq);
  const payload={runId:run.id,baseSeq:run.basedOnSeq,generation:1,executionId:run.executionId,partial:{...first,id:'too_fast',supersedes:first.id}};
  assert.throws(()=>f.store.event(f.roomId,'run.partial',SYSTEM,payload),/rate limit/);assert.equal(f.store.room(f.roomId)!.seq,seq);
  t.mock.timers.tick(2000);const second=f.worker.publishPartial(run,'Second','stream',1)!;assert.equal(second.supersedes,first.id);
  assert.throws(()=>f.store.event(f.roomId,'run.partial',SYSTEM,{...payload,partial:{...second,id:'bad_chain',supersedes:'missing'}}),/chain/);
  const before=f.store.projectionBytes(f.roomId);f.store.rebuildProjections(f.roomId);assert.equal(f.store.projectionBytes(f.roomId),before);
});

test('drafts have a UTF-8 byte bound and cannot be injected through ordinary run updates',t=>{
  const f=fixture(t),run=f.start(),partial=f.worker.publishPartial(run,'中'.repeat(40000),'stream',0)!;
  assert.ok(Buffer.byteLength(partial.text)<=PARTIAL_MAX_BYTES);assert.equal(partial.truncated,true);assert.ok(!partial.text.endsWith('\ufffd'));
  const seq=f.store.room(f.roomId)!.seq;
  assert.throws(()=>f.store.event(f.roomId,'run.partial',SYSTEM,{runId:run.id,baseSeq:0,generation:1,executionId:run.executionId,partial:{...partial,id:'oversized',supersedes:partial.id,text:'a'.repeat(PARTIAL_MAX_BYTES+1)}}),/schema/);
  assert.equal(f.store.room(f.roomId)!.seq,seq);
  const stored=f.store.get<Run>('runs',run.id)!;
  assert.throws(()=>f.store.event(f.roomId,'run.updated',SYSTEM,{run:{...stored,partial:{...stored.partial,text:'Injected replacement'}}}),/own event/);
  const other=f.start();assert.throws(()=>f.store.event(f.roomId,'run.updated',SYSTEM,{run:{...other,partial}}),/own event/);
});

test('old generation drafts and finals with an incorrect supersedes head roll back without a chat row',t=>{
  const f=fixture(t),run=f.start(),partial=f.worker.publishPartial(run,'Draft','stream',0)!,seq=f.store.room(f.roomId)!.seq;
  const final={id:'bad_final',roomId:f.roomId,actor:{id:run.agentId,kind:'agent'},text:'Final',mentions:[],attachments:[],createdAt:new Date().toISOString(),runId:run.id,generation:1,executionId:run.executionId,final:true,supersedes:'wrong_head'};
  assert.throws(()=>f.store.event(f.roomId,'chat.message.created',SYSTEM,{message:final}),/supersede/);assert.equal(f.store.room(f.roomId)!.seq,seq);
  const current=f.store.get<Run>('runs',run.id)!;current.generation=2;delete current.executionId;current.status='interrupted';f.store.event(f.roomId,'run.recovered',SYSTEM,{run:current});
  const before=f.store.projectionBytes(f.roomId);
  assert.throws(()=>f.worker.publishPartial(run,'Old','stream',1),(e:any)=>e.code==='stale_generation');
  assert.throws(()=>f.store.event(f.roomId,'run.partial',SYSTEM,{runId:run.id,baseSeq:run.basedOnSeq,generation:1,executionId:run.executionId,partial:{...partial,id:'old_draft',supersedes:partial.id}}),/Stale partial/);
  assert.equal(f.store.projectionBytes(f.roomId),before);assert.equal(f.store.get('messages','bad_final'),undefined);
});

test('new lifecycle runs require started evidence and cannot resurrect a completed result',t=>{
  const f=fixture(t);f.command('message.send',{text:'queued',mentions:['demo-planner']});const run=f.store.list<Run>('runs')[0];
  assert.throws(()=>f.store.put('runs',{...run,status:'completed'} as Run),/queued -> completed/);
  assert.throws(()=>f.store.put('runs',{...run,status:'running'} as Run),/requires run.started/);
  run.status='running';run.executionId=uid('execution');f.store.event(f.roomId,'run.started',SYSTEM,{run});f.worker.finish(run,'completed');
  assert.throws(()=>f.store.put('runs',{...run,status:'running'} as Run),/completed -> running/);
  assert.throws(()=>f.store.put('runs',{...run,lifecycleVersion:undefined} as Run),/cannot be removed/);
});

test('terminal unknown results require explicit reconciliation and interrupted work requires requeue',t=>{
  const f=fixture(t),run=f.start();f.worker.finish(run,'unknown');
  assert.throws(()=>f.store.put('runs',{...run,status:'completed'} as Run),/unknown -> completed/);
  f.worker.finish(run,'completed',undefined,true);assert.equal(f.store.get<Run>('runs',run.id)!.status,'completed');
  const other=f.start();f.worker.finish(other,'interrupted');
  assert.throws(()=>f.store.event(f.roomId,'run.started',SYSTEM,{run:{...other,status:'running'}}),/interrupted -> running/);
});

test('goal revision preserves the old draft and only confirmed termination becomes superseded',t=>{
  const f=fixture(t),run=f.start(true),partial=f.worker.publishPartial(run,'Old goal draft','stream',0)!;
  f.command('task.revise',{taskId:run.taskId,title:'New goal'});
  assert.equal(f.store.get<Run>('runs',run.id)!.status,'cancel_requested');assert.equal(f.store.get<Run>('runs',run.id)!.stopReason,'superseded');
  assert.throws(()=>f.worker.publishFinalMessage(run,'Late old goal'),(e:any)=>e.code==='stale_task_version');
  f.worker.finish(run,'canceled');const old=f.store.get<Run>('runs',run.id)!;
  assert.equal(old.status,'superseded');assert.equal(old.partial!.id,partial.id);assert.equal(runDrafts([old],[],{})[0].text,'Old goal draft');
  assert.ok(terminalStates.has('superseded'));assert.equal(f.store.list<Run>('runs').at(-1)!.status,'queued');
});

test('ordinary history leaves work active, a new addressed request replaces chat work, and explicit stop remains cancellation',t=>{
  const f=fixture(t),run=f.start();f.command('message.send',{text:'Additional history'});assert.equal(f.store.get<Run>('runs',run.id)!.status,'running');
  f.command('message.send',{text:'New request',mentions:[run.agentId]});assert.equal(f.store.get<Run>('runs',run.id)!.stopReason,'superseded');f.worker.finish(run,'canceled');assert.equal(f.store.get<Run>('runs',run.id)!.status,'superseded');
  const next=f.store.list<Run>('runs').at(-1)!;f.command('run.cancel',{runId:next.id});assert.equal(f.store.get<Run>('runs',next.id)!.status,'canceled');
});

test('unknown termination never becomes a claimed successful supersession',t=>{
  const f=fixture(t),run=f.start();f.service.cancel(run,'superseded');f.worker.finish(run,'unknown','Process exit not confirmed');
  const current=f.store.get<Run>('runs',run.id)!;assert.equal(current.status,'unknown');assert.equal(current.stopReason,'superseded');
});

test('an MCP-posted answer is finalized without a duplicate chat message or lingering draft',t=>{
  const f=fixture(t),run=f.start();f.worker.publishPartial(run,'Draft','stream',0);f.worker.publishMessage(run,'Shared answer','posted');
  f.worker.publishFinalMessage(run,'Shared answer','stream');const current=f.store.get<Run>('runs',run.id)!,messages=f.store.list<Message>('messages',f.roomId);
  assert.equal(messages.filter(message=>message.runId===run.id).length,1);assert.equal(current.finalMessageId,'posted');assert.equal(f.store.get<Message>('messages','posted')!.supersedes,current.partial!.id);assert.equal(runDrafts([current],messages,{}).length,0);
});

test('a draft with a gap in transient chunks restores from the durable checkpoint instead of inventing missing text',t=>{
  const f=fixture(t),run=f.start();f.worker.publishPartial(run,'Saved checkpoint','stream',4);const current=f.store.get<Run>('runs',run.id)!;
  const gap={stream:{runId:run.id,text:'missing-prefix-tail',fromIndex:8,index:9}};assert.equal(runDrafts([current],[],gap)[0].text,'Saved checkpoint');assert.equal(runDrafts([current],[],gap)[0].live,false);
  const full={stream:{runId:run.id,text:'Full live text',fromIndex:0,index:8}};assert.equal(runDrafts([current],[],full)[0].text,'Full live text');
  current.status='canceled';assert.equal(runDrafts([current],[],full)[0].text,'Saved checkpoint');
});

test('a transient gap after initially contiguous output stops treating the stream as complete',t=>{
  const f=fixture(t),run=f.start();f.worker.publishPartial(run,'Saved','stream',0);const current=f.store.get<Run>('runs',run.id)!;
  let streams=appendDraftStream({},{messageId:'stream',runId:run.id,index:0,text:'First'});
  const same=appendDraftStream(streams,{messageId:'stream',runId:run.id,index:0,text:'duplicate'});assert.equal(same,streams);
  streams=appendDraftStream(streams,{messageId:'stream',runId:run.id,index:2,text:'After lost chunk'});
  assert.equal(streams.stream.fromIndex,-1);assert.equal(runDrafts([current],[],streams)[0].text,'Saved');
});

test('committed drafts survive actual child-process death and replay without appearing as chat messages',t=>{
  const f=fixture(t),storeUrl=pathToFileURL(resolve('apps/server/src/store.ts')).href,serviceUrl=pathToFileURL(resolve('apps/server/src/service.ts')).href,workerUrl=pathToFileURL(resolve('apps/server/src/worker.ts')).href;
  const source=`import{Store}from ${JSON.stringify(storeUrl)};import{RoomService}from ${JSON.stringify(serviceUrl)};import{Worker}from ${JSON.stringify(workerUrl)};const store=new Store(${JSON.stringify(join(f.root,'room.sqlite'))}),service=new RoomService(store),worker=new Worker(store,service,${JSON.stringify(f.root)});service.execute({version:'0.1',commandId:'child',roomId:${JSON.stringify(f.roomId)},type:'message.send',payload:{text:'child',mentions:['demo-planner']}});const run=store.list('runs')[0];run.executionId='child_execution';run.status='running';store.event(run.roomId,'run.started',{id:'system',kind:'system'},{run});worker.publishPartial(run,'Surviving draft','stream',0);process.exit(73);`;
  const child=spawnSync(process.execPath,['--import','tsx/esm','--input-type=module','-e',source],{cwd:resolve('.'),windowsHide:true,encoding:'utf8',timeout:20000});assert.equal(child.status,73,child.stderr);
  const reopened=new Store(join(f.root,'room.sqlite'));
  try{const run=reopened.list<Run>('runs')[0];assert.equal(run.status,'interrupted');assert.equal(run.generation,2);assert.equal(run.partial!.text,'Surviving draft');assert.ok(!reopened.list<Message>('messages').some(message=>message.actor.kind==='agent'));const bytes=reopened.projectionBytes(f.roomId);reopened.rebuildProjections(f.roomId);assert.equal(reopened.projectionBytes(f.roomId),bytes);}finally{reopened.close();}
});
