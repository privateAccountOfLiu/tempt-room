import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Store,uid,SYSTEM,now} from '../apps/server/src/store.ts';
import {RoomService} from '../apps/server/src/service.ts';
import {NativeOperations} from '../apps/server/src/native-operations.ts';
import {NativeEvidenceParser,type NativeEvidence} from '../apps/server/src/native-evidence.ts';
import {executionFence} from '../apps/server/src/execution.ts';
import {Worker} from '../apps/server/src/worker.ts';
import {ExecutionUnknown,NativeExecutionFailed} from '../apps/server/src/errors.ts';
import {HostChannel} from '../apps/server/src/host.ts';
import {nativeExecutionStream} from '../apps/server/src/native-stream.ts';
import type {Run,AgentDescriptor,ToolOperation,AgentOutput} from '../packages/protocol/src/index.ts';

function fixture(t:TestContext,tokenBudget=0){
  const base=resolve('.state/test-data');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'native-operations-')),path=join(root,'room.sqlite'),store=new Store(path),service=new RoomService(store),roomId=store.rooms()[0].id;
  const agent={...store.get<AgentDescriptor>('agents','codex')!,enabled:true,executionMode:'host' as const};store.put('agents',agent);
  store.saveSettings({...store.settings(),tokenBudget});
  const queued=service.enqueue(roomId,agent.id,'native work',store.room(roomId)!.seq),run={...queued,status:'running' as const,executionId:uid('execution'),leaseUntil:new Date(Date.now()+60000).toISOString()};store.event(roomId,'run.started',SYSTEM,{run});
  t.after(()=>{try{store.close();}catch{}rmSync(root,{recursive:true,force:true});});
  return {root,path,store,service,roomId,agent,run,fence:executionFence(run),ledger:new NativeOperations(store)};
}

test('Codex native tool evidence is correlated, deduplicated, bounded metadata without commands or output',()=>{
  const events:NativeEvidence[]=[],parser=new NativeEvidenceParser(value=>events.push(value)),p={threadId:'thread',turnId:'turn',item:{type:'commandExecution',id:'opaque:id/one',command:'PRIVATE_COMMAND',cwd:'PRIVATE_CWD',status:'inProgress'}};
  parser.codex({method:'item/started',params:p});parser.codex({method:'item/started',params:p});
  parser.codex({method:'item/completed',params:{...p,item:{...p.item,status:'completed',aggregatedOutput:'PRIVATE_OUTPUT',exitCode:0,durationMs:3}}});
  parser.codex({method:'item/completed',params:{...p,item:{...p.item,status:'completed'}}});
  assert.equal(events.length,2);assert.equal(events[0].requestHash,events[1].requestHash);assert.equal(events[1].exitCode,0);
  assert.equal(events[1].sessionId,'thread');assert.equal(events[1].turnId,'turn');assert.doesNotMatch(JSON.stringify(events),/PRIVATE/);
  assert.throws(()=>parser.codex({method:'item/completed',params:{...p,item:{...p.item,status:'failed'}}}),/终态回执/);
  assert.throws(()=>parser.codex({method:'item/started',params:{...p,item:{type:'commandExecution'}}}),/有效且有界/);
});

test('Claude records child tool calls and failures without persisting child reasoning or response text',()=>{
  const events:NativeEvidence[]=[],parser=new NativeEvidenceParser(value=>events.push(value));
  parser.claude({type:'system',subtype:'init',session_id:'claude-session'});
  parser.claude({type:'assistant',parent_tool_use_id:'parent',message:{content:[{type:'thinking',thinking:'PRIVATE_REASONING'},{type:'tool_use',id:'call-id',name:'Bash',input:{command:'PRIVATE_COMMAND'}}]}});
  parser.claude({type:'user',message:{content:[{type:'tool_result',tool_use_id:'call-id',is_error:true,content:'PRIVATE_ERROR'}]}});
  assert.deepEqual(events.map(item=>[item.kind,item.phase,item.outcome]),[['Bash','started',undefined],['Bash','completed','failed']]);
  assert.equal(events[0].requestHash,events[1].requestHash);assert.equal(events[1].sessionId,'claude-session');assert.doesNotMatch(JSON.stringify(events),/PRIVATE/);
});

