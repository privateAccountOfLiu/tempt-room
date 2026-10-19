// Model-free feasibility probe. It never starts/resumes a thread or submits input.
import {spawn,spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {randomBytes,createHash} from 'node:crypto';
import {createServer} from 'node:net';
import WebSocket from 'ws';

const {values}=parseArgs({options:{codex:{type:'string'},thread:{type:'string'},transport:{type:'string',default:'stdio'},socket:{type:'string'},out:{type:'string'},timeout:{type:'string',default:'15000'},'require-loaded':{type:'boolean',default:false},help:{type:'boolean'}},allowPositionals:false});
if(values.help){console.log('node scripts/probe-codex-attach.mjs --codex <codex.exe> --thread <UUID> [--transport stdio|proxy|ws] [--socket <path>] [--out <report.json>] [--require-loaded]\nws starts a temporary loopback listener with an in-memory credential and stops only that owned process.\n--require-loaded rejects a server that can read persisted history but does not have the target thread loaded.');process.exit(0);}
if(!values.codex||!values.thread||!/^[-a-zA-Z0-9_]+$/.test(values.thread))throw Error('--codex and --thread are required');
if(!['stdio','proxy','ws'].includes(values.transport))throw Error('Unsupported probe transport');
if(values.socket&&values.transport!=='proxy')throw Error('--socket is only valid with --transport proxy');
const timeout=Number(values.timeout);if(!Number.isInteger(timeout)||timeout<1000||timeout>60000)throw Error('Timeout must be 1000..60000 ms');
const allowedMethods=new Set(['initialize','thread/read','thread/loaded/list','thread/queue/list']);
let port,token;
if(values.transport==='ws'){
  const reservation=createServer();await new Promise((resolve,reject)=>{reservation.once('error',reject);reservation.listen(0,'127.0.0.1',resolve);});port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  token=randomBytes(32).toString('hex');
}
const url=port?`ws://127.0.0.1:${port}`:undefined;
const args=values.transport==='stdio'?['app-server','--stdio']:values.transport==='proxy'?['app-server','proxy',...(values.socket?['--sock',values.socket]:[])]:['app-server','--listen',url,'--ws-auth','capability-token','--ws-token-sha256',createHash('sha256').update(token).digest('hex')];
const report={at:new Date().toISOString(),transport:values.transport,targetThreadId:values.thread,modelRequests:0,mutatingMethods:[],requests:[],notifications:{},outcome:'pending'};
const child=spawn(values.codex,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});
const pending=new Map();let counter=0,stderr='',exited=false,socket;
let sendFrame=frame=>child.stdin.write(JSON.stringify(frame)+'\n');
const processExit=new Promise(resolve=>child.once('exit',(code,signal)=>{exited=true;report.exit={code,signal};for(const {reject,timer} of pending.values()){clearTimeout(timer);reject(Error('Probe transport closed'));}pending.clear();resolve();}));
child.on('error',error=>{for(const {reject,timer} of pending.values()){clearTimeout(timer);reject(error);}pending.clear();});
child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-4000);});
child.stdin.on('error',()=>{});
const lines=createInterface({input:child.stdout});
function acceptFrame(frame){
  if(frame.id!==undefined&&frame.method===undefined&&pending.has(frame.id)){
    const entry=pending.get(frame.id);pending.delete(frame.id);clearTimeout(entry.timer);
    frame.error?entry.reject(Error(frame.error.message??'RPC error')):entry.resolve(frame.result);
  }else if(typeof frame.method==='string'){
    // Count names, never persist conversation content or unrelated thread details.
    report.notifications[frame.method]=(report.notifications[frame.method]??0)+1;
  }
}
lines.on('line',line=>{let frame;try{frame=JSON.parse(line);}catch{return;}acceptFrame(frame);});
function request(method,params){
  if(!allowedMethods.has(method))throw Error('Mutating or unsupported RPC rejected by this probe');
  report.requests.push(method);const id=++counter;
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timed out'));},timeout);pending.set(id,{resolve,reject,timer});sendFrame({jsonrpc:'2.0',id,method,params:params??{}});});
}
try{
  if(values.transport==='ws'){
    report.listener={url,auth:'capability-token',credentialPersisted:false};
    const deadline=Date.now()+timeout;let ready=false;
    while(Date.now()<deadline&&!exited){
      try{const response=await fetch(`http://127.0.0.1:${port}/readyz`,{signal:AbortSignal.timeout(1000)});if(response.ok){ready=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(!ready)throw Error('Temporary authenticated listener did not become ready');
    report.unauthenticatedHandshake=await new Promise((resolve,reject)=>{
      const unauth=new WebSocket(url);const timer=setTimeout(()=>{unauth.terminate();reject(Error('Unauthenticated handshake timed out'));},4000);
      unauth.on('error',()=>{});
      unauth.once('unexpected-response',(_request,response)=>{clearTimeout(timer);const status=response.statusCode;response.destroy();unauth.terminate();resolve({status,rejected:status===401||status===403});});
      unauth.once('open',()=>{clearTimeout(timer);unauth.terminate();resolve({status:101,rejected:false});});
    });
    if(!report.unauthenticatedHandshake.rejected)throw Error('Temporary listener did not enforce authentication');
    socket=new WebSocket(url,{headers:{Authorization:'Bearer '+token}});
    socket.on('error',()=>{});
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Authenticated handshake timed out')),4000);socket.once('open',()=>{clearTimeout(timer);resolve();});socket.once('error',error=>{clearTimeout(timer);reject(error);});socket.once('unexpected-response',(_request,response)=>{clearTimeout(timer);response.destroy();reject(Error('Authenticated handshake rejected with '+response.statusCode));});});
    socket.on('message',data=>{try{acceptFrame(JSON.parse(data.toString()));}catch{}});
    sendFrame=frame=>socket.send(JSON.stringify(frame));
    report.authenticatedHandshake=true;
  }
  const init=await request('initialize',{clientInfo:{name:'tempt_room_attach_probe',title:'Tempt Room read-only attachment probe',version:'0.1.0'},capabilities:{experimentalApi:true}});
  report.server={userAgent:init.userAgent??null,platformFamily:init.platformFamily??null};
  sendFrame({jsonrpc:'2.0',method:'initialized'});
  const before=await request('thread/loaded/list');
  report.loadedBefore={count:before.data?.length??null,containsTarget:before.data?.includes(values.thread)??false};
  try{
    const result=await request('thread/read',{threadId:values.thread,includeTurns:false});
    const thread=result.thread;
    report.target={id:thread.id,cwd:thread.cwd??null,status:thread.status??null,source:thread.source??null,modelProvider:thread.modelProvider??null};
  }catch(error){report.targetReadError=error.message;}
  try{
    const queue=await request('thread/queue/list',{threadId:values.thread,limit:1});
    report.queueRead={supported:true,returnedItems:queue.data?.length??null,hasMore:Boolean(queue.nextCursor)};
  }catch(error){report.queueRead={supported:false,error:error.message};}
  const after=await request('thread/loaded/list');
  report.loadedAfter={count:after.data?.length??null,containsTarget:after.data?.includes(values.thread)??false};
  report.outcome=report.targetReadError?'target-read-failed':report.loadedBefore.containsTarget?'target-already-loaded':'history-readable-but-target-not-loaded';
  report.liveThreadLoadedHere=Boolean(report.loadedBefore.containsTarget&&report.loadedAfter.containsTarget&&report.target?.status?.type!=='notLoaded'&&!report.targetReadError);
  if(values['require-loaded']&&!report.liveThreadLoadedHere){report.outcome='live-attachment-rejected';report.error='This server does not own the loaded target thread; no resume/start fallback was attempted.';}
}catch(error){report.outcome='transport-unavailable';report.error=error.message;}
finally{
  socket?.terminate();
  if(values.transport==='ws'&&!exited){
    try{const response=await fetch(`http://127.0.0.1:${port}/readyz`,{signal:AbortSignal.timeout(1000)});report.clientDisconnectLeavesBackendAlive=response.ok;}catch{report.clientDisconnectLeavesBackendAlive=false;}
  }
  lines.close();child.stdin.end();
  let exitTimer;await Promise.race([processExit,new Promise(resolve=>{exitTimer=setTimeout(resolve,3000);})]);clearTimeout(exitTimer);
  if(!exited&&child.pid){
    if(process.platform==='win32')spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    else child.kill('SIGTERM');
    let finalTimer;await Promise.race([processExit,new Promise(resolve=>{finalTimer=setTimeout(resolve,2000);})]);clearTimeout(finalTimer);
  }
  report.probeChildExited=exited;
  // Only retain generic transport failure diagnostics, not provider credentials.
  report.stderrPresent=Boolean(stderr);
  if(report.outcome==='transport-unavailable')report.transportDiagnostic=stderr.split(/\r?\n/).filter(line=>/connect|sock|os error|socket|套接字|网络/i.test(line)).map(line=>line.replace(/Bearer\s+\S+/gi,'Bearer [redacted]')).slice(0,6).join('\n');
  if(values.out){const file=resolve(values.out);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(report,null,2)+'\n');}
  console.log(JSON.stringify(report,null,2));
  process.exitCode=report.outcome==='live-attachment-rejected'?3:report.outcome==='transport-unavailable'||report.outcome==='target-read-failed'?2:0;
}
