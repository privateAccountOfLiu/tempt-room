import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,mkdtempSync,readdirSync,rmSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { defaultExecutionSettings,type AgentDescriptor,type Discussion,type Run,type RunContext,type Task,type Message } from '../packages/protocol/src/index.ts';
import { Store,uid,SYSTEM } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { createApp } from '../apps/server/src/app.ts';
import { dependencyInputs } from '../apps/server/src/dependencies.ts';
import {captureContext} from '../apps/server/src/context.ts';

function fixture(t:TestContext){
 const parent=resolve('.state/test-data');mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'settings-')),store=new Store(join(root,'room.sqlite')),service=new RoomService(store),roomId=store.rooms()[0].id;
 t.after(()=>{try{store.close();}catch{}assert.ok(root.startsWith(parent+'\\')||root.startsWith(parent+'/'));rmSync(root,{recursive:true,force:true});});
 const command=(type:any,payload:any,id=uid())=>service.execute({version:'0.1',commandId:id,roomId,type,payload});
 return {store,service,roomId,root,command};
}
test('execution settings persist and new runs keep their creation-time resource limits',t=>{
 const {store,command,root}=fixture(t);assert.deepEqual(store.settings(),defaultExecutionSettings);
 command('message.send',{text:'first',mentions:['demo-planner']});const first=store.list<Run>('runs')[0];
 const settings={...defaultExecutionSettings,concurrency:1,memoryMb:2048,maxProcesses:16,taskTimeoutMs:120000,chatTimeoutMs:60000,taskLeaseMs:600000,tokenBudget:5000,costBudgetUsd:0.25};command('settings.update',settings);
 command('task.create',{title:'second',agentId:'demo-reviewer'});const second=store.list<Run>('runs')[1];
 assert.deepEqual(first.limits,{memoryMb:4096,maxProcesses:64,timeoutMs:300000,tokenBudget:0,costBudgetUsd:0});assert.deepEqual(second.limits,{memoryMb:2048,maxProcesses:16,timeoutMs:120000,tokenBudget:5000,costBudgetUsd:0.25});
 assert.throws(()=>command('settings.update',{...settings,network:'private'}));
 store.close();const reopened=new Store(join(root,'room.sqlite'));assert.deepEqual(reopened.settings(),settings);assert.deepEqual(reopened.get<Run>('runs',first.id)?.limits,first.limits);reopened.close();
});
test('agents cannot change execution settings or accept their own task proposals',t=>{
 const {store,service,roomId,command}=fixture(t),actor={id:'demo-planner',kind:'agent'} as const;
 const proposal=service.execute({version:'0.1',commandId:uid(),roomId,type:'task.create',payload:{title:'proposed',agentId:'demo-reviewer'}},actor);
 assert.equal(store.list('runs').length,0);
 assert.throws(()=>service.execute({version:'0.1',commandId:uid(),roomId,type:'settings.update',payload:defaultExecutionSettings},actor),/无权/);
 assert.throws(()=>service.execute({version:'0.1',commandId:uid(),roomId,type:'task.accept',payload:{taskId:proposal.result.taskId}},actor),/无权/);
 command('task.accept',{taskId:proposal.result.taskId,projectPath:resolve('explicit-project')},'accept_once');
 command('task.accept',{taskId:proposal.result.taskId,projectPath:resolve('explicit-project')},'accept_once');
 const task=store.get<Task>('tasks',proposal.result.taskId as string)!;assert.equal(task.version,1);assert.equal(task.status,'queued');assert.equal(store.list('runs').length,1);
 assert.equal(task.projectPath,resolve('explicit-project'));assert.throws(()=>command('task.accept',{taskId:task.id}),/等待确认/);
});
test('queued context is immutable and accepted decisions survive beyond the recent event window',t=>{
 const {store,command,roomId}=fixture(t);
 const decision=command('decision.propose',{text:'Keep the original acceptance rule'});command('decision.accept',{decisionId:decision.result.decisionId});
 store.atomic(()=>{for(let index=0;index<1600;index++)store.event(roomId,'audit.recorded',SYSTEM,{action:'fixture.tick',index});});
 command('message.send',{text:'Original request',mentions:['demo-planner']});const run=store.list<Run>('runs')[0],captured=store.get<RunContext>('contexts',run.contextId!)!;
 command('message.send',{text:'Later ordinary message'});const agent=store.get<AgentDescriptor>('agents','demo-planner')!;command('agent.save',{...agent,role:'A later role'});
 const after=store.get<RunContext>('contexts',run.contextId!)!;assert.deepEqual(after,captured);assert.ok(!after.messages.some(message=>message.text==='Later ordinary message'));
 assert.equal(after.decisions[0].text,'Keep the original acceptance rule');assert.notEqual(after.members.find(member=>member.id===agent.id)?.role,'A later role');
});
test('discussion participants share one frozen context and the next round includes complete prior replies',t=>{
 const {store,service,command,roomId}=fixture(t);command('discussion.start',{goal:'bounded',participants:['demo-planner','demo-reviewer'],rounds:20,maxResponses:3,maxDurationMs:2000});
 const first=store.list<Run>('runs');assert.equal(first[0].contextId,first[1].contextId);
 const finish=(run:Run,text:string)=>store.atomic(()=>{const message={id:uid('msg'),roomId,actor:{id:run.agentId,kind:'agent'},text,mentions:[],attachments:[],createdAt:new Date().toISOString(),runId:run.id,generation:run.generation,executionId:run.executionId};store.event(roomId,'chat.message.created',message.actor as any,{message});if(store.get<Run>('runs',run.id)?.status==='queued'){const started={...run,status:'running'};store.event(run.roomId,'run.started',{id:'system',kind:'system'},{run:started});}run.status='completed';store.put('runs',run);service.settleDiscussion(run);});
 finish(first[0],'complete first reply');assert.equal(store.list('runs').length,2);finish(first[1],'complete second reply');
 const third=store.list<Run>('runs')[2],context=store.get<RunContext>('contexts',third.contextId!)!;
 assert.notEqual(third.contextId,first[0].contextId);assert.ok(context.messages.some(message=>message.text==='complete first reply'));assert.ok(context.messages.some(message=>message.text==='complete second reply'));
 const discussion=store.list<Discussion>('discussions')[0];assert.equal(discussion.maxResponses,3);assert.ok(Date.parse(discussion.deadline)-Date.parse(first[0].createdAt)<=2000);
 finish(third,'final');assert.equal(store.list('runs').length,3);assert.equal(store.list<Discussion>('discussions')[0].status,'completed');
});
test('v1 databases get a checkpointed backup before settings/context migration',t=>{
 const {store,root}=fixture(t),path=join(root,'room.sqlite');store.db.exec('DROP TABLE settings; DROP TABLE contexts; PRAGMA user_version=1;');store.close();
 const migrated=new Store(path);assert.equal((migrated.db.prepare('PRAGMA user_version').get() as any).user_version,8);migrated.close();
 const backup=join(root,readdirSync(root).find(name=>name.startsWith('room.sqlite.v1.')&&name.endsWith('.bak'))!);assert.ok(backup);
 const original=new DatabaseSync(backup,{readOnly:true});assert.equal((original.prepare('PRAGMA user_version').get() as any).user_version,1);assert.equal(original.prepare("SELECT name FROM sqlite_master WHERE name='settings'").get(),undefined);original.close();
});
test('dependency revision cancels and versions accepted downstream work without accepting proposals',t=>{
 const {store,service,command,roomId}=fixture(t);
 const parent=command('task.create',{title:'build v1',agentId:'demo-planner'}).result.taskId as string;
 const child=command('task.create',{title:'review',agentId:'demo-reviewer',dependencies:[parent]}).result.taskId as string;
 const proposed=service.execute({version:'0.1',commandId:uid(),roomId,type:'task.create',payload:{title:'unaccepted proposal',agentId:'demo-reviewer',dependencies:[child]}},{id:'demo-planner',kind:'agent'}).result.taskId as string;
 const oldRuns=store.list<Run>('runs');command('task.revise',{taskId:parent,title:'build v2'});
 assert.equal(store.get<Task>('tasks',parent)?.version,2);assert.equal(store.get<Task>('tasks',child)?.version,2);
 assert.equal(store.get<Task>('tasks',proposed)?.status,'proposed');assert.equal(store.get<Task>('tasks',proposed)?.version,2);
 for(const run of oldRuns)assert.equal(store.get<Run>('runs',run.id)?.status,'superseded');
 const queued=store.list<Run>('runs').filter(run=>run.status==='queued');assert.equal(queued.length,2);assert.ok(queued.every(run=>run.taskVersion===2));
});
test('dependency inputs include only completed current-version artifacts from the same room',t=>{
 const {store,command,roomId}=fixture(t),parentId=command('task.create',{title:'build',agentId:'demo-planner'}).result.taskId as string;
 const parent=store.get<Task>('tasks',parentId)!,run=store.list<Run>('runs')[0];parent.status='completed';parent.version=2;store.event(run.roomId,'run.started',SYSTEM,{run:{...run,status:'running'}});run.status='completed';run.taskVersion=2;store.put('tasks',parent);store.put('runs',run);
 const review=command('task.create',{title:'review',agentId:'demo-reviewer',dependencies:[parentId]}).result.taskId as string;
 const artifact={id:'current-artifact',roomId,taskId:parentId,runId:run.id,generation:run.generation,executionId:run.executionId,name:'changes.patch',kind:'patch',mediaType:'text/x-diff',size:10,createdAt:new Date().toISOString()};store.put('artifacts',artifact);
 const oldRun={...run,id:'old-run',taskVersion:1},oldArtifact={...artifact,id:'old-artifact',runId:'old-run'},otherArtifact={...artifact,id:'other-room-artifact',roomId:'other-room'};
 store.putRoom({id:'other-room',name:'Other',description:'',members:[],createdAt:new Date().toISOString(),seq:0});store.put('runs',oldRun);store.put('artifacts',oldArtifact);store.put('artifacts',otherArtifact);
 assert.deepEqual(dependencyInputs(store,store.get<Task>('tasks',review)!),{versions:{[parentId]:2},artifacts:['current-artifact']});
});

