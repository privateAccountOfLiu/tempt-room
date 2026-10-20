import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {Store,DATABASE_VERSION,uid,SYSTEM,OWNER} from '../apps/server/src/store.ts';
import {RoomService} from '../apps/server/src/service.ts';
import {createApp} from '../apps/server/src/app.ts';
import {eventRegistry,eventRegistryManifest,eventSchema,defaultSandbox,type AgentDescriptor,type Message,type Run,type Task,type RoomEvent} from '../packages/protocol/src/index.ts';

function directory(_t:TestContext){const parent=resolve('.state/test-data');mkdirSync(parent,{recursive:true});return mkdtempSync(join(parent,'event-replay-'));}
function removeDirectory(root:string){const parent=resolve('.state/test-data');assert.ok(root.startsWith(parent+'\\')||root.startsWith(parent+'/'));rmSync(root,{recursive:true,force:true});}
function fixture(t:TestContext){
  const root=directory(t),store=new Store(join(root,'room.sqlite')),service=new RoomService(store),roomId=store.rooms()[0].id;
  const extraClosers:(()=>void)[]=[];t.after(()=>{for(const close of extraClosers)close();try{store.close();}catch{}removeDirectory(root);});
  const command=(type:any,payload:any,room=roomId)=>service.execute({version:'0.1',commandId:uid('cmd'),roomId:room,type,payload});
  return {root,store,service,roomId,command,closeExtra:(fn:()=>void)=>extraClosers.push(fn)};
}
test('unknown, malformed and ephemeral events roll back without advancing a room cursor',t=>{
  const {store,roomId}=fixture(t),before=store.projectionBytes(roomId),seq=store.room(roomId)!.seq,count=store.events(roomId).length;
  for(const [type,payload,code] of [
    ['not.registered',{},'unregistered_event'],['token.delta',{delta:'temporary'},'ephemeral_event'],['typing',{},'ephemeral_event'],['run.updated',{run:{id:'missing-fields'}},'invalid_event_payload']
  ] as const)assert.throws(()=>store.event(roomId,type,SYSTEM,payload),(error:any)=>error.code===code);
  assert.equal(store.projectionBytes(roomId),before);assert.equal(store.room(roomId)!.seq,seq);assert.equal(store.events(roomId).length,count);
  const stamp=new Date().toISOString();
  assert.throws(()=>store.event(roomId,'run.created',SYSTEM,{run:{id:'future_run',roomId,agentId:'demo-planner',status:'queued',prompt:'Future',basedOnSeq:seq+100,createdAt:stamp,updatedAt:stamp}}),(error:any)=>error.code==='invalid_event_cursor');
  assert.throws(()=>store.atomic(()=>{store.event(roomId,'audit.recorded',SYSTEM,{action:'before-invalid'});store.event(roomId,'token.delta',SYSTEM,{});}));
  assert.equal(store.events(roomId).length,count);
});
test('events have immutable envelopes and SQL prevents modification or deletion of committed facts',t=>{
  const {store,roomId}=fixture(t),event=store.event(roomId,'audit.recorded',SYSTEM,{action:'audit-test'});
  assert.equal(event.kind,'audit.recorded');assert.equal(event.schemaVersion,1);assert.equal(event.durability,'durable');assert.equal(event.aggregate.id,roomId);
  assert.equal(event.ts,event.createdAt);assert.equal(event.actor.type,'system');assert.ok(event.traceId);assert.equal(event.generation,1);assert.equal(eventSchema.safeParse(event).success,true);
  assert.ok(Object.isFrozen(event));assert.ok(Object.isFrozen(event.payload));
  assert.throws(()=>store.db.prepare('UPDATE events SET body=? WHERE event_id=?').run('{}',event.eventId),/immutable/);
  assert.throws(()=>store.db.prepare('DELETE FROM events WHERE event_id=?').run(event.eventId),/immutable/);
});
test('every registered durable event declares and passes its payload contract and projector',t=>{
  const {store,roomId}=fixture(t),stamp=new Date().toISOString(),room=store.room(roomId)!;
  const task={id:'contract_task',roomId,title:'Task',agentId:'demo-planner',projectPath:'',version:1,status:'queued',dependencies:[],createdAt:stamp};
  const run:Run={id:'contract_run',roomId,agentId:'demo-planner',status:'queued',prompt:'Request',basedOnSeq:room.seq,createdAt:stamp,updatedAt:stamp};
  const message={id:'contract_message',roomId,actor:OWNER,text:'Message',mentions:[],attachments:[],createdAt:stamp};
  const artifact={id:'contract_artifact',roomId,runId:run.id,generation:2,executionId:'contract_execution',name:'Report',kind:'report',mediaType:'text/plain',size:1,createdAt:stamp};
  const context={id:'contract_context',roomId,fromSeq:room.seq,throughSeq:room.seq,messages:[],decisions:[],members:[]};
  const discussion={id:'contract_discussion',roomId,goal:'Goal',participants:['demo-planner'],rounds:1,round:1,maxResponses:1,responses:0,deadline:stamp,status:'active'};
  const rows={messages:[],tasks:[],runs:[],artifacts:[],discussions:[],decisions:[],contexts:[],operations:[],agent_sessions:[],subscriptions:[],inbox_deliveries:[],input_batches:[],wake_intents:[],capability_evidence:[],discussion_rounds:[],project_bindings:[]};
  let contextContractRun:Run|undefined;
  for(const entry of eventRegistryManifest){
    assert.equal(entry.schemaVersion,1);assert.ok(entry.aggregate);const definition=eventRegistry[entry.type];
    if(entry.durability==='ephemeral'){assert.equal(entry.projector,null);continue;}
    assert.ok(entry.projector,entry.type);
    const payload:any=entry.projector==='checkpoint'?{room,rows,reason:'manual-snapshot'}:{room,members:[],task,run,message,artifact,context,discussion,decision:{id:'contract_decision',roomId,text:'Decision',actor:OWNER,accepted:false},settings:store.settings(),runId:run.id,sandbox:{...defaultSandbox,verifiedAt:stamp},agentId:'demo-planner',messageId:message.id,connectionMode:'external',name:'tool',success:true,generation:2,executionId:'contract_execution',workspace:resolve('.'),commit:null,action:'contract',agentSession:{id:'contract_session',roomId,agentId:'demo-planner',status:'active',createdAt:stamp,updatedAt:stamp},subscription:{id:'contract_subscription',roomId,agentSessionId:'contract_session',eventTypes:[],taskIds:[],sourcePolicy:'explicit',enabled:true,scanSeq:0},delivery:{id:'contract_delivery',agentSessionId:'contract_session',sourceEventId:'contract_event',sourceSeq:1,status:'pending'},batch:{id:'contract_batch',agentSessionId:'contract_session',generation:1,executionId:'contract_execution',deliveryIds:['contract_delivery'],sourceEventIds:['contract_event'],fromScanSeq:0,throughScanSeq:1,payloadHash:'a'.repeat(64),deliveryMode:'next-turn',createdAt:stamp,status:'created'},wakeIntent:{id:'contract_wake',scopeKey:'contract_scope',agentSessionId:'contract_session',sourceEventId:'contract_event',sourceSeq:1,status:'pending'},capabilityEvidence:{id:'contract_capability',fingerprint:'fp',capability:'streamOutput',state:'verified_supported',mode:'simulated',testedAt:stamp,suiteVersion:'sim-v1',evidenceHash:'b'.repeat(64)},round:{id:'contract_round',discussionId:'contract_discussion',round:1,status:'open',openedSeq:room.seq,openedAt:stamp},verification:{verificationId:'contract_verification',outcome:'accepted',taskVersion:1},integration:{id:'contract_integration',roomId,artifactId:'contract_artifact',status:'queued',requestActor:'owner',createdAt:stamp,updatedAt:stamp},projectBinding:{id:'contract_binding',roomId,sourcePath:resolve('.'),manifestHash:'c'.repeat(64),manifestFileCount:0,manifestBytes:0,allowedExecutionModes:['sandbox'],verificationRefs:[],version:1,createdAt:stamp,updatedAt:stamp}};
    const statuses:Record<string,string>={'run.started':'running','run.blocked':'waiting_input','run.completed':'completed','run.failed':'failed','run.cancelled':'canceled','run.superseded':'superseded','run.interrupted':'interrupted','run.unknown':'unknown','run.cancel.requested':'cancel_requested'};
    if(statuses[entry.type])payload.run={...run,status:statuses[entry.type]};
    if(entry.type==='run.recovered')payload.run={...run,generation:2,status:'interrupted'};
    if(entry.type==='run.requeued'||entry.type==='run.reconciled')payload.run={...run,generation:2};
    if(entry.projector==='partial'){const current=store.get<Run>('runs',run.id)!;current.status='running';current.executionId='contract_execution';run.executionId=current.executionId;store.event(roomId,'run.updated',SYSTEM,{run:current});payload.baseSeq=0;payload.partial={id:'contract_partial',messageId:'contract_stream',text:'Draft',createdAt:stamp,streamIndex:0,truncated:false};}
    if(entry.projector==='final'){const current=store.get<Run>('runs',run.id)!;const finalMessage={...message,id:'contract_final',actor:{id:run.agentId,kind:'agent'},runId:run.id,generation:2,executionId:'contract_execution'};store.event(roomId,'chat.message.created',SYSTEM,{message:finalMessage});payload.messageId=finalMessage.id;payload.supersedes=current.partial?.id;}
    if(entry.type==='run.lease.renewed'){run.generation=2;payload.run={...run};}
    if(entry.projector==='operation'){
      const current=store.get<Run>('runs',run.id)!;current.executionId='contract_execution';store.event(roomId,'run.updated',SYSTEM,{run:current});
      payload.operation={id:'contract_operation',runId:run.id,roomId,agentId:run.agentId,generation:2,executionId:'contract_execution',operationId:'contract_op',name:'room_post',hash:'a'.repeat(64),status:entry.type.split('.')[1],createdAt:stamp,updatedAt:stamp};
      if(entry.type==='operation.unknown')payload.operation.id='unknown_contract_operation';
      if(entry.type==='operation.reconciled'){
        current.codex={binding:{transport:'control-socket',endpoint:resolve('contract.sock'),credentialEnv:'',threadId:'contract_thread',expectedCwd:resolve('.')},clientUserMessageId:'contract_client',nativeTurnId:'contract_turn',nativeStatus:'completed',phase:'completed'};store.event(roomId,'run.updated',SYSTEM,{run:current});
        payload.operation={...payload.operation,id:'contract_native_operation',operationId:'contract_native_input',name:'native.execution',status:'completed',native:{provider:'codex',scope:'execution',evidence:'execution-intent',inputId:'b'.repeat(64),kind:'execution',clientUserMessageId:'contract_client',sessionId:'contract_thread'}};
        store.event(roomId,'operation.started',SYSTEM,{operation:{...payload.operation,status:'started'}});store.event(roomId,'operation.unknown',SYSTEM,{operation:{...payload.operation,status:'unknown'}});
        payload.proof={threadId:'contract_thread',turnId:'contract_turn',clientUserMessageId:'contract_client',status:'completed',itemsView:'full'};payload.operation.result={outcome:'completed',reconciled:true};
      }
    }
    if(entry.type==='run.context.advanced'){
      const previous={...run,id:'contract_context_run',status:'running' as const,generation:1,executionId:'context_old',basedOnSeq:store.room(roomId)!.seq};store.put('runs',previous);
      const throughSeq=store.room(roomId)!.seq,contextId='new_contract_context',inputContext={...context,id:contextId,fromSeq:throughSeq,throughSeq};store.put('contexts',inputContext);
      contextContractRun={...previous,generation:2,executionId:'context_new',contextSeq:throughSeq,deltaContextId:contextId,contextRound:1,contextPending:true};
      payload.run=contextContractRun;payload.delta={fromSeq:previous.basedOnSeq,throughSeq,headSeq:throughSeq,hasMore:false,reasons:['lag'],changes:[]};
    }
    if(entry.type==='run.context.confirmed'){delete payload.run;payload.runId=contextContractRun!.id;payload.generation=2;payload.executionId='context_new';payload.throughSeq=contextContractRun!.contextSeq;}
    if(entry.type==='task.context.advanced'){
      const id='contract_external_context_task';store.event(roomId,'task.created',SYSTEM,{task:{...task,id,status:'running',leaseUntil:stamp}});
      const throughSeq=store.room(roomId)!.seq,token='contract_task_input',input={...context,id:token,throughSeq};store.put('contexts',input);
      payload.task={...task,id,status:'running',leaseUntil:stamp,externalContext:{token,baseSeq:throughSeq,throughSeq,hasMore:false,policy:store.settings().contextPolicy}};
    }
    if(entry.type==='artifact.applied')payload.artifact={...artifact,applied:true};
    assert.equal(definition.payload.safeParse(payload).success,true,entry.type);
    const event=store.event(roomId,entry.type,SYSTEM,payload);assert.equal(event.schemaVersion,entry.schemaVersion);assert.equal(event.aggregate.type,entry.aggregate);assert.ok(entry.kinds.includes(event.kind));if(entry.type==='run.recovered')run.generation=2;
  }
});
test('live projections and full replay match byte for byte, including leases, contexts and stale task messages',t=>{
  const {store,roomId,command}=fixture(t);
  command('message.send',{text:'Initial',mentions:['demo-planner']});
  const run=store.list<Run>('runs',roomId)[0];if(store.get<Run>('runs',run.id)?.status==='queued'){const started={...run,status:'running'};store.event(run.roomId,'run.started',{id:'system',kind:'system'},{run:started});}run.status='completed';store.put('runs',run);
  const codex=store.get<AgentDescriptor>('agents','codex')!;command('agent.save',{...codex,enabled:true,connectionMode:'external'});
  const taskId=command('task.create',{title:'Lease task',agentId:'codex'}).result.taskId as string;
  const actor={id:'codex',kind:'agent'} as const;
  const execute=(type:any,payload:any)=>new RoomService(store).execute({version:'0.1',commandId:uid(),roomId,type,payload},actor);
  const claimed=execute('task.claim',{taskId,managed:false});execute('task.heartbeat',{taskId,taskVersion:claimed.result.version});
  execute('task.complete',{taskId,taskVersion:claimed.result.version,contextToken:claimed.result.contextToken,summary:'Versioned summary'});
  command('task.revise',{taskId,title:'Revised goal'});
  assert.equal(store.list<Message>('messages',roomId).find(message=>message.taskId===taskId)!.stale,true);
  store.put('artifacts',{id:'replay_report',roomId,runId:run.id,generation:run.generation,executionId:run.executionId,name:'report',kind:'report',mediaType:'text/plain',size:4,createdAt:new Date().toISOString()} as any);
  const decisionId=command('decision.propose',{text:'Accepted decision'}).result.decisionId;command('decision.accept',{decisionId});
  const otherId=command('room.create',{name:'Other',members:['demo-planner']}).result.roomId as string;
  command('message.send',{text:'Other room'},otherId);const otherBefore=store.projectionBytes(otherId),before=store.projectionBytes(roomId);
  const result=store.rebuildProjections(roomId);assert.ok(result.replayedEvents>10);assert.equal(store.projectionBytes(roomId),before);assert.equal(store.projectionBytes(otherId),otherBefore);
  const views=store.db.prepare('SELECT as_of_seq FROM proj_task WHERE id=?').get(taskId) as any;assert.ok(views.as_of_seq>0);assert.equal(store.projectionStatus(roomId).consistent,true);
  assert.ok(store.events(roomId).some(event=>event.type==='task.lease.renewed'));
});
test('rebuild repairs the actual application tables and rejects writes during replay',t=>{
  const {store,roomId,command}=fixture(t),taskId=command('task.create',{title:'Original',agentId:'demo-planner'}).result.taskId as string,before=store.projectionBytes(roomId);
  store.db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify({...store.get<Task>('tasks',taskId)!,title:'Damaged projection'}),taskId);
  let guarded=false;
  store.rebuildProjections(roomId,0,()=>{if(guarded)return;guarded=true;assert.throws(()=>command('message.send',{text:'Must not commit'}),/read-only/);});
  assert.ok(guarded);assert.equal(store.get<Task>('tasks',taskId)!.title,'Original');assert.equal(store.projectionBytes(roomId),before);
});

