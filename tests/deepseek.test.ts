import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { createRequire } from 'node:module';
import { agentSchema,type Run } from '../packages/protocol/src/index.ts';
import { acpModelValue,runAcp,type AcpChannel } from '../apps/server/src/acp.ts';
import { inspectRuntime,stageAgentRuntime } from '../apps/server/src/runtime.ts';
import { chatWorkspace,sessionKey } from '../apps/server/src/sessions.ts';
import { redactDiagnostic } from '../apps/server/src/diagnostics.ts';
const require=createRequire(import.meta.url),{install}=require('../scripts/room-realpath.cjs');
const {chooseWritableRoot,rewritePersistence}=require('../scripts/room-deepseek.cjs');
const model={id:'model',category:'model',options:[{name:'deepseek-test',value:'["official","deepseek-test"]'}]};

test('ACP maps advertised model names to opaque option values and refuses ambiguity',()=>{
 assert.equal(acpModelValue(model,'deepseek-test'),'["official","deepseek-test"]');
 assert.equal(acpModelValue(model,'["official","deepseek-test"]'),'["official","deepseek-test"]');
 assert.throws(()=>acpModelValue(model,'unadvertised'),/可选列表/);
 assert.throws(()=>acpModelValue({options:[...model.options,{name:'deepseek-test',value:'other'}]},'deepseek-test'),/多个匹配/);
});
test('DSH persistence compatibility anchors only canonical directories in declared writable roots',()=>{
 const roots=['D:\\state\\workspace','D:\\state\\home'];
 assert.equal(chooseWritableRoot('d:\\state\\HOME\\dsh\\sessions',roots),roots[1]);
 assert.equal(chooseWritableRoot(roots[0],roots),roots[0]);
 for(const path of ['D:\\','D:\\state\\home-other','D:\\state\\home\\..\\other','C:\\Users\\owner','D:\\state\\runtime'])assert.throws(()=>chooseWritableRoot(path,roots));
 assert.throws(()=>rewritePersistence('unverified vendor source'),/Unsupported DSH/);
});