test('handoff invalidates transitive reviews before freezing new context and never accepts proposals',t=>{
 const {store,service,command,roomId}=fixture(t);
 const parent=command('task.create',{title:'build v1',agentId:'demo-planner'}).result.taskId as string;
 const child=command('task.create',{title:'review v1',agentId:'demo-reviewer',dependencies:[parent]}).result.taskId as string;
 const grandchild=command('task.create',{title:'dependent delivery',agentId:'demo-planner',dependencies:[child]}).result.taskId as string;
 const proposal=service.execute({version:'0.1',commandId:uid(),roomId,type:'task.create',payload:{title:'unaccepted follow-up',agentId:'demo-reviewer',dependencies:[child]}},{id:'demo-planner',kind:'agent'}).result.taskId as string;
 const old=store.list<Run>('runs'),oldMessages:string[]=[];
 for(const run of old){run.status='running';store.event(run.roomId,'run.started',{id:'system',kind:'system'},{run});oldMessages.push(service.execute({version:'0.1',commandId:uid(),roomId,type:'message.send',payload:{text:'old '+run.taskId}},{id:run.agentId,kind:'agent'},{runId:run.id}).result.messageId as string);}
 const result=command('task.handoff',{taskId:parent,agentId:'demo-reviewer',note:'recheck implementation'});
 assert.deepEqual(new Set(result.result.affectedTaskIds as string[]),new Set([parent,child,grandchild,proposal]));
 assert.equal(store.get<Task>('tasks',parent)?.agentId,'demo-reviewer');
 for(const id of [parent,child,grandchild]){assert.equal(store.get<Task>('tasks',id)?.version,2);assert.equal(store.get<Task>('tasks',id)?.status,'queued');}
 assert.equal(store.get<Task>('tasks',proposal)?.version,2);assert.equal(store.get<Task>('tasks',proposal)?.status,'proposed');
 for(const run of old)assert.equal(store.get<Run>('runs',run.id)?.status,'cancel_requested');
 for(const id of oldMessages)assert.equal(store.get<Message>('messages',id)?.stale,true);
 const next=store.list<Run>('runs').filter(run=>run.status==='queued');assert.equal(next.length,3);assert.equal(new Set(next.map(run=>run.contextId)).size,1);
 for(const run of next){const snapshot=store.get<RunContext>('contexts',run.contextId!)!;assert.equal(snapshot.throughSeq,run.basedOnSeq);for(const id of oldMessages)assert.equal(snapshot.messages.find(message=>message.id===id)?.stale,true);}
 assert.match(next.find(run=>run.taskId===parent)!.prompt,/交接说明.*|recheck implementation/s);
 assert.ok(store.events(roomId).some(event=>event.type==='task.revised'&&event.payload.dependencyTaskId===parent));
});