test('room metadata bytes do not depend on the mutable head during membership replay',t=>{
  const {store,roomId,command}=fixture(t);command('message.send',{text:'Before membership change'});command('room.members.set',{members:['demo-planner']});const metadataSeq=store.room(roomId)!.seq;
  for(let i=0;i<4;i++)command('message.send',{text:'After '+i});
  const before=store.projectionBytes(roomId);store.rebuildProjections(roomId);assert.equal(store.projectionBytes(roomId),before);
  const row=store.db.prepare('SELECT body FROM rooms WHERE id=?').get(roomId) as any;assert.equal(JSON.parse(row.body).seq,metadataSeq);assert.ok(store.room(roomId)!.seq>metadataSeq);
});

test('historic run limits preserve absent budget fields instead of gaining new schema defaults',t=>{
  const {store,roomId}=fixture(t),stamp=new Date().toISOString(),limits={memoryMb:4096,maxProcesses:64,timeoutMs:300000};
  const run:Run={id:'legacy_budget_run',roomId,agentId:'demo-planner',status:'queued',prompt:'Original facts',basedOnSeq:store.room(roomId)!.seq,limits,createdAt:stamp,updatedAt:stamp};
  const event=store.event(roomId,'run.created',SYSTEM,{run});assert.deepEqual((event.payload.run as Run).limits,limits);
  const before=store.projectionBytes(roomId);store.rebuildProjections(roomId);assert.equal(store.projectionBytes(roomId),before);
  assert.deepEqual(store.get<Run>('runs',run.id)!.limits,limits);
});
test('a sequence gap aborts a rebuild and restores every preexisting projection row',t=>{
  const {store,roomId,command}=fixture(t);command('message.send',{text:'One'});command('message.send',{text:'Two'});
  const before=store.projectionBytes(roomId);store.db.exec('DROP TRIGGER events_no_delete');
  store.db.prepare('DELETE FROM events WHERE room_id=? AND seq=3').run(roomId);
  assert.throws(()=>store.rebuildProjections(roomId),/gap/);assert.equal(store.projectionBytes(roomId),before);
});

