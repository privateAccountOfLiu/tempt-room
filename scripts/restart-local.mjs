// Restart only the server identified by this workspace's lock. The handoff
// inherits the old process environment in memory; model secrets are never read
// through the debugger or written to a credential file.
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync,existsSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {DatabaseSync} from 'node:sqlite';

const script=fileURLToPath(import.meta.url),workspace=resolve(dirname(script),'..');
const state=resolve(process.env.ROOM_STATE_DIR??join(workspace,'.state'));
const statusPath=join(state,'restart-status.json');
const restartOnly=process.argv.includes('--restart-only');
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
function status(phase,extra={}){writeFileSync(statusPath,JSON.stringify({phase,at:new Date().toISOString(),...extra},null,2));}

async function handoff(oldPid,roomId){
 status('waiting-for-old-server',{oldPid});
 const end=Date.now()+30000;
 while(alive(oldPid)){if(Date.now()>end)throw new Error('Old server has not exited; replacement was not started');await pause(100);}
 const logDir=join(state,'restarts',new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(logDir,{recursive:true});
 const stdoutPath=join(logDir,'stdout.log'),stderrPath=join(logDir,'stderr.log');
 const out=openSync(stdoutPath,'a'),err=openSync(stderrPath,'a');
 const child=spawn(process.execPath,['--require',join(workspace,'node_modules/tsx/dist/preflight.cjs'),'--import',new URL('../node_modules/tsx/dist/loader.mjs',import.meta.url).href,join(workspace,'apps/server/src/main.ts')],{cwd:workspace,env:process.env,detached:true,windowsHide:true,stdio:['ignore',out,err]});
 child.on('error',()=>status('failed',{oldPid,error:'Replacement process could not be started'}));child.unref();closeSync(out);closeSync(err);
 status('starting',{oldPid,newPid:child.pid,stdoutPath,stderrPath});
 let startup;
 for(let i=0;i<600;i++){
  if(!alive(child.pid))throw new Error('Replacement server exited; inspect its local stderr log');
  const match=readFileSync(stdoutPath,'utf8').match(/Open: (http:\/\/127\.0\.0\.1:\d+)\/#session=([a-f0-9]+)/);
  if(match){startup={url:match[1],token:match[2]};break;}await pause(100);
 }
 if(!startup)throw new Error('Replacement server readiness timed out');
 const request=async(path,body)=>{
  const result=await fetch(startup.url+path,{method:body?'POST':'GET',headers:{authorization:`Bearer ${startup.token}`,'Room-Protocol-Version':'0.1',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const value=await result.json();if(!result.ok)throw new Error(`Server request failed: ${result.status} ${value.code??''}`);return value;
 };
 if(restartOnly){
  const capabilities=await request('/api/capabilities');
  status('ready',{oldPid,newPid:child.pid,mode:'restart-only',protocolVersion:capabilities.version,stdoutPath,stderrPath});
  return;
 }
 // Never interrupt or silently reassign existing work.
 const snapshot=await request('/api/rooms/'+encodeURIComponent(roomId));
 if(!snapshot.room.members.includes('codex'))throw new Error('Codex is not a member of the selected room');
 if(snapshot.runs.some(run=>run.agentId==='codex'&&['queued','running','waiting_input','cancel_requested'].includes(run.status)))throw new Error('Codex already has active managed work');
 const agent=snapshot.agents.find(agent=>agent.id==='codex');
 await request('/api/commands',{version:'0.1',commandId:'join_'+randomUUID(),type:'agent.save',payload:{...agent,enabled:true,connectionMode:'external'}});
 const connection=await request(`/api/agents/codex/connect?roomId=${encodeURIComponent(roomId)}`);
 const dir=join(state,'connectors','codex_'+roomId);mkdirSync(dir,{recursive:true});
 const sessionPath=join(dir,'session.json');
 writeFileSync(sessionPath,JSON.stringify({url:connection.url,roomId,agentId:'codex',token:connection.token,connectedAt:new Date().toISOString()},null,2));
 status('ready',{oldPid,newPid:child.pid,roomId,roomName:snapshot.room.name,sessionPath,stdoutPath,stderrPath});
}

async function restart(){
 if(process.platform!=='win32')throw new Error('This restart helper is for Windows');
 if(resolve(process.cwd())!==workspace)throw new Error('Run from the intended workspace');
 const oldPid=Number(JSON.parse(readFileSync(join(state,'server.lock'),'utf8')).pid);
 if(!Number.isSafeInteger(oldPid)||!alive(oldPid))throw new Error('Server lock has no live process');
 const roomId=restartOnly?undefined:process.argv[2];
 if(!restartOnly&&!/^room_[a-zA-Z0-9_-]+$/.test(roomId??''))throw new Error('Pass an explicit room ID or --restart-only');
 const database=new DatabaseSync(join(state,'room.sqlite'),{readOnly:true});
 try{const active=database.prepare('SELECT body FROM runs').all().some(row=>['queued','running','waiting_input','cancel_requested'].includes(JSON.parse(row.body).status));if(active)throw new Error('Room work is active; no restart was scheduled');}finally{database.close();}
 // A preexisting debugger may belong to another app. Do not connect to it.
 await new Promise((done,reject)=>{const probe=createServer();probe.once('error',()=>reject(new Error('Inspector port 9229 is occupied; no process was changed')));probe.listen(9229,'127.0.0.1',()=>probe.close(done));});
 process._debugProcess(oldPid);
 let socket;
 try{
  let endpoint;
  for(let i=0;i<50;i++){try{const targets=await(await fetch('http://127.0.0.1:9229/json/list')).json();endpoint=targets[0]?.webSocketDebuggerUrl;if(endpoint)break;}catch{}await pause(100);}
  if(!endpoint||new URL(endpoint).hostname!=='127.0.0.1')throw new Error('Expected loopback inspector was not available');
  socket=new WebSocket(endpoint);await new Promise((done,reject)=>{socket.addEventListener('open',done,{once:true});socket.addEventListener('error',reject,{once:true});});
  let id=0;const pending=new Map();socket.addEventListener('message',event=>{const reply=JSON.parse(event.data);if(reply.id&&pending.has(reply.id)){const {done,timer}=pending.get(reply.id);clearTimeout(timer);pending.delete(reply.id);done(reply);}});
  const evaluate=expression=>new Promise((done,reject)=>{const requestId=++id,timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('Inspector command timed out'));},5000);pending.set(requestId,{done:reply=>{if(reply.error||reply.result?.exceptionDetails)reject(new Error('Server restart evaluation failed'));else done(reply.result.result.value);},timer});socket.send(JSON.stringify({id:requestId,method:'Runtime.evaluate',params:{expression,returnByValue:true}}));});
  const identity=await evaluate('({pid:process.pid,cwd:process.cwd(),argv:process.argv})');
  if(identity.pid!==oldPid||resolve(identity.cwd)!==workspace||!identity.argv.some(arg=>/apps[\\/]server[\\/]src[\\/]main\.ts$/.test(arg)))throw new Error('Attached process is not this workspace server');
  const result=await evaluate(`(()=>{const child=process.getBuiltinModule('child_process').spawn(process.execPath,${JSON.stringify([script,'--handoff',String(oldPid),restartOnly?'--restart-only':roomId])},{cwd:process.cwd(),env:process.env,detached:true,windowsHide:true,stdio:'ignore'});child.once('error',()=>{});child.once('spawn',()=>setTimeout(()=>process.emit('SIGTERM'),750));child.unref();return {oldPid:process.pid,handoffPid:child.pid};})()`);
  console.log(JSON.stringify({phase:'handoff-scheduled',...result}));
 }finally{if(socket)socket.close();}
}

try{if(process.argv[2]==='--handoff')await handoff(Number(process.argv[3]),restartOnly?undefined:process.argv[4]);else await restart();}
catch(error){if(process.argv[2]==='--handoff')status('failed',{error:error.message});console.error(error.message);process.exitCode=1;}
