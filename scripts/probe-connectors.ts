import assert from 'node:assert/strict';
import {spawn,spawnSync,type ChildProcess} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createApp} from '../apps/server/src/app.ts';
import {issueAgentToken} from '../apps/server/src/agent-tokens.ts';
import {uid} from '../apps/server/src/store.ts';
import type {Task,Message} from '../packages/protocol/src/index.ts';

if(process.platform!=='win32')throw new Error('This connector process-tree probe targets Windows.');
const parent=resolve('.state/connector-probes');mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'run-'));
const secret=uid('test_secret'),state=await createApp({root,token:secret,startWorker:false});
const {app,store,service}=state,owned=new Set<ChildProcess>(),checks:{name:string;passed:boolean;detail:string}[]=[];
const stop=(child:ChildProcess)=>{if(child.pid&&child.exitCode===null&&child.signalCode===null)spawnSync(join(process.env.SystemRoot??'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:5000});};
const track=(child:ChildProcess)=>{owned.add(child);child.once('close',()=>owned.delete(child));return child;};
const waitFor=async(predicate:()=>boolean,timeout=12000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Connector probe condition timed out');};
const room=(name:string)=>service.execute({version:'0.1',commandId:uid(),type:'room.create',payload:{name,members:['demo-planner']}}).result.roomId as string;
const envFor=(roomId:string)=>({SystemRoot:process.env.SystemRoot??'C:\\Windows',PATH:process.env.PATH??'',TEMP:root,TMP:root,ROOM_URL:base,ROOM_ROOM_ID:roomId,ROOM_AGENT_TOKEN:issueAgentToken(secret,'demo-planner',roomId)});
let base='';

async function checkMcp(script:string){
 const roomId=room('MCP '+script),child=track(spawn(process.execPath,[resolve(script)],{cwd:resolve('.'),env:envFor(roomId),windowsHide:true,stdio:'pipe'}));
 const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
 createInterface({input:child.stdout!}).on('line',line=>{const frame=JSON.parse(line),request=pending.get(frame.id);if(request){clearTimeout(request.timer);pending.delete(frame.id);frame.error?request.reject(new Error(frame.error.message)):request.resolve(frame.result);}});
 const request=(id:number,method:string,params:any={})=>new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('MCP request timed out'));},5000);pending.set(id,{resolve,reject,timer});child.stdin!.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 try{
  assert.equal((await request(1,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'connector-probe',version:'0.1'}})).serverInfo.name,'tempt-room-connector');
  const listed=await request(2,'tools/list');assert.equal(listed.tools.length,9);
  assert.ok(listed.tools.find((tool:any)=>tool.name==='task_complete').inputSchema.required.includes('taskVersion'));
  const post={name:'room_post',arguments:{text:'MCP exact retry'}};
  const first=await request(3,'tools/call',post),retry=await request(3,'tools/call',post);assert.deepEqual(first,retry);
  assert.equal(store.list<Message>('messages',roomId).length,1);
  const artifact={name:'artifact_publish',arguments:{name:'connector report',text:'one artifact'}};
  assert.deepEqual(await request(4,'tools/call',artifact),await request(4,'tools/call',artifact));assert.equal(store.list('artifacts',roomId).length,1);
 }finally{for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error('Probe closed'));}child.stdin!.end();await waitFor(()=>child.exitCode!==null||child.signalCode!==null,3000).catch(()=>stop(child));}
}

const fixture=join(root,'fixture.mjs');
writeFileSync(fixture,`
import {writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
const mode=process.env.FIXTURE_MODE;
if(mode==='hang'||mode==='timeout'){
 const child=spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{windowsHide:true,stdio:'ignore'});
 writeFileSync(process.env.FIXTURE_PIDS,JSON.stringify({root:process.pid,child:child.pid}));
 setTimeout(()=>{},20000);
}else{
 writeFileSync(process.env.FIXTURE_ARGV,JSON.stringify(process.argv.slice(2)));
 const answer=()=>{
  console.log(JSON.stringify({type:'system',subtype:'init',session_id:'fixture-session'}));
  console.log(JSON.stringify({type:'assistant',message:{content:[{type:'thinking',thinking:'private-reasoning-marker'}]}}));
  console.log(JSON.stringify({type:'result',parent_tool_use_id:'child',session_id:'child-session',result:'private-child-marker'}));
  console.log(JSON.stringify(mode==='error'?{type:'result',subtype:'error_during_execution',is_error:true,result:'not-success'}:{type:'result',subtype:'success',session_id:'fixture-session',result:'public fixture answer'}));
 };
 if(mode==='persistent'){for await(const line of readline.createInterface({input:process.stdin})){JSON.parse(line);answer();}}
 else {if(mode==='renew')await new Promise(resolve=>setTimeout(resolve,6500));answer();}
}
`);