test('a failed rebuild transaction leaves the store available for later writes',t=>{
  const {store,roomId}=fixture(t),before=store.projectionBytes(roomId),exec=store.db.exec.bind(store.db);
  let failBegin=true;
  store.db.exec=sql=>{if(sql==='BEGIN IMMEDIATE'&&failBegin){failBegin=false;throw new Error('Injected transaction contention');}return exec(sql);};
  assert.throws(()=>store.rebuildProjections(roomId),/Injected transaction contention/);
  assert.equal(store.projectionBytes(roomId),before);
  const event=store.event(roomId,'audit.recorded',SYSTEM,{action:'write-after-failed-rebuild'});
  assert.equal(event.seq,store.room(roomId)!.seq);
  const committed=store.projectionBytes(roomId);store.rebuildProjections(roomId);assert.equal(store.projectionBytes(roomId),committed);
});

test('an unsupported event schema aborts replay without changing existing projections',t=>{
  const {store,roomId}=fixture(t),event=store.event(roomId,'audit.recorded',SYSTEM,{action:'future-schema'}),before=store.projectionBytes(roomId);
  // A fixture from a newer writer must be rejected rather than interpreted as v1.
  store.db.exec('DROP TRIGGER events_no_update');
  store.db.prepare('UPDATE events SET body=? WHERE event_id=?').run(JSON.stringify({...event,schemaVersion:event.schemaVersion+1}),event.eventId);
  assert.throws(()=>store.rebuildProjections(roomId),/Unsupported replay schema version/);
  assert.equal(store.projectionBytes(roomId),before);
});