function mockAcp(signal:AbortSignal,{resume=false,cancel=false}={}){
 const calls:any[]=[],emitted:any[]=[];let cancelProtocol:()=>Promise<void>=async()=>{},finishPrompt:(value:any)=>void=()=>{};
 const channel:AcpChannel={
  async request(method,params:any){
   calls.push({method,params});
   if(method==='initialize')return {protocolVersion:1,agentCapabilities:{sessionCapabilities:{resume:true,close:true}}};
   if(['session/new','session/resume'].includes(method))return {sessionId:'s1',configOptions:[model]};
   if(method==='session/prompt'){
    channel.onFrame?.({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Hello'}}}});
    channel.onFrame?.({id:7,method:'session/request_permission',params:{options:[{kind:'reject_once',optionId:'no'},{kind:'allow_once',optionId:'yes'}]}});
    if(cancel)return new Promise(resolve=>{finishPrompt=resolve;});
    return {stopReason:'end_turn'};
   }
   return {};
  },
  async send(method,params){calls.push({method,params});if(method==='session/cancel')finishPrompt({stopReason:'cancelled'});},
  async reply(id,result){calls.push({id,result});}
 };
 const running=runAcp({channel,workspace:resolve('workspace'),model:'deepseek-test',nativeSession:resume?'s1':undefined,prompt:'test',mcpServers:[{name:'room',command:'node.exe',args:['bridge.mjs'],env:[{name:'ROOM_PIPE',value:'scoped'}]}],signal,emit:item=>emitted.push(item),setCancel:fn=>{cancelProtocol=fn;},onError:error=>{throw error;}});
 return {calls,emitted,running,cancel:()=>cancelProtocol()};
}
test('ACP lifecycle uses MCP env arrays, streams messages, allows advertised permission and closes idle sessions',async()=>{
 const mock=mockAcp(new AbortController().signal);await mock.running;
 assert.deepEqual(mock.calls.map(call=>call.method??'reply'),['initialize','session/new','session/set_config_option','session/prompt','reply','session/close']);
 assert.deepEqual(mock.calls[1].params.mcpServers[0].env,[{name:'ROOM_PIPE',value:'scoped'}]);
 assert.equal(mock.calls[2].params.value,'["official","deepseek-test"]');
 assert.deepEqual(mock.calls[4],{id:7,result:{outcome:{outcome:'selected',optionId:'yes'}}});
 assert.deepEqual(mock.emitted,[{type:'session',id:'s1'},{type:'text',text:'Hello'}]);
 const resumed=mockAcp(new AbortController().signal,{resume:true});await resumed.running;
 assert.equal(resumed.calls[1].method,'session/resume');assert.equal(resumed.calls[1].params.sessionId,'s1');
});
test('ACP cancellation sends a protocol notification and waits for the active prompt',async()=>{
 const controller=new AbortController(),mock=mockAcp(controller.signal,{cancel:true});
 const rejected=assert.rejects(mock.running,/abort/i);
 while(!mock.calls.some(call=>call.method==='session/prompt'))await new Promise(resolve=>setTimeout(resolve,1));
 controller.abort();await mock.cancel();await rejected;
 assert.equal(mock.calls.at(-1).method,'session/cancel');assert.ok(!mock.calls.some(call=>call.method==='session/close'));
});
test('chat sessions keep cwd stable while new task snapshots and configuration changes get separate scopes',()=>{
 const agent=agentSchema.parse({id:'dsh',name:'DSH',provider:'deepseek'}),run={id:'run1',roomId:'room1',agentId:agent.id} as Run;
 const a=chatWorkspace(resolve('.state'),run),b=chatWorkspace(resolve('.state'),{...run,id:'run2'} as Run);
 assert.equal(a,b);assert.equal(sessionKey(run,agent,a),sessionKey({...run,id:'run2'},agent,b));
 assert.notEqual(sessionKey(run,agent,a),sessionKey(run,{...agent,model:'changed'},a));
 assert.notEqual(sessionKey({...run,taskId:'task'},agent,resolve('snapshot1')),sessionKey({...run,taskId:'task'},agent,resolve('snapshot2')));
});
test('runtime staging includes changed asar dependencies in its content identity and verifies package version pins',async t=>{
 const parent=resolve('.state/test-data');await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'runtime-'));t.after(async()=>{assert.ok(root.startsWith(parent));await rm(root,{recursive:true,force:true});});
 const source=join(root,'source');await mkdir(join(source,'resources','app.asar.unpacked'),{recursive:true});
 await writeFile(join(source,'DeepSeek Harness.exe'),'fake test binary');await writeFile(join(source,'resources','app.asar'),'v1');await writeFile(join(source,'resources','app.asar.unpacked','package.json'),'{}');
 const agent=agentSchema.parse({id:'deepseek',name:'DSH',provider:'deepseek',executable:join(source,'DeepSeek Harness.exe')});
 const layout=await inspectRuntime(agent,agent.executable);assert.equal(layout.kind,'deepseek-desktop');
 const first=await stageAgentRuntime(layout,join(root,'state'),agent.id);assert.equal(await readFile(join(first,'resources','app.asar'),'utf8'),'v1');
 await writeFile(join(source,'resources','app.asar'),'v2');const second=await stageAgentRuntime(layout,join(root,'state'),agent.id);assert.notEqual(first,second);
 assert.equal(await readFile(join(first,'resources','app.asar'),'utf8'),'v1');assert.equal(await readFile(join(second,'resources','app.asar'),'utf8'),'v2');
 assert.equal((JSON.parse(await readFile(join(second,'complete.json'),'utf8'))).files,3);
 const npmRoot=join(root,'npm'),packageRoot=join(npmRoot,'node_modules','@deepseek-ai','dsh');await mkdir(join(packageRoot,'lib'),{recursive:true});
 await writeFile(join(packageRoot,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh',version:'fixed',bin:{dsh:'lib/bin.js'}}));await writeFile(join(packageRoot,'lib','bin.js'),'');
 const configured=agentSchema.parse({...agent,executable:join(packageRoot,'lib','bin.js'),runtimeDirectory:npmRoot,version:'fixed'});
 assert.equal((await inspectRuntime(configured,configured.executable)).kind,'deepseek-node');
 await assert.rejects(inspectRuntime({...configured,version:'different'},configured.executable),/版本/);
});
test('runtime compatibility does not convert missing, outside-root or symlink paths into valid real paths',async()=>{
 const denied=Object.assign(new Error('denied'),{code:'EPERM'}),missing=Object.assign(new Error('missing'),{code:'ENOENT'}),root=resolve('permitted');
 const original:any=()=>{throw denied;};original.native=original;
 const fake:any={realpathSync:original,realpath:(value:any,options:any,callback:any)=>callback(denied),lstatSync:(value:string)=>{if(value.endsWith('missing'))throw missing;return {isSymbolicLink:()=>value.endsWith('link')};},promises:{realpath:async()=>{throw denied;}}};
 install(fake,[root]);assert.equal(fake.realpathSync(join(root,'file')),join(root,'file'));
 assert.throws(()=>fake.realpathSync(join(root,'missing')),error=>error===missing);assert.throws(()=>fake.realpathSync(resolve('outside')),error=>error===denied);assert.throws(()=>fake.realpathSync(join(root,'link')),error=>error===denied);
 assert.equal(await fake.promises.realpath(join(root,'file')),join(root,'file'));
 await new Promise<void>((resolvePromise,reject)=>fake.realpath(join(root,'file'),(error:any,value:string)=>{if(error)return reject(error);assert.equal(value,join(root,'file'));resolvePromise();}));
});
test('provider diagnostics remove full secrets, masked fragments, authorization, query credentials and request identifiers',()=>{
 const value=redactDiagnostic('bad exact-secret Authorization: Bearer token-value key ****-tail https://user:pass@example.com/error?api_key=value#secret request_id: internal-id',['exact-secret']);
 for(const part of ['exact-secret','token-value','****-tail','api_key','user:pass','internal-id'])assert.ok(!value.includes(part),part);
 assert.ok(value.includes('https://example.com/error'));
});