async function checkRunner(mode:'success'|'persistent'|'error'|'hang'|'renew'|'timeout'){
 const roomId=room('Runner '+mode),taskId=service.execute({version:'0.1',commandId:uid(),roomId,type:'task.create',payload:{title:'Probe task',open:true}}).result.taskId as string;
 const sessionFile=join(root,`session-${mode}.json`),argvFile=join(root,`argv-${mode}.json`),pidFile=join(root,`pids-${mode}.json`);
 const launch=()=>{
  const child=track(spawn(process.execPath,[resolve('scripts/room-agent-runner.mjs'),'--once'],{cwd:resolve('.'),env:{...envFor(roomId),ROOM_CLAIM_OPEN:'1',ROOM_AGENT_COMMAND:process.execPath,ROOM_AGENT_ARGS:JSON.stringify([fixture]),ROOM_AGENT_RESUME_ARGS:JSON.stringify(['--resume','{session}']),ROOM_AGENT_SESSION_FILE:sessionFile,ROOM_AGENT_MODE:mode==='persistent'?'persistent':'oneshot',ROOM_AGENT_TIMEOUT_MS:mode==='timeout'?'1500':'15000',FIXTURE_MODE:mode,FIXTURE_ARGV:argvFile,FIXTURE_PIDS:pidFile},windowsHide:true,stdio:['ignore','pipe','pipe']}));
  let stderr='';child.stderr!.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-4000);writeFileSync(join(root,`runner-${mode}.log`),stderr);});
  return {child,stderr:()=>stderr};
 };
 const first=launch();
 try{
  if(mode==='hang'){
   await waitFor(()=>store.get<Task>('tasks',taskId)?.status==='running'&&existsSync(pidFile));
   service.execute({version:'0.1',commandId:uid(),roomId,type:'task.release',payload:{taskId}});
  }
  await waitFor(()=>first.child.exitCode!==null||first.child.signalCode!==null,15000).catch(error=>{throw new Error(`${error.message}\n${first.stderr()}`);});
  assert.equal(first.child.exitCode,0,first.stderr());
  const task=store.get<Task>('tasks',taskId)!,messages=store.list<Message>('messages',roomId);
  if(mode==='hang'){
   assert.equal(task.status,'proposed');assert.equal(task.agentId,'unassigned');assert.equal(messages.length,0);
   const pids=JSON.parse(readFileSync(pidFile,'utf8'));const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
   await waitFor(()=>!alive(pids.root)&&!alive(pids.child),3000);
  }else if(mode==='error'||mode==='timeout'){
   assert.equal(task.status,'failed');assert.equal(messages.length,1);assert.ok(!messages[0].text.includes('not-success'));
   if(mode==='timeout'){
    assert.match(messages[0].text,/timed out/);const pids=JSON.parse(readFileSync(pidFile,'utf8'));
    const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
    await waitFor(()=>!alive(pids.root)&&!alive(pids.child),3000);
   }
  }else{
   assert.equal(task.status,'completed');assert.deepEqual(messages.map(message=>message.text),['public fixture answer']);
   assert.equal(JSON.parse(readFileSync(sessionFile,'utf8')).sessionId,'fixture-session');
   if(mode==='success'){
    const next=service.execute({version:'0.1',commandId:uid(),roomId,type:'task.create',payload:{title:'Resume probe',open:true}}).result.taskId as string;
    const second=launch();try{await waitFor(()=>second.child.exitCode!==null||second.child.signalCode!==null);assert.equal(second.child.exitCode,0,second.stderr());assert.equal(store.get<Task>('tasks',next)!.status,'completed');assert.deepEqual(JSON.parse(readFileSync(argvFile,'utf8')),['--resume','fixture-session']);}finally{stop(second.child);}
   }
  }
  assert.ok(!JSON.stringify(store.list('messages',roomId)).includes('private-reasoning-marker'));assert.ok(!JSON.stringify(store.list('messages',roomId)).includes('private-child-marker'));
  assert.equal(store.list('runs',roomId).length,0);
 }finally{stop(first.child);}
}