test('opening a newer database rejects it without changing its bytes or leaving a file handle',t=>{
  const root=directory(t),path=join(root,'future.sqlite');t.after(()=>removeDirectory(root));
  const future=new DatabaseSync(path);future.exec(`PRAGMA user_version=${DATABASE_VERSION+1}`);future.close();
  const before=readFileSync(path),files=readdirSync(root);
  assert.throws(()=>new Store(path),/Database version is newer/);
  assert.deepEqual(readFileSync(path),before);assert.deepEqual(readdirSync(root),files);
  rmSync(path);assert.equal(readdirSync(root).length,0);
});
test('snapshot and tail share one WAL read view while another connection commits',t=>{
  const {store,root,roomId,command,closeExtra}=fixture(t);command('message.send',{text:'Before'});const cursor=store.room(roomId)!.seq;
  const concurrent=new Store(join(root,'room.sqlite')),other=new RoomService(concurrent);closeExtra(()=>concurrent.close());
  const original=store.snapshotAt.bind(store);let injected=false;
  store.snapshotAt=(id,seq)=>{if(!injected){injected=true;other.execute({version:'0.1',commandId:'concurrent_commit',roomId,type:'message.send',payload:{text:'Concurrent'}});}return original(id,seq);};
  const snapshot=store.snapshotWithTail(roomId);
  assert.equal(snapshot.asOfSeq,cursor);assert.equal(snapshot.headSeq,cursor);assert.equal(snapshot.tail.length,0);assert.ok(!snapshot.snapshot.messages.some(message=>message.text==='Concurrent'));
  assert.equal(store.room(roomId)!.seq,cursor+1);assert.ok(store.snapshot(roomId).messages.some(message=>message.text==='Concurrent'));
});
test('historic snapshot carries only its watermarked data and returns bounded contiguous tail pages',t=>{
  const {store,roomId,command}=fixture(t);command('message.send',{text:'First'});const cursor=store.room(roomId)!.seq;
  for(let i=0;i<4;i++)command('message.send',{text:`Tail ${i}`});
  const result=store.snapshotWithTail(roomId,cursor,2);
  assert.equal(result.snapshot.room.seq,cursor);assert.ok(!result.snapshot.messages.some(message=>message.text==='Tail 0'));
  assert.deepEqual(result.tail.map(event=>event.seq),[cursor+1,cursor+2]);assert.equal(result.nextCursor,cursor+2);assert.equal(result.hasMore,true);
  const zero=store.snapshotWithTail(roomId,0);assert.equal(zero.asOfSeq,store.room(roomId)!.seq);
});
test('v2 migration preserves raw history and seals unlogged old rows into a replayable checkpoint',t=>{
  const root=directory(t),path=join(root,'room.sqlite'),legacy=new DatabaseSync(path),stamp=new Date().toISOString();
  legacy.exec('CREATE TABLE rooms(id TEXT PRIMARY KEY,seq INTEGER NOT NULL,body TEXT NOT NULL); CREATE TABLE events(event_id TEXT PRIMARY KEY,room_id TEXT NOT NULL,seq INTEGER NOT NULL,body TEXT NOT NULL,UNIQUE(room_id,seq)); CREATE TABLE commands(id TEXT PRIMARY KEY,hash TEXT NOT NULL,receipt TEXT NOT NULL); CREATE TABLE sessions(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE settings(key TEXT PRIMARY KEY,body TEXT NOT NULL);');
  for(const table of ['agents','messages','tasks','runs','artifacts','discussions','decisions','contexts'])legacy.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,room_id TEXT,body TEXT NOT NULL)`);
  const room={id:'room_legacy',name:'Legacy',description:'Old',members:['legacy-agent'],createdAt:stamp,seq:1};
  const raw=JSON.stringify({version:'0.1',eventId:'old_fact',roomId:room.id,seq:1,type:'room.created',actor:OWNER,createdAt:stamp,causationId:null,correlationId:null,payload:{room:{...room,seq:0}}});
  legacy.prepare('INSERT INTO rooms VALUES(?,?,?)').run(room.id,1,JSON.stringify(room));legacy.prepare('INSERT INTO events VALUES(?,?,?,?)').run('old_fact',room.id,1,raw);
  const oldTask={id:'old_task',roomId:room.id,title:'Unlogged lease',agentId:'legacy-agent',projectPath:'',version:3,status:'running',dependencies:[],leaseUntil:new Date(Date.now()+600000).toISOString(),createdAt:stamp};
  legacy.prepare('INSERT INTO tasks VALUES(?,?,?)').run(oldTask.id,room.id,JSON.stringify(oldTask));legacy.prepare('INSERT INTO agents VALUES(?,?,?)').run('legacy-agent',null,JSON.stringify({id:'legacy-agent',name:'Legacy',provider:'demo',enabled:true}));legacy.exec('PRAGMA user_version=2');legacy.close();
  const store=new Store(path);t.after(()=>{store.close();removeDirectory(root);});
  assert.equal((store.db.prepare('PRAGMA user_version').get() as any).user_version ,DATABASE_VERSION);assert.equal((store.db.prepare('SELECT body FROM events WHERE event_id=?').get('old_fact') as any).body,raw);
  const checkpoint=store.events(room.id).at(-1)!;assert.equal(checkpoint.type,'projection.checkpoint');assert.equal(store.projectionStatus(room.id).historyFloor,checkpoint.seq);
  const before=store.projectionBytes(room.id);store.rebuildProjections(room.id);assert.equal(store.projectionBytes(room.id),before);assert.equal(store.get<Task>('tasks',oldTask.id)!.leaseUntil,oldTask.leaseUntil);
  assert.throws(()=>store.snapshotAt(room.id,1),/cursor/);assert.equal(store.snapshotWithTail(room.id,1).reset,true);
  const backup=join(root,readdirSync(root).find(name=>name.startsWith('room.sqlite.v2.')&&name.endsWith('.bak'))!);const archived=new DatabaseSync(backup,{readOnly:true});assert.equal((archived.prepare('PRAGMA user_version').get() as any).user_version,2);archived.close();
});
test('process death before commit rolls back intent, while a committed receipt survives restart and replay',t=>{
  const root=directory(t),path=join(root,'room.sqlite'),initial=new Store(path),roomId=initial.rooms()[0].id;initial.close();t.after(()=>removeDirectory(root));
  const storeImport=pathToFileURL(resolve('apps/server/src/store.ts')).href,serviceImport=pathToFileURL(resolve('apps/server/src/service.ts')).href;
  for(const mode of ['inside','after'] as const){
    const source=`import{Store}from ${JSON.stringify(storeImport)};import{RoomService}from ${JSON.stringify(serviceImport)};const store=new Store(${JSON.stringify(path)}),service=new RoomService(store);if(${JSON.stringify(mode)}==='inside'){const append=store.event.bind(store);store.event=(...args)=>{const event=append(...args);if(args[1]==='chat.message.created')process.exit(73);return event;};}service.execute({version:'0.1',commandId:${JSON.stringify('crash_'+mode)},roomId:${JSON.stringify(roomId)},type:'message.send',payload:{text:${JSON.stringify('crash '+mode)}}});process.exit(74);`;
    const child=spawnSync(process.execPath,['--import','tsx/esm','--input-type=module','-e',source],{cwd:resolve('.'),windowsHide:true,encoding:'utf8',timeout:20000});assert.equal(child.status,mode==='inside'?73:74,child.stderr);
    const store=new Store(path),service=new RoomService(store);
    try{
      const exists=store.list<Message>('messages',roomId).some(message=>message.text==='crash '+mode);assert.equal(exists,mode==='after');
      if(mode==='after'){const seq=store.room(roomId)!.seq;service.execute({version:'0.1',commandId:'crash_after',roomId,type:'message.send',payload:{text:'crash after'}});assert.equal(store.room(roomId)!.seq,seq);}
      const before=store.projectionBytes(roomId);store.rebuildProjections(roomId);assert.equal(store.projectionBytes(roomId),before);
    }finally{store.close();}
  }
});
test('HTTP snapshot/rebuild use the actual event projections and retain owner authentication',async t=>{
  const root=directory(t),bundle=await createApp({root,token:'replay-owner',startWorker:false});t.after(async()=>{await bundle.app.close();removeDirectory(root);});
  const {app,store,service}=bundle,roomId=store.rooms()[0].id,headers={host:'127.0.0.1:4317',authorization:'Bearer replay-owner','room-protocol-version':'0.1'};
  const seq=store.room(roomId)!.seq;service.execute({version:'0.1',commandId:'snapshot_message',roomId,type:'message.send',payload:{text:'HTTP tail'}});
  const response=await app.inject({url:`/api/rooms/${roomId}/snapshot?cursor=${seq}&limit=1`,headers});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().asOfSeq,seq);assert.equal(response.json().tail[0].seq,seq+1);
  assert.equal((await app.inject({url:`/api/rooms/${roomId}/snapshot?cursor=999999`,headers})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:`/api/rooms/${roomId}/projections/rebuild`,headers:{host:headers.host},payload:{}})).statusCode,401);
  const rebuilt=await app.inject({method:'POST',url:`/api/rooms/${roomId}/projections/rebuild`,headers,payload:{fromSeq:0}});assert.equal(rebuilt.statusCode,200,rebuilt.body);assert.equal(rebuilt.json().asOfSeq,seq+1);
  const legacy=await app.inject({url:`/api/rooms/${roomId}`,headers});assert.ok(legacy.json().messages.some((message:any)=>message.text==='HTTP tail'));
});
