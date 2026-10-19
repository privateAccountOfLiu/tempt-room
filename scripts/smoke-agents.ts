import {createApp} from '../apps/server/src/app.ts';
import {diagnose} from '../apps/server/src/adapters.ts';
import {agentSchema,terminalStates,type Run,type Message,type Diagnostic} from '../packages/protocol/src/index.ts';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {uid,now} from '../apps/server/src/store.ts';
import {redactDiagnostic} from '../apps/server/src/diagnostics.ts';
import {nativeAcceptanceTeam,nativeRunEvidence} from './native-acceptance.ts';

if(!process.argv.includes('--allow-paid')){console.error('真实模型冒烟测试可能产生费用。请显式运行 npm run test:agents -- --allow-paid。');process.exit(2);}
const state=resolve(process.env.ROOM_STATE_DIR??'.state');
if(existsSync(join(state,'server.lock')))throw new Error('请先关闭使用该数据目录的服务；如曾异常终止，请先正常启动并关闭以核对进程锁');
const database=new DatabaseSync(join(state,'room.sqlite'),{readOnly:true});
let configured;
try{configured=database.prepare('SELECT body FROM agents').all().map((row:any)=>agentSchema.parse(JSON.parse(row.body)));}finally{database.close();}
const selected=process.argv.find(arg=>arg.startsWith('--agents='))?.slice(9).split(',');
const team=nativeAcceptanceTeam(configured,selected);
const parent=join(state,'smoke-tests');mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'run-'));
const {app,store,service,worker}=await createApp({root,startWorker:false});
for(const agent of team)store.put('agents',agent);
const report:{startedAt:string;finishedAt?:string;outcome:string;root:string;checks:{agentId:string;status:string;roomId?:string;runId?:string;diagnostic?:Diagnostic;error?:string}[]}={startedAt:now(),outcome:'running',root,checks:[]};
const save=()=>writeFileSync(join(root,'smoke.json'),JSON.stringify(report,null,2));
const secrets=team.map(agent=>process.env[agent.credentialEnv]);
const control=new AbortController(),interrupt=()=>control.abort(new Error('用户停止了冒烟测试'));process.once('SIGINT',interrupt);
console.log(`Isolated smoke state: ${root}`);save();worker.start();
try{
 for(const agent of team){
  control.signal.throwIfAborted();
  const check:typeof report.checks[number]={agentId:agent.id,status:'running'};report.checks.push(check);save();
  try{
   check.diagnostic=await diagnose(agent,worker.host);if(!check.diagnostic.ready)throw new Error(check.diagnostic.checks.filter(item=>!item.passed).map(item=>item.detail).join('；'));
   const roomId=service.execute({version:'0.1',commandId:uid('smoke'),type:'room.create',payload:{name:`冒烟 · ${agent.name}`,members:[agent.id]}}).result.roomId as string;
   check.roomId=roomId;
   service.execute({version:'0.1',commandId:uid('smoke'),roomId,type:'message.send',payload:{text:'请只回答 OK，不调用工具。',mentions:[agent.id]}});
   const created=store.list<Run>('runs',roomId);if(created.length!==1)throw new Error(`预期创建一次运行，实际 ${created.length} 次`);
   check.runId=created[0].id;save();const deadline=Date.now()+300000;
   let run=created[0];
   while(!terminalStates.has(run.status)){
    control.signal.throwIfAborted();
    if(run.status==='waiting_input')throw new Error('模型请求人工输入，冒烟未通过；没有代替用户回答');
    if(Date.now()>=deadline)throw new Error('等待实际运行完成超时');
    await new Promise(done=>setTimeout(done,100));run=store.get<Run>('runs',run.id)!;
   }
   nativeRunEvidence(run,agent,roomId,store.list<Message>('messages',roomId),'OK');
   check.status='passed';console.log(`${agent.name}: completed with a verified sandbox, native session and OK reply`);
  }catch(error){
   check.status='failed';check.error=redactDiagnostic(error,secrets);process.exitCode=1;console.error(`${agent.name}: ${check.error}`);
   if(check.runId){const run=store.get<Run>('runs',check.runId);if(run&&!terminalStates.has(run.status))service.cancel(run);}
   if(control.signal.aborted)throw error;
  }finally{save();}
 }
 report.outcome=report.checks.length===team.length&&report.checks.every(check=>check.status==='passed')?'passed-native-smoke':'failed';
}catch(error){report.outcome=control.signal.aborted?'interrupted':'failed';console.error(redactDiagnostic(error,secrets));process.exitCode=control.signal.aborted?130:1;}
finally{await app.close();process.removeListener('SIGINT',interrupt);report.finishedAt=now();save();console.log(`结果：${report.outcome}\n报告：${join(root,'smoke.json')}`);}