test('external completion summaries bind their task version and become stale without a managed run',t=>{
 const {store,service,command,roomId}=fixture(t),agentId='demo-planner';
 command('agent.save',{...store.get<AgentDescriptor>('agents',agentId)!,connectionMode:'external'});
 const taskId=command('task.create',{title:'external fixture',agentId}).result.taskId as string;
 const actor={id:agentId,kind:'agent'} as const;
 const claim=service.execute({version:'0.1',commandId:uid(),roomId,type:'task.claim',payload:{taskId,managed:false}},actor);
 service.execute({version:'0.1',commandId:uid(),roomId,type:'task.complete',payload:{taskId,taskVersion:claim.result.version,contextToken:claim.result.contextToken,summary:'external versioned result'}},actor);
 const message=store.list<Message>('messages',roomId).find(message=>message.text==='external versioned result')!,previousSeq=store.room(roomId)!.seq;
 assert.equal(message.taskId,taskId);assert.equal(message.taskVersion,claim.result.version);assert.equal(message.runId,undefined);assert.equal(store.list('runs').length,0);
 command('task.revise',{taskId,title:'external revised goal'});
 assert.equal(store.get<Message>('messages',message.id)?.stale,true);
 assert.equal(captureContext(store,roomId,store.room(roomId)!.seq).messages.find(item=>item.id===message.id)?.stale,true);
 assert.ok(!captureContext(store,roomId,previousSeq).messages.find(item=>item.id===message.id)?.stale);
 assert.equal(store.list('runs').length,0);
});
test('global concurrency updates do not allow a second request in the same member session',async t=>{
 const parent=resolve('.state/test-data');mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'concurrency-')),{app,store,service,worker}=await createApp({root,startWorker:false});
 t.after(async()=>{await app.close();assert.ok(root.startsWith(parent));rmSync(root,{recursive:true,force:true});});const roomId=store.rooms()[0].id;
 const cmd=(type:any,payload:any)=>service.execute({version:'0.1',commandId:uid(),roomId,type,payload});
 cmd('settings.update',{...defaultExecutionSettings,concurrency:1});
 cmd('task.create',{title:'first',agentId:'demo-planner'});cmd('task.create',{title:'same session queued',agentId:'demo-planner'});cmd('message.send',{text:'other session',mentions:['demo-reviewer']});
 worker.start();assert.equal(store.list<Run>('runs').filter(run=>run.status==='running').length,1);
 cmd('settings.update',{...defaultExecutionSettings,concurrency:2});worker.tick();
 const active=store.list<Run>('runs').filter(run=>run.status==='running');assert.equal(active.length,2);assert.deepEqual(new Set(active.map(run=>run.agentId)),new Set(['demo-planner','demo-reviewer']));
 assert.equal(store.list<Run>('runs').find(run=>run.prompt==='same session queued')?.status,'queued');
});
