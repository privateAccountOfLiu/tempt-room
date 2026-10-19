import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {Store,SYSTEM,uid,DATABASE_VERSION} from '../apps/server/src/store.ts';
import {RoomService} from '../apps/server/src/service.ts';
import {Worker} from '../apps/server/src/worker.ts';
import {discussionSummaryPrompt} from '../apps/server/src/discussions.ts';
import {parseDiscussionReply,commandSchema,type Discussion,type Run,type Artifact,type AgentDescriptor,type Message} from '../packages/protocol/src/index.ts';
import type {AdapterContext} from '../apps/server/src/adapters.ts';

function fixture(t:TestContext,adapter?:(ctx:AdapterContext)=>AsyncIterable<any>){
  const parent=resolve('.state/test-data');mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'convergence-'));
  const store=new Store(join(root,'room.sqlite')),service=new RoomService(store),worker=new Worker(store,service,root,{adapter}),roomId=store.rooms()[0].id;
  let closed=false;t.after(async()=>{await worker.close();if(!closed)store.close();rmSync(root,{recursive:true,force:true});});
  const command=(type:string,payload:unknown,commandId=uid())=>service.execute({version:'0.1',commandId,roomId,type,payload});
  const start=(extra:Record<string,unknown>={})=>{const receipt=command('discussion.start',{goal:'Design a reliable feature',participants:['demo-planner','demo-reviewer'],rounds:1,maxResponses:10,stopOnConvergence:true,...extra});return receipt.result.discussionId as string;};
  const discussion=(id:string)=>store.get<Discussion>('discussions',id)!;
  const round=(id:string)=>store.list<Run>('runs',roomId).filter(r=>r.discussionId===id&&r.round===discussion(id).round&&r.discussionRole!=='summary');
  const finish=(run:Run,text?:string,status:Run['status']='completed')=>{
    store.atomic(()=>{run.status='running';run.executionId=uid('exec');store.event(roomId,'run.started',SYSTEM,{run});if(text)worker.publishFinalMessage(run,text);worker.finish(run,status);});
  };
  const ballot=(id:string,agree=false,proposal=discussion(id).consensus?.text??'A complete proposal',proposalId:string|null=discussion(id).consensus?.proposalId??null)=>`Normal discussion.\n\n\`\`\`room-consensus\n${JSON.stringify({proposalId,agree,proposal})}\n\`\`\``;
  const wait=async(check:()=>boolean)=>{const end=Date.now()+12000;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,15));}assert.fail('Worker did not settle: '+JSON.stringify(store.list<Run>('runs')));};
  return {root,store,service,worker,roomId,command,start,discussion,round,finish,ballot,wait,closeStore:()=>{store.close();closed=true;}};
}

test('convergence ignores round limit and waits for unanimous explicit confirmation of one proposal',t=>{
  const f=fixture(t),id=f.start({quorum:1}),first=f.round(id);
  f.finish(first[1],f.ballot(id));assert.equal(f.discussion(id).round,1);assert.equal(f.store.get<Run>('runs',first[0].id)!.status,'queued');
  f.finish(first[0],f.ballot(id));assert.equal(f.discussion(id).round,2);assert.equal(f.discussion(id).status,'active');
  const second=f.round(id);f.finish(second[0],f.ballot(id,true));assert.equal(f.discussion(id).status,'active');f.finish(second[1],f.ballot(id,true));
  const d=f.discussion(id);assert.equal(d.endReason,'converged');assert.equal(d.status,'completed');assert.equal(d.responses,4);assert.equal(d.consensus?.agreedBy.length,2);assert.equal(d.summary,undefined);assert.equal(f.store.list('artifacts').length,0);
  assert.ok(f.store.list<Message>('messages').every(m=>!m.text.includes('room-consensus')));
  const bytes=f.store.projectionBytes(f.roomId);f.store.rebuildProjections(f.roomId);assert.equal(f.store.projectionBytes(f.roomId),bytes);
});

test('dissent replaces the candidate; old IDs, changed text and unstructured agreement do not converge',t=>{
  const f=fixture(t),id=f.start();for(const r of f.round(id))f.finish(r,f.ballot(id));
  const old=f.discussion(id).consensus!.proposalId,second=f.round(id);
  f.finish(second[0],f.ballot(id,true));f.finish(second[1],f.ballot(id,false,'A revised complete proposal'));
  assert.notEqual(f.discussion(id).consensus!.proposalId,old);assert.equal(f.discussion(id).consensus!.agreedBy.length,0);
  const third=f.round(id);f.finish(third[0],f.ballot(id,true,'A complete proposal',old));f.finish(third[1],'I agree. 大家已经达成共识。');assert.equal(f.discussion(id).status,'active');
  const fourth=f.round(id);f.finish(fourth[0],f.ballot(id,true,'Changed despite saying agree'));f.finish(fourth[1],f.ballot(id,true));assert.equal(f.discussion(id).status,'active');
  for(const r of f.round(id))f.finish(r,f.ballot(id,true));assert.equal(f.discussion(id).endReason,'converged');
});

