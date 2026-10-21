import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,existsSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {agentSchema,defaultSandbox,type Run,type Message} from '../packages/protocol/src/index.ts';
import {nativeAcceptanceTeam,nativeRunEvidence} from '../scripts/native-acceptance.ts';
import {Store} from '../apps/server/src/store.ts';

const team=()=>['codex','claude','deepseek'].map(provider=>agentSchema.parse({id:provider,name:provider,provider,enabled:true}));
test('native acceptance requires one managed sandbox member from each provider without changing its configuration',()=>{
 const configured=team(),before=JSON.stringify(configured);assert.deepEqual(nativeAcceptanceTeam(configured).map(agent=>agent.provider),['codex','claude','deepseek']);
 assert.equal(JSON.stringify(configured),before);
 assert.throws(()=>nativeAcceptanceTeam(configured,['codex','codex','deepseek']),/各一位/);
 assert.throws(()=>nativeAcceptanceTeam(configured,['codex','claude','missing']),/各一位/);
 configured[0].connectionMode='external';assert.throws(()=>nativeAcceptanceTeam(configured),/外部会话/);
 configured[0].connectionMode='managed';configured[2].executionMode='host';assert.throws(()=>nativeAcceptanceTeam(configured),/本机直连/);
});

test('native smoke evidence rejects zero runs, foreign replies, stale results and unverified execution',()=>{
 const agent=team()[0],timestamp=new Date().toISOString();
 const run:Run={id:'run_verified',roomId:'room_selected',agentId:agent.id,status:'completed',prompt:'only OK',basedOnSeq:2,createdAt:timestamp,updatedAt:timestamp,nativeSessionId:'native-session',sandbox:{...defaultSandbox,verifiedAt:timestamp}};
 const reply:Message={id:'message_verified',roomId:run.roomId,actor:{id:agent.id,kind:'agent'},text:'OK',mentions:[],attachments:[],createdAt:timestamp,runId:run.id};
 assert.equal(nativeRunEvidence(run,agent,run.roomId,[reply],'OK'),run);
 assert.throws(()=>nativeRunEvidence(undefined,agent,run.roomId,[reply],'OK'),/没有创建实际运行/);
 assert.throws(()=>nativeRunEvidence({...run,status:'unknown'},agent,run.roomId,[reply],'OK'),/未完成/);
 assert.throws(()=>nativeRunEvidence({...run,sandbox:undefined},agent,run.roomId,[reply],'OK'),/AppContainer/);
 assert.throws(()=>nativeRunEvidence({...run,sandbox:{...run.sandbox!,verifiedAt:'invalid'}},agent,run.roomId,[reply],'OK'),/AppContainer/);
 assert.throws(()=>nativeRunEvidence({...run,nativeSessionId:''},agent,run.roomId,[reply],'OK'),/原生会话/);
 for(const invalid of [{...reply,roomId:'room_other'},{...reply,runId:'run_other'},{...reply,actor:{id:'claude',kind:'agent' as const}},{...reply,stale:true},{...reply,text:'I did not produce OK'}])assert.throws(()=>nativeRunEvidence(run,agent,run.roomId,[invalid],'OK'),/有效预期回复/);
 assert.throws(()=>nativeRunEvidence({...run,roomId:'room_other'},agent,reply.roomId,[reply],'OK'),/身份或房间/);
});

test('actual acceptance entry points reject external and host fixtures before any probe or model state is created',t=>{
 const parent=resolve('.state/test-data');mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'acceptance-gates-'));
 t.after(()=>{assert.ok(root.startsWith(parent));rmSync(root,{recursive:true,force:true});});
 for(const mode of ['external','host'] as const){
  const source=join(root,mode),store=new Store(join(source,'room.sqlite'));
  for(const agent of team()){agent.executable=join(source,'nonexistent-fixture.exe');agent.credentialEnv='ROOM_TEST_UNSET';if(agent.id==='codex'&&mode==='external')agent.connectionMode='external';if(agent.id==='deepseek'&&mode==='host')agent.executionMode='host';store.put('agents',agent);}store.close();
  for(const [script,flag] of [['scripts/smoke-agents.ts','--allow-paid'],['scripts/acceptance-agents.ts','--check']]){
   const result=spawnSync(process.execPath,['--import','tsx',script,flag],{cwd:resolve('.'),env:{...process.env,ROOM_STATE_DIR:source},encoding:'utf8',timeout:60000,windowsHide:true});
   assert.equal(result.error,undefined);assert.equal(result.status,1,result.stderr);
   assert.match(result.stderr,mode==='external'?/外部会话/:/本机直连/);
   assert.equal(existsSync(join(source,'smoke-tests')),false);assert.equal(existsSync(join(source,'acceptance-tests')),false);
  }
 }
});
