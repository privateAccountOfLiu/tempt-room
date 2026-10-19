import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {Store,SYSTEM,uid,now} from '../apps/server/src/store.ts';
import {RoomService} from '../apps/server/src/service.ts';
import {Worker} from '../apps/server/src/worker.ts';
import type {Run,AgentDescriptor} from '../packages/protocol/src/index.ts';

function fixture(t:TestContext,options:ConstructorParameters<typeof Worker>[3]={}){
  const base=resolve('.state/test-data');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'recovery-proof-')),store=new Store(join(root,'room.sqlite')),service=new RoomService(store),worker=new Worker(store,service,root,options),roomId=store.rooms()[0].id;
  t.after(async()=>{await worker.close();store.close();rmSync(root,{recursive:true,force:true});});
  store.saveSettings({...store.settings(),autoRetryChatRuns:true,maxAutoRetries:1,recoverInterruptedChatRuns:true});
  return {root,store,service,worker,roomId};
}

test('retry authority comes from the frozen execution effect scope, never the current provider or missing Room writes',t=>{
  const {store,service,worker,roomId}=fixture(t);
  const demo=service.enqueue(roomId,'demo-planner','conversation',store.room(roomId)!.seq);
  assert.equal(demo.effectScope,'conversation-only');
  const nativeAgent=store.get<AgentDescriptor>('agents','claude')!;nativeAgent.enabled=true;store.put('agents',nativeAgent);
  const native=service.enqueue(roomId,'claude','possible shell effects',store.room(roomId)!.seq);
  assert.equal(native.effectScope,'unrestricted');
  // Changing provider after the original failure cannot manufacture proof of no effects.
  store.put('agents',{...nativeAgent,provider:'api'} as AgentDescriptor);
  assert.equal(store.list('operations',roomId).length,0);
  assert.equal((worker as any).shouldAutoRetry({...native,status:'failed',error:'fetch failed'}),false);
  assert.equal((worker as any).shouldAutoRetry({...demo,status:'failed',error:'fetch failed'}),true);
  assert.equal((worker as any).shouldAutoRetry({...demo,effectScope:undefined,status:'failed',error:'fetch failed'}),false);
  const changed=store.get<AgentDescriptor>('agents',demo.agentId)!;store.put('agents',{...changed,provider:'claude'} as AgentDescriptor);
  assert.equal((worker as any).shouldAutoRetry({...demo,status:'failed',error:'fetch failed'}),false);
  assert.throws(()=>store.event(roomId,'run.updated',SYSTEM,{run:{...native,effectScope:'conversation-only'}}),/scope is immutable/);
});

test('restart recovery skips native and unmarked legacy runs, and atomically issues one conversation continuation',t=>{
  const {store,service,worker,roomId}=fixture(t),stamp=now();
  const safe=service.enqueue(roomId,'demo-planner','safe conversation',store.room(roomId)!.seq);
  const unsafe=service.enqueue(roomId,'demo-reviewer','unrestricted',store.room(roomId)!.seq,{effectScope:'unrestricted'});
  const legacy:Run={id:uid('run'),roomId,agentId:'demo-reviewer',status:'queued',prompt:'unmarked legacy',basedOnSeq:store.room(roomId)!.seq,generation:1,createdAt:stamp,updatedAt:stamp};store.event(roomId,'run.created',SYSTEM,{run:legacy});
  for(const source of [safe,unsafe,legacy]){
    const running={...source,status:'running' as const,executionId:uid('execution')};store.event(roomId,'run.started',SYSTEM,{run:running});
    const interrupted={...running,status:'interrupted' as const,generation:2,executionId:undefined};store.event(roomId,'run.recovered',SYSTEM,{run:interrupted});
  }
  (worker as any).recoverInterrupted();(worker as any).recoverInterrupted();
  assert.deepEqual(store.list<Run>('runs',roomId).filter(run=>run.autoRetryOf).map(run=>run.autoRetryOf),[safe.id]);
  assert.equal(store.get<Run>('runs',safe.id)!.recoveryCount,1);assert.equal(store.get<Run>('runs',unsafe.id)!.recoveryCount,undefined);
});

test('failed recovery audit rolls back both the new run and the original retry marker',t=>{
  const {store,service,worker,roomId}=fixture(t),queued=service.enqueue(roomId,'demo-planner','rollback recovery',store.room(roomId)!.seq);
  const running={...queued,status:'running' as const,executionId:uid('execution')};store.event(roomId,'run.started',SYSTEM,{run:running});
  store.event(roomId,'run.recovered',SYSTEM,{run:{...running,status:'interrupted',generation:2,executionId:undefined}});
  const append=store.event.bind(store),before=store.projectionBytes(roomId);
  store.event=(...args)=>{if(args[1]==='audit.recorded'&&String(args[3].action).startsWith('run.recovered:'))throw new Error('fixture audit commit failure');return append(...args);};
  (worker as any).recoverInterrupted();store.event=append;
  assert.equal(store.projectionBytes(roomId),before);assert.equal(store.get<Run>('runs',queued.id)!.recoveryCount,undefined);
  (worker as any).recoverInterrupted();assert.equal(store.list<Run>('runs',roomId).filter(run=>run.autoRetryOf===queued.id).length,1);
});

test('queued conversation authority cannot become a native execution after a provider edit',async t=>{
  let attempts=0;const {store,service,worker,roomId}=fixture(t,{adapter:async function*(){attempts++;yield {type:'text',text:'must not run'};}});
  const run=service.enqueue(roomId,'demo-planner','frozen conversation scope',store.room(roomId)!.seq),agent=store.get<AgentDescriptor>('agents','demo-planner')!;
  store.put('agents',{...agent,provider:'claude'} as AgentDescriptor);worker.start();
  const until=Date.now()+3000;while(store.get<Run>('runs',run.id)!.status!=='failed'&&Date.now()<until)await new Promise(done=>setTimeout(done,25));
  assert.equal(store.get<Run>('runs',run.id)!.status,'failed');assert.match(store.get<Run>('runs',run.id)!.error!,/执行能力已变化/);assert.equal(attempts,0);
  assert.equal(store.list<Run>('runs',roomId).length,1);
});

test('transient retry reservation and audit are atomic and duplicate supervisors cannot enqueue it twice',t=>{
  const {store,service,worker,roomId}=fixture(t),queued=service.enqueue(roomId,'demo-planner','retry once',store.room(roomId)!.seq);
  const failed={...queued,status:'failed' as const,error:'fetch failed'};store.event(roomId,'run.failed',SYSTEM,{run:failed});
  const append=store.event.bind(store),before=store.projectionBytes(roomId);
  store.event=(...args)=>{if(args[1]==='audit.recorded'&&String(args[3].action).startsWith('auto.retry:'))throw new Error('fixture failed retry audit');return append(...args);};
  (worker as any).autoRetry(failed);store.event=append;assert.equal(store.projectionBytes(roomId),before);
  (worker as any).autoRetry(failed);(worker as any).autoRetry(failed);
  assert.equal(store.list<Run>('runs',roomId).filter(run=>run.autoRetryOf===failed.id).length,1);
});