test('ACP sparse tool updates preserve identity and request hash; unknown terminal values remain unknown',()=>{
  const events:NativeEvidence[]=[],parser=new NativeEvidenceParser(value=>events.push(value));
  parser.acp({method:'session/update',params:{sessionId:'session',update:{sessionUpdate:'tool_call',toolCallId:'tool',kind:'execute',status:'in_progress',rawInput:{command:'PRIVATE'}}}});
  parser.acp({method:'session/update',params:{sessionId:'session',update:{sessionUpdate:'tool_call_update',toolCallId:'tool',status:'completed',content:[{text:'PRIVATE_OUTPUT'}]}}});
  parser.acp({method:'session/update',params:{sessionId:'session',update:{sessionUpdate:'tool_call_update',toolCallId:'unknown',status:'future-status'}}});
  assert.equal(events[1].kind,'execute');assert.equal(events[1].requestHash,events[0].requestHash);assert.equal(events[2].phase,'unknown');assert.doesNotMatch(JSON.stringify(events),/PRIVATE/);
});

test('native intent is committed before execution; a crash after a real file write never authorizes another attempt',t=>{
  const f=fixture(t),marker=join(f.root,'effect.txt');
  const recovered={...f.run,status:'interrupted',generation:2,executionId:undefined};f.store.event(f.roomId,'run.recovered',SYSTEM,{run:recovered});f.store.event(f.roomId,'run.requeued',SYSTEM,{run:{...recovered,status:'queued'}});f.store.close();
  const script=join(f.root,'crash.mts'),url=(path:string)=>JSON.stringify(pathToFileURL(resolve(path)).href);
  writeFileSync(script,`import {appendFileSync} from 'node:fs';import {Store,uid,SYSTEM} from ${url('apps/server/src/store.ts')};import {NativeOperations} from ${url('apps/server/src/native-operations.ts')};import {executionFence} from ${url('apps/server/src/execution.ts')};const store=new Store(${JSON.stringify(f.path)}),run=store.get('runs',${JSON.stringify(f.run.id)});run.status='running';run.executionId=uid('execution');store.event(run.roomId,'run.started',SYSTEM,{run});const intent=new NativeOperations(store).begin(executionFence(run),store.get('agents',run.agentId),'PRIVATE_PROMPT');if(store.get('operations',intent.id).status!=='started')throw new Error('intent not committed');appendFileSync(${JSON.stringify(marker)},${JSON.stringify('one\n')});process.exit(77);`);
  const result=spawnSync(process.execPath,['--import','tsx',script],{windowsHide:true,encoding:'utf8',timeout:15000});assert.equal(result.status,77,result.stderr);
  const reopened=new Store(f.path);try{
  const run=reopened.get<Run>('runs',f.run.id)!;assert.equal(run.status,'interrupted');assert.equal(run.generation,3);
  const intent=reopened.list<ToolOperation>('operations',f.roomId)[0];assert.equal(intent.status,'unknown');
  const queued={...run,status:'queued' as const};reopened.event(f.roomId,'run.requeued',SYSTEM,{run:queued});
  const restarted={...queued,status:'running' as const,executionId:uid('execution')};reopened.event(f.roomId,'run.started',SYSTEM,{run:restarted});
  assert.throws(()=>new NativeOperations(reopened).begin(executionFence(restarted),f.agent,'even a changed prompt must not bypass the same input identity'),ExecutionUnknown);
  assert.equal(readFileSync(marker,'utf8'),'one\n');
  const before=reopened.projectionBytes(f.roomId);reopened.rebuildProjections(f.roomId);assert.equal(reopened.projectionBytes(f.roomId),before);
  }finally{reopened.close();}
});

