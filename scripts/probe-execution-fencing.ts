import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {Store,uid,SYSTEM} from '../apps/server/src/store.ts';
import {RoomService} from '../apps/server/src/service.ts';
import {Worker} from '../apps/server/src/worker.ts';
import {executionFence} from '../apps/server/src/execution.ts';
import {stageToolchain} from '../apps/server/src/toolchain.ts';
import type {Run,Message,ToolOperation} from '../packages/protocol/src/index.ts';
// Always use a fresh fixture: this command must never open the daily database.
const parent=resolve('.state/fencing-native-probes');mkdirSync(parent,{recursive:true});
const root=mkdtempSync(join(parent,'run-')),workspace=join(root,'fence-workspace'),home=join(root,'fence-home');mkdirSync(workspace,{recursive:true});mkdirSync(home,{recursive:true});
const store=new Store(join(root,'room.sqlite')),service=new RoomService(store),worker=new Worker(store,service,root),roomId=store.rooms()[0].id;
const tools=await stageToolchain(root),bridge=join(tools.node,'..','room-bridge.mjs');
service.execute({version:'0.1',commandId:uid(),roomId,type:'message.send',payload:{text:'Native fencing fixture',mentions:['demo-planner']}});
const run=store.list<Run>('runs').find(run=>run.status==='queued')!;run.executionId=uid('execution');run.status='running';run.leaseUntil=new Date(Date.now()+600000).toISOString();store.event(roomId,'run.started',SYSTEM,{run});
const fence=executionFence(run);(worker as any).active.set(run.id,new AbortController());(worker as any).executions.set(fence.executionId,fence);
const pipeName=`LOCAL\\TemptRoom-${fence.executionId}`,pipePath=`\\\\.\\pipe\\${pipeName}`,marker=uid('native_post');
const script=join(workspace,'native-pipe.cjs');
writeFileSync(script,`const{spawn}=require('node:child_process');const{createInterface}=require('node:readline');
const child=spawn(process.execPath,[${JSON.stringify(bridge)}],{env:{...process.env,ROOM_PIPE:${JSON.stringify(pipePath)}},stdio:'pipe',windowsHide:true});
let ready=false;const parent=createInterface({input:process.stdin});
createInterface({input:child.stdout}).on('line',line=>{const frame=JSON.parse(line);if(frame.id===1){ready=true;console.log('FIRST '+line);}if(frame.id===2){console.log('SECOND '+line);parent.close();child.stdin.end();}});
child.stderr.pipe(process.stderr);child.on('exit',code=>process.exit(code??1));
function call(id,text,operationId){child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name:'room_post',arguments:{text,operationId}}})+'\\n');}
parent.on('line',line=>{if(line==='again'&&ready)call(2,'FORBIDDEN_LATE_NATIVE_WRITE','native_late');});call(1,${JSON.stringify(marker)},'native_first');`);
let stdout='',exit:any;
worker.host.on('notification',frame=>{if(frame.runId!==fence.executionId)return;if(frame.type==='sandbox.output'&&frame.stream==='stdout')stdout+=frame.data;if(frame.type==='sandbox.exit'||frame.type==='sandbox.error')exit=frame;});
const until=async(test:()=>boolean)=>{const deadline=Date.now()+20000;while(!test()){if(Date.now()>deadline)throw new Error('Native pipe timed out: '+stdout);await new Promise(resolve=>setTimeout(resolve,40));}};
let ok=false;
try{
  await worker.host.launch({runId:fence.executionId,executable:tools.node,args:[script],workspace,home,runtimeRoots:tools.runtimeRoots,environment:{},memoryMb:1024,maxProcesses:16,timeoutMs:60000,roomPipe:pipeName});
  await until(()=>stdout.includes('FIRST '));
  if(!store.list<Message>('messages',roomId).some(message=>message.text===marker))throw new Error('First native tool write missing');
  const current=store.get<Run>('runs',run.id)!;if(!current.sandbox)throw new Error('Trusted sandbox proof missing');current.generation=(current.generation??1)+1;delete current.executionId;delete current.leaseUntil;current.status='interrupted';store.event(roomId,'run.recovered',SYSTEM,{run:current});
  current.status='queued';store.event(roomId,'run.requeued',SYSTEM,{run:current});current.executionId=uid('execution');current.status='running';store.event(roomId,'run.started',SYSTEM,{run:current});const seq=store.room(roomId)!.seq;
  await worker.host.write(fence.executionId,'again\n');await until(()=>stdout.includes('SECOND '));await until(()=>Boolean(exit));
  if(!stdout.includes('stale_generation')||store.room(roomId)!.seq!==seq)throw new Error('Old native pipe was not fenced');
  if(exit.type!=='sandbox.exit'||exit.exitCode!==0||!exit.jobEmpty)throw new Error('Native process tree did not exit cleanly');
  if(store.list<ToolOperation>('operations',roomId).length!==1)throw new Error('Unexpected operation count');
  ok=true;
  const report={at:new Date().toISOString(),ok:true,modelRequests:0,appContainerVerified:true,physicalExecutionId:fence.executionId,firstOperationCommitted:true,oldPipeRejected:true,noEventAfterOldWrite:true,jobEmpty:true};
  const reportPath=join(root,'fencing-pipe-report.json');writeFileSync(reportPath,JSON.stringify(report,null,2));writeFileSync(join(parent,'latest.json'),JSON.stringify({root,reportPath},null,2));console.log(JSON.stringify(report,null,2));
}finally{
  if(!exit)await worker.host.cancel(fence.executionId).catch(()=>{});(worker as any).active.clear();await worker.close();store.close();
  if(!ok)process.exitCode=1;
}