async function checkHumanWake(){
 const roomId=room('Human wake only'),roomState=store.room(roomId)!;roomState.members.push('demo-reviewer');store.putRoom(roomState);
 const argvFile=join(root,'human-wake-argv.json');
 const child=track(spawn(process.execPath,[resolve('scripts/room-agent-runner.mjs'),'--once'],{cwd:resolve('.'),env:{...envFor(roomId),ROOM_WAKE_ON:'message',ROOM_AGENT_COMMAND:process.execPath,ROOM_AGENT_ARGS:JSON.stringify([fixture]),ROOM_AGENT_SESSION_FILE:join(root,'human-session.json'),FIXTURE_MODE:'success',FIXTURE_ARGV:argvFile},windowsHide:true,stdio:['ignore','pipe','pipe']}));
 let stderr='';child.stderr!.on('data',chunk=>{stderr+=chunk;});
 try{
  await waitFor(()=>stderr.includes('listening room='));
  service.execute({version:'0.1',commandId:uid(),roomId,type:'message.send',payload:{text:'Agent content is not human execution authority',mentions:['demo-planner']}},{id:'demo-reviewer',kind:'agent'});
  await new Promise(resolve=>setTimeout(resolve,600));assert.equal(existsSync(argvFile),false);
  service.execute({version:'0.1',commandId:uid(),roomId,type:'message.send',payload:{text:'Human test request'}});
  await waitFor(()=>child.exitCode!==null||child.signalCode!==null);assert.equal(child.exitCode,0);
  assert.equal(store.list<Message>('messages',roomId).filter(message=>message.actor.id==='demo-planner').length,1);assert.equal(store.list('runs',roomId).length,0);
 }finally{stop(child);}
}

try{
 await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();assert.ok(address&&typeof address==='object');base=`http://127.0.0.1:${address.port}`;
 console.log(`Connector probe loopback: ${base}`);
 await new Promise<void>((done,reject)=>{const child=track(spawn(process.execPath,['--input-type=module','-e',`try{console.log('loopback HTTP', (await fetch(${JSON.stringify(base+'/api/rooms')})).status)}catch(error){console.error('loopback cause:', error.message, error.cause?.code, error.cause?.message);process.exitCode=1}`],{env:envFor('diagnostic'),windowsHide:true,stdio:['ignore','pipe','pipe']}));let output='';child.stdout!.on('data',part=>output+=part);child.stderr!.on('data',part=>output+=part);child.once('close',code=>{console.log(output.trim());code?reject(new Error('Probe child could not reach its loopback server')):done();});});
 service.execute({version:'0.1',commandId:uid(),type:'settings.update',payload:{taskLeaseMs:5000}});
 for(const [name,run] of [
  ['external-mcp',()=>checkMcp('scripts/room-agent-mcp.mjs')],
  ['claude-plugin-mcp',()=>checkMcp('plugins/tempt-room-claude/server/room-agent-mcp.mjs')],
  ['runner-result-and-resume',()=>checkRunner('success')],
  ['runner-persistent-result',()=>checkRunner('persistent')],
  ['runner-error-is-failure',()=>checkRunner('error')],
  ['runner-renews-short-lease',()=>checkRunner('renew')],
  ['runner-timeout-kills-tree',()=>checkRunner('timeout')],
  ['runner-revoked-lease-kills-tree',()=>checkRunner('hang')],
  ['runner-human-wake-only',checkHumanWake],
 ] as const){try{await run();checks.push({name,passed:true,detail:'Passed with temporary rooms and fake CLI; no model request.'});console.log(`${name}: PASS`);}catch(error){checks.push({name,passed:false,detail:(error as Error).message});console.error(`${name}: FAIL`);process.exitCode=1;}}
}finally{
 for(const child of owned)stop(child);await app.close();writeFileSync(join(root,'report.json'),JSON.stringify({checkedAt:new Date().toISOString(),realModels:false,root,checks},null,2));console.log(`Connector report: ${join(root,'report.json')}`);
}