test('summary includes alternative proposals kept in control records as well as visible chat',t=>{
  const f=fixture(t),id=f.start(),first=f.round(id);f.finish(first[0],f.ballot(id,false,'First full proposal'));f.finish(first[1],f.ballot(id,false,'Alternative full proposal'));
  for(const r of f.round(id))f.finish(r,f.ballot(id,true));
  const prompt=discussionSummaryPrompt(f.store,f.discussion(id));assert.ok(prompt.includes('First full proposal'));assert.ok(prompt.includes('Alternative full proposal'));
});

test('missing votes, failure and a partial last round stop at response cap without claiming convergence',t=>{
  const f=fixture(t),id=f.start({maxResponses:5,quorum:1});for(const r of f.round(id))f.finish(r,f.ballot(id));
  const second=f.round(id);f.finish(second[0],f.ballot(id,true));f.finish(second[1],undefined,'failed');assert.equal(f.discussion(id).status,'active');
  const last=f.round(id);assert.equal(last.length,1);f.finish(last[0],f.ballot(id,true));assert.equal(f.discussion(id).endReason,'response_limit');assert.notEqual(f.discussion(id).consensus!.agreedBy.length,2);
});

test('new user requirements during a round invalidate an otherwise unanimous old confirmation',t=>{
  const f=fixture(t),id=f.start();for(const r of f.round(id))f.finish(r,f.ballot(id));const second=f.round(id);
  f.finish(second[0],f.ballot(id,true));f.command('message.send',{text:'Also require an offline mode'});f.finish(second[1],f.ballot(id,true));
  assert.equal(f.discussion(id).status,'active');assert.equal(f.discussion(id).round,3);assert.equal(f.discussion(id).consensus!.agreedBy.length,0);
});

test('only a single trailing valid ballot is recognized',()=>{
  const valid='```room-consensus\n'+JSON.stringify({proposalId:null,agree:false,proposal:'Plan'})+'\n```';
  assert.ok(parseDiscussionReply(valid).ballot);assert.equal(parseDiscussionReply(valid+'\nOther text').ballot,undefined);
  assert.equal(parseDiscussionReply(valid+'\n'+valid).ballot,undefined);assert.equal(parseDiscussionReply(valid.replace('false','"yes"')).ballot,undefined);
  assert.equal(parseDiscussionReply('Everyone agrees').ballot,undefined);
});

test('legacy discussion commands do not gain new default fields that change receipt hashes',()=>{
  const command=commandSchema.parse({version:'0.1',commandId:'legacy',roomId:'room_1',type:'discussion.start',payload:{goal:'Goal',participants:['demo-planner']}});
  assert.equal(Object.hasOwn(command.payload,'stopOnConvergence'),false);assert.equal(Object.hasOwn(command.payload,'summarizerId'),false);
});

test('one separate summary run creates exactly one linked Markdown artifact, with complete discussion history',async t=>{
  let summaryPrompt='';
  const f=fixture(t,async function*(ctx){
    if(ctx.run.discussionRole==='summary'){summaryPrompt=ctx.prompt;yield {type:'text',text:'# Full discussion summary\nWe reached a conclusion.'};yield {type:'artifact',name:'extra',text:'Do not duplicate me',mediaType:'text/plain'};}
    else{yield {type:'text',text:'This reply must not become an artifact.'};yield {type:'artifact',name:'ignored',text:'No summary selected yet',mediaType:'text/plain'};}
  });
  f.command('settings.update',{...f.store.settings(),maxContextMessages:1});
  const id=f.start({stopOnConvergence:false,rounds:1,maxResponses:2,summarizerId:'demo-reviewer'}),first=f.round(id);
  f.finish(first[0],'FIRST_COMPLETE_RECORD '+ 'x'.repeat(8000));f.finish(first[1],'LAST_COMPLETE_RECORD');
  assert.equal(f.discussion(id).summary?.status,'queued');assert.equal(f.store.list('artifacts').length,0);
  const summary=f.store.get<Run>('runs',f.discussion(id).summary!.runId!)!;assert.equal(summary.round,undefined);assert.equal(summary.discussionRole,'summary');
  f.worker.start();await f.wait(()=>f.discussion(id).summary?.status==='completed');
  assert.ok(summaryPrompt.includes('FIRST_COMPLETE_RECORD'));assert.ok(summaryPrompt.includes('x'.repeat(8000)));assert.ok(summaryPrompt.includes('LAST_COMPLETE_RECORD'));
  const artifacts=f.store.list<Artifact>('artifacts');assert.equal(artifacts.length,1);assert.equal(artifacts[0].discussionId,id);assert.equal(artifacts[0].runId,summary.id);assert.equal(artifacts[0].mediaType,'text/markdown');
  assert.match(readFileSync(join(f.root,'artifacts',artifacts[0].id),'utf8'),/Full discussion summary/);assert.equal(f.discussion(id).responses,2);
  f.service.settleDiscussion(f.store.get<Run>('runs',summary.id)!);assert.equal(f.store.list('artifacts').length,1);
  const bytes=f.store.projectionBytes(f.roomId);f.store.rebuildProjections(f.roomId);assert.equal(f.store.projectionBytes(f.roomId),bytes);
});