test('native tool receipts are fenced and missing terminal evidence blocks an apparent completed adapter',t=>{
  const f=fixture(t),intent=f.ledger.begin(f.fence,f.agent,'native'),evidence:NativeEvidence={provider:'codex',itemId:'command',kind:'commandExecution',sessionId:'thread',turnId:'turn',phase:'started',requestHash:'a'.repeat(64)};
  f.ledger.observe(intent,evidence);assert.throws(()=>f.ledger.complete(intent),ExecutionUnknown);
  f.ledger.observe(intent,{...evidence,phase:'completed',outcome:'failed',exitCode:1});f.ledger.complete(intent);
  const operations=f.store.list<ToolOperation>('operations',f.roomId);assert.equal(operations.length,2);assert.equal(operations[1].status,'completed');assert.equal((operations[1].result as any).outcome,'failed');
  const recovered={...f.run,status:'interrupted',generation:2,executionId:undefined};f.store.event(f.roomId,'run.recovered',SYSTEM,{run:recovered});const seq=f.store.room(f.roomId)!.seq;
  assert.throws(()=>f.ledger.observe(intent,{...evidence,itemId:'late'}),(error:any)=>error.code==='stale_generation');assert.equal(f.store.room(f.roomId)!.seq,seq);
});

test('Worker records before invoking a native adapter and rejects text when a tool result remains unknown',async t=>{
  const f=fixture(t);let calls=0;
  const worker=new Worker(f.store,f.service,f.root,{adapter:async function*(ctx){
    calls++;assert.equal(f.store.list<ToolOperation>('operations',f.roomId)[0].native!.scope,'execution');
    ctx.onNativeEvidence!({provider:'codex',kind:'commandExecution',itemId:'missing-result',phase:'started',requestHash:'b'.repeat(64)});
    yield {type:'text',text:'Unproven success'};
  }});t.after(()=>worker.close());
  const attempt=(worker as any).consumeAttempt(f.run,new AbortController(),{agent:f.agent,workspace:f.root,home:f.root,scope:'fixture',prompt:'native input',hostMode:true,attached:false});
  await assert.rejects(attempt,ExecutionUnknown);assert.equal(calls,1);
  assert.ok(f.store.list<ToolOperation>('operations',f.roomId).every(operation=>operation.status==='unknown'));
  assert.equal(f.store.list('messages',f.roomId).some((message:any)=>message.text==='Unproven success'),false);
});

test('a structured native terminal failure preserves a known failed receipt after cleanup',async t=>{
  const f=fixture(t),worker=new Worker(f.store,f.service,f.root,{adapter:async function*(){throw new NativeExecutionFailed('structured native failure');yield {type:'text',text:'unreachable'};}});t.after(()=>worker.close());
  await assert.rejects((worker as any).consumeAttempt(f.run,new AbortController(),{agent:f.agent,workspace:f.root,home:f.root,scope:'fixture',prompt:'native input',hostMode:true,attached:false}),NativeExecutionFailed);
  const intent=f.store.list<ToolOperation>('operations',f.roomId)[0];assert.equal(intent.status,'completed');assert.equal((intent.result as any).outcome,'failed');
});

