import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {Store,SYSTEM,uid,now} from '../apps/server/src/store.ts';
import {RoomService} from '../apps/server/src/service.ts';
import {Worker} from '../apps/server/src/worker.ts';
import {contextDelta,assertContextCurrent,advanceContext} from '../apps/server/src/context-reconciliation.ts';
import {captureContext,runContext} from '../apps/server/src/context.ts';
import {executionFence} from '../apps/server/src/execution.ts';
import {ToolOperations} from '../apps/server/src/tool-operations.ts';
import {terminalStates,contextSeqOf,type Run,type Message,type Artifact} from '../packages/protocol/src/index.ts';
import type {AdapterContext} from '../apps/server/src/adapters.ts';

function fixture(t:TestContext,adapter?:(ctx:AdapterContext)=>AsyncIterable<any>){
  const parent=resolve('.state/test-data');mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'context-')),store=new Store(join(root,'room.sqlite')),service=new RoomService(store),worker=new Worker(store,service,root,{adapter}),roomId=store.rooms()[0].id;
  t.after(async()=>{await worker.close();store.close();rmSync(root,{recursive:true,force:true});});
  const command=(type:any,payload:any)=>service.execute({version:'0.1',commandId:uid(),roomId,type,payload});
  const start=()=>{command('task.create',{title:'Original task',agentId:'demo-planner'});const run=store.list<Run>('runs',roomId).at(-1)!;run.status='running';run.executionId=uid('execution');store.event(roomId,'run.started',SYSTEM,{run});return run;};
  const decision=(text='New accepted decision')=>{const id=command('decision.propose',{text}).result.decisionId;command('decision.accept',{decisionId:id});};
  const done=async()=>{const deadline=Date.now()+8000;while(Date.now()<deadline){const run=store.list<Run>('runs',roomId)[0];if(run&&terminalStates.has(run.status))return run;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Worker did not settle: '+JSON.stringify(store.list<Run>('runs')));};
  return {root,store,service,worker,roomId,command,start,decision,done};
}

test('accepted decisions and addressed messages force reconciliation, while ordinary short history does not',t=>{
  const f=fixture(t),run=f.start();f.command('message.send',{text:'ordinary'});assert.equal(contextDelta(f.store,run),undefined);
  f.service.execute({version:'0.1',commandId:uid(),roomId:f.roomId,type:'message.send',payload:{text:'Please review this',mentions:[run.agentId]}},{id:'demo-reviewer',kind:'agent'});
  assert.ok(contextDelta(f.store,run)!.reasons.includes('mention'));
  f.decision();assert.ok(contextDelta(f.store,run)!.reasons.includes('decision'));
  assert.throws(()=>assertContextCurrent(f.store,run),(e:any)=>e.code==='context_outdated');
});

test('own progress and tool facts cannot form a self-triggering reconciliation loop',t=>{
  const f=fixture(t),run=f.start();for(let i=0;i<90;i++)f.store.event(f.roomId,'run.tool.completed',SYSTEM,{runId:run.id,name:'read',success:true});
  f.worker.publishMessage(run,'Own progress');assert.equal(contextDelta(f.store,run),undefined);
  f.command('message.send',{text:'Ordinary new information after long work'});assert.ok(contextDelta(f.store,run)!.reasons.includes('lag'));
});

test('a complete bounded prefix never acknowledges omitted context',t=>{
  const f=fixture(t);f.command('settings.update',{...f.store.settings(),contextPolicy:{maxLag:1,maxRounds:6,maxDeltaBytes:4096}});const run=f.start();
  for(let i=0;i<7;i++)f.command('message.send',{text:`Message ${i}: `+'a'.repeat(1000)});
  const delta=contextDelta(f.store,run)!;assert.equal(delta.hasMore,true);assert.ok(delta.throughSeq<delta.headSeq);assert.ok(delta.changes.every(change=>change.seq<=delta.throughSeq));
  const next=advanceContext(f.store,run,delta);assert.equal(next.contextSeq,delta.throughSeq);assert.equal(next.basedOnSeq,run.basedOnSeq);assert.equal(next.contextId,run.contextId);assert.ok(contextDelta(f.store,next));
});

test('oversized changes and event gaps reject publication instead of skipping unread facts',t=>{
  const f=fixture(t);f.command('settings.update',{...f.store.settings(),contextPolicy:{maxLag:1,maxRounds:3,maxDeltaBytes:4096}});const run=f.start();
  f.command('message.send',{text:'a'.repeat(6000)});assert.throws(()=>contextDelta(f.store,run),(e:any)=>e.code==='context_change_too_large');
  f.store.db.exec('DROP TRIGGER events_no_delete');f.store.db.prepare('DELETE FROM events WHERE room_id=? AND seq=?').run(f.roomId,run.basedOnSeq+1);
  assert.throws(()=>contextDelta(f.store,run),(e:any)=>e.code==='context_history_gap');
});

test('context advancement creates a new fenced input without rewriting the dispatch snapshot',t=>{
  const f=fixture(t),run=f.start(),original=f.store.get('contexts',run.contextId!)!;f.decision();
  const delta=contextDelta(f.store,run)!,next=advanceContext(f.store,run,delta);
  assert.equal(next.generation,2);assert.notEqual(next.executionId,run.executionId);assert.equal(next.contextPending,true);assert.deepEqual(f.store.get('contexts',run.contextId!),original);
  assert.ok(runContext(f.store,next).decisions.some(decision=>decision.text==='New accepted decision'));
  assert.throws(()=>f.worker.publishMessage(run,'Old generation'),(e:any)=>e.code==='stale_generation');
  assert.throws(()=>f.store.put('runs',{...next,contextSeq:next.contextSeq!+1} as Run),/context event/);
  const bytes=f.store.projectionBytes(f.roomId);f.store.rebuildProjections(f.roomId);assert.equal(f.store.projectionBytes(f.roomId),bytes);
});

test('stale write tools are rejected before reserving or repeating an operation',t=>{
  const f=fixture(t),run=f.start();f.decision();let effects=0;
  assert.throws(()=>new ToolOperations(f.store).execute(executionFence(run),'stale_write','fixture',{},()=>{effects++;}),(e:any)=>e.code==='context_outdated');
  assert.equal(effects,0);assert.equal(f.store.list('operations').length,0);
  assert.throws(()=>f.worker.publishFinalMessage(run,'Old result'),(e:any)=>e.code==='context_outdated');
});

test('the real Worker completes a new fenced turn and only publishes its reconciled result and artifacts',async t=>{
  const attempts:AdapterContext[]=[];let f:ReturnType<typeof fixture>;
  f=fixture(t,async function*(ctx){attempts.push(ctx);yield {type:'session',id:'same-native-session'};
    if(attempts.length===1){yield {type:'usage',usage:{inputTokens:10,costUsd:0.01,scope:'run'}};yield {type:'text',text:'Old proposal'};yield {type:'artifact',name:'old.txt',text:'Old artifact',mediaType:'text/plain'};f.decision('Use the new criterion');}
    else {assert.ok(ctx.prompt.includes('Use the new criterion'));assert.ok(ctx.prompt.includes('Old proposal'));assert.equal(ctx.nativeSession,'same-native-session');yield {type:'usage',usage:{inputTokens:20,costUsd:0.02,scope:'run'}};yield {type:'text',text:'Reconciled proposal'};yield {type:'artifact',name:'final.txt',text:'Reconciled artifact',mediaType:'text/plain'};}
  });
  f.command('task.create',{title:'Original task',agentId:'demo-planner'});f.worker.tick();const run=await f.done();
  assert.equal(run.status,'completed');assert.equal(attempts.length,2);assert.equal(run.generation,2);assert.equal(run.contextRound,1);assert.equal(run.contextPending,false);assert.equal(run.contextConfirmedSeq,run.contextSeq);
  assert.equal(run.usageByGeneration!['1'].costUsd,0.01);assert.equal(run.usageByGeneration!['2'].costUsd,0.02);
  assert.notEqual(attempts[0].executionId,attempts[1].executionId);assert.equal(attempts[0].workspace,attempts[1].workspace);
  const messages=f.store.list<Message>('messages',f.roomId).filter(message=>message.runId===run.id);assert.deepEqual(messages.map(message=>message.text),['Reconciled proposal']);assert.equal(messages[0].basedOnSeq,contextSeqOf(run));
  assert.deepEqual(f.store.list<Artifact>('artifacts').map(artifact=>artifact.name),['final.txt']);
  const bytes=f.store.projectionBytes(f.roomId);f.store.rebuildProjections(f.roomId);assert.equal(f.store.projectionBytes(f.roomId),bytes);
});

test('workspace edits survive reconciliation and are not replaced by a fresh project snapshot',async t=>{
  let count=0;let f:ReturnType<typeof fixture>;
  f=fixture(t,async function*(ctx){count++;const path=join(ctx.workspace,'answer.txt');
    if(count===1){writeFileSync(path,'first execution');f.decision();yield {type:'text',text:'First draft'};}
    else {assert.equal(readFileSync(path,'utf8'),'first execution');writeFileSync(path,'reconciled execution');yield {type:'text',text:'Final draft'};}
  });
  const project=join(f.root,'project');mkdirSync(project);writeFileSync(join(project,'answer.txt'),'original');f.command('task.create',{title:'Task',agentId:'demo-planner',projectPath:project});f.worker.tick();const run=await f.done();
  assert.equal(run.status,'completed');assert.equal(count,2);assert.equal(readFileSync(join(project,'answer.txt'),'utf8'),'original');assert.ok(f.store.list<Artifact>('artifacts').some(artifact=>artifact.kind==='patch'));
});

test('continuous changes exhaust the configured context budget without accepting stale success',async t=>{
  let count=0;let f:ReturnType<typeof fixture>;
  f=fixture(t,async function*(){count++;yield {type:'text',text:'Candidate '+count};f.decision('Changed '+count);});
  f.command('settings.update',{...f.store.settings(),contextPolicy:{maxLag:64,maxRounds:1,maxDeltaBytes:262144}});f.command('task.create',{title:'Task',agentId:'demo-planner'});f.worker.tick();const run=await f.done();
  assert.equal(count,2);assert.equal(run.status,'failed');assert.ok(run.error!.includes('对账轮次上限'));assert.equal(f.store.list<Message>('messages').filter(message=>message.final).length,0);
});

test('zero extra rounds rejects stale success without starting another model turn',async t=>{
  let count=0;let f:ReturnType<typeof fixture>;
  f=fixture(t,async function*(){count++;yield {type:'text',text:'Candidate'};f.decision();});
  f.command('settings.update',{...f.store.settings(),contextPolicy:{maxLag:64,maxRounds:0,maxDeltaBytes:262144}});f.command('task.create',{title:'Task',agentId:'demo-planner'});f.worker.tick();const run=await f.done();
  assert.equal(count,1);assert.equal(run.status,'failed');assert.equal(run.generation,1);assert.equal(f.store.list<Message>('messages').filter(message=>message.final).length,0);
});

test('legacy queued work adopts a zero-extra-turn policy while retaining stale-result checks',async t=>{
  let count=0;let f:ReturnType<typeof fixture>;
  f=fixture(t,async function*(){count++;yield {type:'text',text:'Legacy candidate'};f.decision();});
  const run:Run={id:uid('run'),roomId:f.roomId,agentId:'demo-planner',status:'queued',prompt:'Legacy request',basedOnSeq:f.store.room(f.roomId)!.seq,createdAt:now(),updatedAt:now()};
  f.store.event(f.roomId,'run.created',SYSTEM,{run});f.worker.tick();const result=await f.done();
  assert.equal(count,1);assert.equal(result.contextPolicy!.maxRounds,0);assert.equal(result.status,'failed');
});

test('historical context members are taken from the requested room watermark',t=>{
  const f=fixture(t),seq=f.store.room(f.roomId)!.seq;f.command('room.members.set',{members:['demo-planner']});
  assert.ok(captureContext(f.store,f.roomId,seq).members.length>1);assert.equal(captureContext(f.store,f.roomId,f.store.room(f.roomId)!.seq).members.length,1);
});

test('legacy settings edits preserve the selected context budget instead of silently enabling extra model turns',t=>{
  const f=fixture(t);f.command('settings.update',{...f.store.settings(),contextPolicy:{maxLag:64,maxRounds:0,maxDeltaBytes:262144}});
  const {contextPolicy,...legacy}=f.store.settings();f.command('settings.update',{...legacy,concurrency:1});
  assert.equal(f.store.settings().contextPolicy.maxRounds,0);assert.equal(f.store.settings().concurrency,1);
});