test('unset summarizer suppresses participant artifact outputs and does not schedule a summary',async t=>{
  const f=fixture(t,async function*(){yield {type:'text',text:'Discussion only'};yield {type:'artifact',name:'not allowed',text:'report',mediaType:'text/plain'};});
  const id=f.start({stopOnConvergence:false,rounds:1,maxResponses:2});f.worker.start();await f.wait(()=>f.discussion(id).status==='completed');
  assert.equal(f.store.list('artifacts').length,0);assert.equal(f.store.list('runs').length,2);assert.equal(f.discussion(id).summary,undefined);
});

test('summary failures are visible, do not rerun automatically, and starting/stopping is idempotent',async t=>{
  let calls=0;const f=fixture(t,async function*(){calls++;throw new Error('Summary fixture failed');});
  const id=f.start({summarizerId:'demo-reviewer',stopOnConvergence:false,rounds:1});for(const r of f.round(id))f.finish(r,'Completed reply');
  f.worker.start();await f.wait(()=>f.discussion(id).summary?.status==='failed');assert.equal(calls,1);assert.match(f.discussion(id).summary!.error!,/fixture failed/);assert.equal(f.store.list('artifacts').length,0);
  f.command('discussion.stop',{discussionId:id});assert.equal(f.store.list<Run>('runs').filter(r=>r.discussionRole==='summary').length,1);
});

test('an explicit summary retry keeps its frozen transcript and produces only the replacement artifact',async t=>{
  let calls=0;const f=fixture(t,async function*(){if(++calls===1)throw new Error('First summary failed');yield {type:'text',text:'# Retried summary'};});
  // The summarizer need not be a debate participant.
  const id=f.start({participants:['demo-planner'],summarizerId:'demo-reviewer',stopOnConvergence:false,rounds:1,maxResponses:1});f.finish(f.round(id)[0],'Original frozen reply');
  const original=f.discussion(id).summary!.runId!;f.worker.start();await f.wait(()=>f.discussion(id).summary?.status==='failed');
  f.command('message.send',{text:'FOLLOWUP_OUTSIDE_DISCUSSION'});
  const retry=f.command('run.retry',{runId:original},'summary_retry');const again=f.command('run.retry',{runId:original},'summary_retry');assert.deepEqual(retry,again);
  const replacement=f.store.get<Run>('runs',retry.result.runId as string)!;assert.equal(replacement.discussionRole,'summary');assert.equal(replacement.discussionId,id);assert.equal(replacement.prompt,f.store.get<Run>('runs',original)!.prompt);assert.ok(!replacement.prompt.includes('FOLLOWUP_OUTSIDE_DISCUSSION'));
  await f.wait(()=>f.discussion(id).summary?.status==='completed');assert.equal(calls,2);assert.equal(f.store.list('artifacts').length,1);assert.equal(f.discussion(id).summary!.runId,replacement.id);
});

test('empty summaries fail without a fabricated artifact',async t=>{
  const f=fixture(t,async function*(){}),id=f.start({participants:['demo-planner'],summarizerId:'demo-reviewer',stopOnConvergence:false,rounds:1});f.finish(f.round(id)[0],'Some discussion');
  f.worker.start();await f.wait(()=>f.discussion(id).summary?.status==='failed');assert.equal(f.store.list('artifacts').length,0);assert.match(f.discussion(id).summary!.error!,/没有返回报告正文/);
});

test('running summary cancellation waits for adapter termination and publishes no artifact',async t=>{
  let entered=false,exited=false;
  const f=fixture(t,async function*(ctx){entered=true;await new Promise<void>(resolve=>{if(ctx.signal.aborted)resolve();else ctx.signal.addEventListener('abort',()=>resolve(),{once:true});});exited=true;ctx.signal.throwIfAborted();});
  const id=f.start({participants:['demo-planner'],summarizerId:'demo-reviewer',stopOnConvergence:false,rounds:1});f.finish(f.round(id)[0],'Some discussion');f.worker.start();await f.wait(()=>entered);
  f.command('discussion.stop',{discussionId:id});assert.equal(f.discussion(id).summary?.status,'queued');await f.wait(()=>f.discussion(id).summary?.status==='canceled');assert.equal(exited,true);assert.equal(f.store.list('artifacts').length,0);
});