test('only matching full native history can reconcile old-generation intent and tool receipts',t=>{
  const f=fixture(t),agent={...f.agent,connectionMode:'attach' as const,codexBinding:{transport:'control-socket' as const,endpoint:resolve('mock.sock'),credentialEnv:'',threadId:'native-thread',expectedCwd:f.root}},intent=f.ledger.begin(f.fence,agent,'native');
  const evidence:NativeEvidence={provider:'codex',sessionId:'native-thread',turnId:'native-turn',kind:'commandExecution',itemId:'command-id',phase:'started',requestHash:'a'.repeat(64)};f.ledger.observe(intent,evidence);f.ledger.abandon(intent);
  const recovered:Run={...f.run,generation:2,executionId:undefined,status:'unknown',codex:{binding:agent.codexBinding,clientUserMessageId:intent.native!.clientUserMessageId!,nativeTurnId:'native-turn',nativeStatus:'completed',phase:'completed'}};f.store.event(f.roomId,'run.recovered',SYSTEM,{run:recovered});
  const turn={id:'native-turn',status:'completed',itemsView:'full',items:[{id:'command-id',type:'commandExecution',status:'completed'}]};
  assert.throws(()=>f.ledger.reconcileCodex(recovered,{...turn,itemsView:'summary'}),ExecutionUnknown);
  const before=f.store.projectionBytes(f.roomId);assert.throws(()=>f.ledger.reconcileCodex(recovered,{...turn,id:'foreign-turn'}),ExecutionUnknown);assert.equal(f.store.projectionBytes(f.roomId),before);
  f.ledger.reconcileCodex(recovered,turn);assert.ok(f.store.list<ToolOperation>('operations',f.roomId).every(operation=>operation.status==='completed'));
  assert.ok(f.store.list<ToolOperation>('operations',f.roomId).every(operation=>operation.generation===1));
  const settled=f.store.projectionBytes(f.roomId);f.store.rebuildProjections(f.roomId);assert.equal(f.store.projectionBytes(f.roomId),settled);
});

test('native reconciliation cannot convert Room operations or erase provider provenance',t=>{
  const f=fixture(t),intent=f.ledger.begin(f.fence,f.agent,'native');
  assert.throws(()=>f.store.event(f.roomId,'operation.unknown',SYSTEM,{operation:{...intent,status:'unknown',native:undefined}}),/provenance/);
  const proof={threadId:'wrong',turnId:'wrong',clientUserMessageId:'wrong',status:'completed',itemsView:'full'};
  assert.throws(()=>f.store.event(f.roomId,'operation.reconciled',SYSTEM,{operation:{...intent,status:'completed'},proof}),/verified recovery binding/);
  assert.equal(f.store.get<ToolOperation>('operations',intent.id)!.status,'started');
});

test('a native evidence persistence failure stops the host channel instead of becoming ignored stdout',async()=>{
  const child=spawn(process.execPath,['-e',"console.log(JSON.stringify({method:'fixture/tool',params:{}}));setInterval(()=>{},1000)"],{windowsHide:true,stdio:'pipe'}),channel=new HostChannel(child,'evidence-storage-failure');
  channel.onFrame=()=>{throw new Error('fixture receipt commit failed');};
  try{
    await assert.rejects((async()=>{for await(const _frame of channel.frames){}})(),/fixture receipt commit failed/);
    await channel.terminate();assert.equal(channel.ended,true);
  }finally{await channel.terminate();channel.dispose();}
});

test('native budget failure closes the real owned process before returning and preserves the budget error type',async t=>{
  const f=fixture(t,1);let channel:HostChannel|undefined,settled=false;
  const worker=new Worker(f.store,f.service,f.root,{adapter:ctx=>nativeExecutionStream(ctx.signal,async(signal,output)=>{
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'pipe'});channel=new HostChannel(child,'budget-child');
    const abort=()=>{void channel!.terminate();};signal.addEventListener('abort',abort,{once:true});
    try{output.push({type:'usage',usage:{inputTokens:2,outputTokens:0}});await channel.exit;}
    finally{signal.removeEventListener('abort',abort);await channel.terminate();channel.dispose();settled=true;}
  })});t.after(async()=>{if(channel)await channel.terminate();await worker.close();});
  await assert.rejects((worker as any).consumeAttempt(f.run,new AbortController(),{agent:f.agent,workspace:f.root,home:f.root,scope:'fixture',prompt:'native budget test',hostMode:true,attached:false}),(error:any)=>error.constructor.name==='BudgetExceeded'&&/Token 预算/.test(error.message));
  assert.equal(settled,true);assert.equal(channel!.ended,true);assert.equal(f.store.list<ToolOperation>('operations',f.roomId)[0].status,'unknown');
});
