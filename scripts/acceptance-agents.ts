import { DatabaseSync } from 'node:sqlite';
import { existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../apps/server/src/app.ts';
import { diagnose,probeAgentProtocol } from '../apps/server/src/adapters.ts';
import { runSandboxProgram } from '../apps/server/src/sandbox-program.ts';
import { stageToolchain } from '../apps/server/src/toolchain.ts';
import { redactDiagnostic } from '../apps/server/src/diagnostics.ts';
import { uid,now } from '../apps/server/src/store.ts';
import { agentSchema,terminalStates,type AgentDescriptor,type Artifact,type Command,type Message,type Run,type Task } from '../packages/protocol/src/index.ts';
import { createFixture,checkFixtureChanges,unchangedFixture,verifierSource,checkVerifierOutput } from './acceptance-fixture.ts';
import {nativeAcceptanceTeam,nativeRunEvidence} from './native-acceptance.ts';

const checkOnly=process.argv.includes('--check');
if(!checkOnly&&!process.argv.includes('--allow-paid')){
  console.error('完整验收会调用三个配置的模型，最多约 15 次模型轮次（工具调用可能增加费用）。\n先运行 npm run test:acceptance -- --check；明确同意后运行 npm run test:acceptance -- --allow-paid。');process.exit(2);
}
const source=resolve(process.env.ROOM_STATE_DIR??'.state');
if(existsSync(join(source,'server.lock')))throw new Error('请先正常关闭使用原数据目录的服务');
if(!existsSync(join(source,'room.sqlite')))throw new Error('请先在应用中配置并启用 Codex、Claude、DeepSeek 三个成员');
const database=new DatabaseSync(join(source,'room.sqlite'),{readOnly:true});
const configured=database.prepare('SELECT body FROM agents').all().map((row:any)=>agentSchema.parse(JSON.parse(row.body)));database.close();
const selected=process.argv.find(arg=>arg.startsWith('--agents='))?.slice(9).split(',');
const team=nativeAcceptanceTeam(configured,selected);
const parent=join(source,'acceptance-tests');mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'suite-'));
const {app,store,service,worker}=await createApp({root,startWorker:false});
for(const agent of team)store.put('agents',agent);
const control=new AbortController();const interrupt=()=>control.abort(new Error('用户停止了验收'));process.once('SIGINT',interrupt);
const secrets=team.map(agent=>process.env[agent.credentialEnv]);
const report:{mode:string;root:string;startedAt:string;finishedAt?:string;outcome:string;agents:unknown[];checks:{name:string;status:string;startedAt:string;finishedAt?:string;detail?:string}[]}={mode:checkOnly?'no-model-preflight':'paid-full-suite',root,startedAt:now(),outcome:'running',agents:team.map(({id,name,provider,model,version})=>({id,name,provider,model:model||'runtime-default',configuredVersion:version||'unspecified'})),checks:[]};
const save=()=>writeFileSync(join(root,'acceptance.json'),JSON.stringify(report,null,2));
const command=(roomId:string,type:Command['type'],payload:Record<string,unknown>)=>service.execute({version:'0.1',commandId:uid('acceptance'),...(roomId?{roomId}:{}),type,payload});
const room=(name:string,members:string[])=>command('', 'room.create',{name,members}).result.roomId as string;
const runFor=(taskId:string,version:number)=>store.list<Run>('runs').find(run=>run.taskId===taskId&&run.taskVersion===version)!;
const workspace=(run:Run)=>join(root,'sandboxes',run.id,'workspace');
async function until<T>(read:()=>T|undefined,timeoutMs:number,label:string):Promise<T>{
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){control.signal.throwIfAborted();const value=read();if(value!==undefined)return value;await delay(100,undefined,{signal:control.signal});}
  throw new Error(`等待超时：${label}`);
}
async function finished(id:string,timeoutMs=300000){
  return until(()=>{const run=store.get<Run>('runs',id)!;if(run.status==='waiting_input')throw new Error('模型请求了人工输入，自动场景停止；没有代替用户填写答案');return terminalStates.has(run.status)?run:undefined;},timeoutMs,'run '+id);
}
function completed(run:Run){const agent=team.find(agent=>agent.id===run.agentId);if(!agent)throw new Error('运行成员不属于验收团队');nativeRunEvidence(run,agent,run.roomId,store.list<Message>('messages',run.roomId));}
async function step(name:string,action:()=>Promise<void>){
  const check:{name:string;status:string;startedAt:string;finishedAt?:string;detail?:string}={name,status:'running',startedAt:now()};report.checks.push(check);save();console.log(`→ ${name}`);
  try{await action();check.status='passed';console.log(`✓ ${name}`);}catch(error){check.status='failed';check.detail=redactDiagnostic(error,secrets);throw error;}finally{check.finishedAt=now();save();}
}
function toolEvidence(run:Run,tools:string[]){
  const found=new Set<string>();let cursor=0;
  while(true){const events=store.events(run.roomId,cursor,1000);if(!events.length)break;for(const event of events)if(event.type==='run.tool.completed'&&event.correlationId===run.id&&event.payload.success)found.add(String(event.payload.name));cursor=events.at(-1)!.seq;}
  for(const tool of tools)if(!found.has(tool))throw new Error(`运行没有经过已验证群聊 IPC 完成 ${tool}`);
}
async function verify(run:Run,prefix:'Hello'|'Goodbye'){
  const changes=worker.workspaces.changes(run.id);checkFixtureChanges(changes.changes);
  const tools=await stageToolchain(root),id=uid('verify'),home=join(root,'verifier-homes',id);mkdirSync(home,{recursive:true});
  const output=await runSandboxProgram(worker.host,{runId:id,executable:tools.node,args:['-e',verifierSource(tools.git)],workspace:workspace(run),home,runtimeRoots:tools.runtimeRoots,timeoutMs:45000});
  checkVerifierOutput(output,prefix);toolEvidence(run,['room_read','artifact_publish']);
  return changes;
}
function codingPrompt(prefix:'Hello'|'Goodbye'){
  return `这是显式本机验收任务。读取当前目录的 requirements.json、greet.cjs 和测试。只修改 greet.cjs，导出 greet(name)：字符串 trim，空字符串或非字符串用 friend，返回 "${prefix}, NAME!"。不要修改测试、配置或增加文件，不安装依赖。运行 npm test 与 git status。通过 room_read 读取本轮快照，再通过 artifact_publish 发布名为 acceptance-report.md 的测试报告。请只在当前独立工作区操作，不点名其他成员，不提出新任务。`;
}
async function marker(run:Run,name:string){
  await until(()=>{const current=store.get<Run>('runs',run.id)!;if(terminalStates.has(current.status)||current.status==='waiting_input')throw new Error(`阻塞命令未就绪：${current.status} ${current.error??''}`);return existsSync(join(workspace(run),name))&&current.sandbox?true:undefined;},120000,name);
}
function blockingPrompt(name:'cancel-ready.txt'|'revision-ready.txt'){
  const script=`require('node:fs').writeFileSync('${name}','ready');setInterval(()=>{},1000)`;
  return `这是显式取消验收。先用 room_post 发送公开文字 ACCEPTANCE_BLOCKING_START。然后在当前工作区执行 node -e ${JSON.stringify(script)} 并保持该命令运行，等待用户取消。不要创建新任务，也不要另用编辑工具创建标记文件。`;
}
async function applyFixture(run:Run,project:string){
  unchangedFixture(project);const artifact=store.list<Artifact>('artifacts',run.roomId).find(artifact=>artifact.runId===run.id&&artifact.kind==='patch');
  if(!artifact)throw new Error('没有可审查的文件差异');
  // This suite's only application target is its newly created disposable fixture.
  // All changes have just been restricted to one source file and independently tested.
  command(run.roomId,'artifact.apply',{artifactId:artifact.id});
  if(readFileSync(join(project,'greet.cjs'),'utf8')!==readFileSync(join(workspace(run),'greet.cjs'),'utf8'))throw new Error('应用后的测试源文件与已审查工作区不一致');
}
console.log(`验收数据保留于：${root}`);
try{
  await step('三位成员与系统沙箱前置检查（不调用模型）',async()=>{
    for(const agent of team){const result=checkOnly?await worker.host.probe():await diagnose(agent,worker.host);writeFileSync(join(root,`diagnostic-${agent.id}.json`),JSON.stringify(result,null,2));if(!result.ready)throw new Error(`${agent.name}: ${result.checks.filter(check=>!check.passed).map(check=>check.detail).join('；')}`);}
  });
  for(const agent of team)await step(`${agent.name} 隔离启动与协议检查（不调用模型）`,async()=>{const result=await probeAgentProtocol(agent,worker.host);writeFileSync(join(root,`protocol-${agent.id}.json`),JSON.stringify(result,null,2));if(!result.ready)throw new Error(result.checks.filter(check=>!check.passed).map(check=>check.detail).join('；'));});
  if(checkOnly){report.outcome='ready-for-paid-tests';}
  else{
    worker.start();
    for(const agent of team){
      const roomId=room(`验收 · ${agent.name}`,[agent.id]);
      await step(`${agent.name} 独立请求、续用会话与房间隔离`,async()=>{
        let previous:string|undefined;
        for(let index=0;index<2;index++){
          const before=new Set(store.list<Run>('runs').map(run=>run.id));command(roomId,'message.send',{text:'只回答 ACCEPTANCE_OK，不调用工具。',mentions:[agent.id]});
          const run=store.list<Run>('runs').find(run=>!before.has(run.id))!,result=await finished(run.id);nativeRunEvidence(result,agent,roomId,store.list<Message>('messages',roomId),'ACCEPTANCE_OK');
          if(!result.nativeSessionId)throw new Error('未保存原生会话标识');if(previous&&previous!==result.nativeSessionId)throw new Error('第二次聊天没有续用原生会话');previous=result.nativeSessionId;
          if(!store.list<Message>('messages',roomId).some(message=>message.runId===run.id&&message.text.includes('ACCEPTANCE_OK')))throw new Error('没有收到预期的房间回复');
        }
      });
      await step(`${agent.name} 修改文件、MCP、沙箱复测与显式应用`,async()=>{
        const project=createFixture(root,agent.id),taskId=command(roomId,'task.create',{title:codingPrompt('Hello'),agentId:agent.id,projectPath:project}).result.taskId as string;
        const result=await finished(runFor(taskId,1).id);completed(result);await verify(result,'Hello');await applyFixture(result,project);
      });
      await step(`${agent.name} 取消正在执行的命令`,async()=>{
        const taskId=command(roomId,'task.create',{title:blockingPrompt('cancel-ready.txt'),agentId:agent.id}).result.taskId as string,run=runFor(taskId,1);
        await marker(run,'cancel-ready.txt');command(roomId,'run.cancel',{runId:run.id});const result=await finished(run.id,20000);
        if(result.status!=='canceled'||!result.sandbox||!existsSync(join(workspace(run),'cancel-ready.txt')))throw new Error('未确认取消，或取消后工作区没有保留');
      });
    }
    await step('双 Agent 开发、审查、用户插话与目标版本变更',async()=>{
      const [developer,reviewer]=team,roomId=room('验收 · 协作与目标变更',[developer.id,reviewer.id]),project=createFixture(root,'collaboration');
      const taskId=command(roomId,'task.create',{title:blockingPrompt('revision-ready.txt'),agentId:developer.id,projectPath:project}).result.taskId as string,old=runFor(taskId,1);
      await marker(old,'revision-ready.txt');command(roomId,'message.send',{text:'这是一条普通补充消息，不应自动中止当前运行。'});
      if(store.get<Run>('runs',old.id)?.status!=='running')throw new Error('普通补充消息改变了运行状态');
      writeFileSync(join(project,'requirements.json'),JSON.stringify({prefix:'Goodbye'})+'\n');
      command(roomId,'task.revise',{taskId,title:codingPrompt('Goodbye')});
      if((await finished(old.id,20000)).status!=='canceled')throw new Error('旧目标运行未确认停止');
      const current=await finished(runFor(taskId,2).id);completed(current);await verify(current,'Goodbye');
      const messages=store.list<Message>('messages',roomId).filter(message=>message.runId===old.id);
      if(!messages.length||messages.some(message=>!message.stale))throw new Error('旧运行的 MCP 发言没有标记旧版本');
      const reviewId=command(roomId,'task.create',{title:'审查依赖任务 v2 的交付物和文件差异。使用 room_read 与复制的依赖附件，核对 greet 行为为 Goodbye，测试未修改。用 artifact_publish 发布审查报告，并在公开回复注明 REVIEW_V2_OK；如发现问题请明确报告问题而不要给通过标记。不要修改文件或创建任务。',agentId:reviewer.id,dependencies:[taskId]}).result.taskId as string;
      const review=await finished(runFor(reviewId,1).id);completed(review);toolEvidence(review,['room_read','artifact_publish']);
      if(review.dependencyVersions?.[taskId]!==2||!review.inputArtifacts?.length)throw new Error('审查运行没有绑定 v2 依赖交付物');
      if(!store.list<Message>('messages',roomId).some(message=>message.runId===review.id&&message.text.includes('REVIEW_V2_OK')))throw new Error('审查未明确确认 v2 结果');
      await applyFixture(current,project);
      if(store.get<Task>('tasks',taskId)?.version!==2)throw new Error('任务版本不正确');
    });
    report.outcome='passed-real-agent-scenarios';
  }
}catch(error){report.outcome=control.signal.aborted?'interrupted':'failed';console.error(redactDiagnostic(error,secrets));process.exitCode=control.signal.aborted?130:1;}
finally{await app.close();process.removeListener('SIGINT',interrupt);report.finishedAt=now();save();console.log(`结果：${report.outcome}\n报告：${join(root,'acceptance.json')}`);}