test('next-round scheduling failure preserves accepted replies and cancels partial enqueues',t=>{
  const f=fixture(t),id=f.start(),round=f.round(id);f.finish(round[0],f.ballot(id));
  const reviewer=f.store.get<AgentDescriptor>('agents','demo-reviewer')!;f.command('agent.save',{...reviewer,enabled:false});f.finish(round[1],f.ballot(id));
  const d=f.discussion(id);assert.equal(d.endReason,'scheduling_failed');assert.equal(d.responses,3);assert.equal(d.status,'stopped');
  assert.equal(f.store.list<Run>('runs').filter(r=>r.status==='completed').length,2);assert.ok(f.store.list<Run>('runs').every(r=>['completed','canceled'].includes(r.status)));
});

test('manual stop and deadline still produce a summary; stopping the summary cancels without scheduling another',async t=>{
  const f=fixture(t),id=f.start({summarizerId:'demo-reviewer'});f.finish(f.round(id)[0],'Partial discussion result');
  f.command('discussion.stop',{discussionId:id});assert.equal(f.discussion(id).endReason,'user_stop');assert.equal(f.discussion(id).summary?.status,'queued');
  f.command('discussion.stop',{discussionId:id});await f.wait(()=>f.discussion(id).summary?.status==='canceled');assert.equal(f.store.list('artifacts').length,0);
  const id2=f.start({summarizerId:'demo-reviewer'}),d=f.discussion(id2);d.deadline=new Date(Date.now()-1000).toISOString();f.store.put('discussions',d);f.worker.tick();
  assert.equal(f.discussion(id2).endReason,'time_limit');assert.equal(f.store.list<Run>('runs').filter(r=>r.discussionId===id2&&r.discussionRole==='summary').length,1);
});

test('summary validation rejects an external or absent agent and summary queue failure preserves completed replies',t=>{
  const f=fixture(t);assert.throws(()=>f.start({summarizerId:'missing'}),/不在此房间/);
  const agent=f.store.get<AgentDescriptor>('agents','demo-reviewer')!;f.command('agent.save',{...agent,connectionMode:'external'});
  assert.throws(()=>f.start({participants:['demo-planner'],summarizerId:agent.id}),/托管成员/);
  f.command('agent.save',agent);const id=f.start({summarizerId:'demo-reviewer',stopOnConvergence:false,rounds:1});
  f.finish(f.round(id)[0],'First result');f.command('agent.save',{...agent,enabled:false});f.finish(f.round(id)[1],'Last result');
  assert.equal(f.discussion(id).status,'completed');assert.equal(f.discussion(id).summary?.status,'failed');assert.match(f.discussion(id).summary!.error!,/尚未启用/);assert.equal(f.store.list<Run>('runs').filter(r=>r.status==='completed').length,2);
});

test('restart preserves facts, interrupts pending summary and never resubmits it; v8 upgrade makes a backup',async t=>{
  const f=fixture(t),id=f.start({summarizerId:'demo-reviewer',stopOnConvergence:false,rounds:1});for(const r of f.round(id))f.finish(r,'Reply');
  const summaryId=f.discussion(id).summary!.runId!;f.store.db.exec('PRAGMA user_version=8');f.closeStore();
  const reopened=new Store(join(f.root,'room.sqlite'));try{
    assert.equal((reopened.db.prepare('PRAGMA user_version').get() as any).user_version,DATABASE_VERSION);
    assert.ok(readdirSync(f.root).some(n=>n.includes('.v8.')&&n.endsWith('.bak')));
    assert.equal(reopened.get<Discussion>('discussions',id)!.summary?.status,'interrupted');assert.equal(reopened.get<Run>('runs',summaryId)!.status,'canceled');
    const bytes=reopened.projectionBytes(f.roomId);reopened.rebuildProjections(f.roomId);assert.equal(reopened.projectionBytes(f.roomId),bytes);
  }finally{reopened.close();}
});

test('oversized complete transcript fails visibly instead of silently summarizing a truncated history',t=>{
  const f=fixture(t);f.command('settings.update',{...f.store.settings(),contextPolicy:{maxLag:10000,maxRounds:3,maxDeltaBytes:1048576}});const id=f.start({stopOnConvergence:false,rounds:1});for(const r of f.round(id))f.finish(r,'Long reply '+ 'x'.repeat(550000));
  assert.throws(()=>discussionSummaryPrompt(f.store,f.discussion(id)),/超过 1 MiB/);
});
