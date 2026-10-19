import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { defaultSandbox, terminalStates,PARTIAL_INTERVAL_MS,PARTIAL_MAX_BYTES,contextSeqOf, VERSION, ProtocolError,budgetError,classifyFailure, type AgentDescriptor, type Artifact, type Discussion, type Message, type Run, type Task, type StreamDelta, type ToolOperation } from '../../../packages/protocol/src/index.ts';
import { diagnose, ExecutionUnknown, RemoteCanceled, runAdapter } from './adapters.ts';
import { SandboxHost } from './sandbox.ts';
import { digest, now, Store, SYSTEM, uid } from './store.ts';
import { RoomService } from './service.ts';
import { Workspaces } from './workspaces.ts';
import { chatWorkspace,sessionKey } from './sessions.ts';
import { redactDiagnostic } from './diagnostics.ts';
import { runContext } from './context.ts';
import {contextDelta,advanceContext,assertContextCurrent,reconciliationPrompt} from './context-reconciliation.ts';
import { captureContext } from './context.ts';
import { fairOrder } from './scheduler.ts';
import { trustForActor } from './trust.ts';
import { assertRoomPostLength, assertRoomToolAllowed, assertTaskTitleLength } from './tool-policy.ts';
import { formatContextMessage, UNTRUSTED_CONTEXT_NOTICE } from './context-format.ts';
import { dependencyInputs } from './dependencies.ts';
import { codexThreadKey, reconcileAttachedRun } from './codex-attach.ts';
import { assertRunFence,assertRunIdentity,executionFence } from './execution.ts';
import { ToolOperations } from './tool-operations.ts';
import {NativeOperations} from './native-operations.ts';
import {NativeExecutionFailed} from './errors.ts';
import type { RunFence,AgentOutput }  from '../../../packages/protocol/src/index.ts';

/** A hard budget stop is a failed run, not a user cancellation. */
class BudgetExceeded extends Error {}

import type { CodexRunState } from '../../../packages/protocol/src/index.ts';

/**
 * Chat runs share one persistent workspace per room/agent. Give it a Git
 * baseline: DSH's turn recorder locates the project root by walking up from
 * the workspace, and the AppContainer realpath compatibility layer only
 * attests staged roots, so a walk above the workspace fails with EPERM.
 * Task workspaces already carry a Git baseline from the snapshot.
 */
function prepareChatWorkspace(root:string,run:Run):string{
  const workspace=chatWorkspace(root,run);mkdirSync(workspace,{recursive:true});
  if(!existsSync(join(workspace,'.git')))try{spawnSync('git',['init','--quiet','.'],{cwd:workspace,windowsHide:true,timeout:15000,stdio:'ignore'});}catch{}
  return workspace;
}

/** Host-mode chat runs share one concrete directory per room, so agents can see each other's files. */
function prepareHostChatWorkspace(root:string,run:Run):string{
  const workspace=join(root,'workspaces','rooms',run.roomId);mkdirSync(workspace,{recursive:true});
  if(!existsSync(join(workspace,'.git')))try{spawnSync('git',['init','--quiet','.'],{cwd:workspace,windowsHide:true,timeout:15000,stdio:'ignore'});}catch{}
  return workspace;
}

/** Snapshot of the real project's Git status; undefined when the directory is not a Git repository. */
function hostStatus(projectPath:string):Map<string,string>|undefined{  const result=spawnSync('git',['-C',projectPath,'status','--porcelain=v1','-z'],{encoding:'utf8',windowsHide:true,timeout:30000});
  if(result.status!==0)return undefined;
  const status=new Map<string,string>();
  for(const entry of (result.stdout||'').split('\0')){if(!entry)continue;status.set(entry.slice(3),entry.slice(0,2));}
  return status;
}

/**
 * Host-mode tasks edit the real project directly (no snapshot and no apply step).
 * Report the files this run actually touched so a human can review them in Git.
 */
function hostChangeReport(projectPath:string,baseline?:Map<string,string>):string{
  const status=hostStatus(projectPath);
  if(!status)return `本机直连模式已直接在真实目录中执行并可能修改文件；该目录不是 Git 仓库，无法生成差异清单。\n项目目录：${projectPath}`;
  const changed=[...status].filter(([path,code])=>!baseline||baseline.get(path)!==code);
  if(!changed.length)return `本机直连模式执行完成；Git 工作树没有新增改动。\n项目目录：${projectPath}`;
  const stat=spawnSync('git',['-C',projectPath,'diff','--stat','--',...changed.map(([path])=>path)],{encoding:'utf8',windowsHide:true,timeout:30000});
  return [`本机直连模式已直接修改真实项目（没有经过快照，也不需要“应用交付物”）：`,`项目目录：${projectPath}`,'',`变更文件（Git 状态 + 路径）：`,...changed.map(([path,code])=>`${code} ${path}`),'',stat.stdout?.trim()||'','', '请用 Git 审查并提交这些改动。'].join('\n').slice(0,2**20-1000);
}

/**
 * Host-mode chat runs share one workspace per room. Commit after every run so
 * multiple Agents hand off work through traceable Git checkpoints instead of
 * overwriting each other's files invisibly.
 */
function commitSharedWorkspace(workspace:string,message:string):{changed:boolean;commit?:string}{
  const git=(args:string[])=>spawnSync('git',['-C',workspace,...args],{encoding:'utf8',windowsHide:true,timeout:20000});
  if(git(['rev-parse','--is-inside-work-tree']).status!==0)return{changed:false};
  if(!git(['status','--porcelain=v1']).stdout?.trim())return{changed:false};
  git(['add','-A']);
  const commit=git(['-c','user.name=Tempt Room','-c','user.email=room@localhost','commit','--quiet','-m',message]);
  if(commit.status!==0)return{changed:false};
  return{changed:true,commit:git(['rev-parse','HEAD']).stdout?.trim()||undefined};
}

export class Worker {
  readonly host: SandboxHost;
  readonly workspaces: Workspaces;
  private active = new Map<string, AbortController>();
  private executions=new Map<string,Readonly<RunFence>>();
  private operations:ToolOperations;
  private nativeOperations:NativeOperations;
  private inputs = new Map<string,{fence:RunFence;receive:(text:string)=>void}>();
  private timer?: NodeJS.Timeout;
  private closed = false;
  private fairServed = new Map<string,number>();
  private toolCalls = new Map<string,number>();
  readonly streamListeners = new Set<(delta: StreamDelta) => void>();
  constructor(public store: Store, public service: RoomService, public root: string,private options:{adapter?:typeof runAdapter}={}) {
    this.operations=new ToolOperations(store,()=>store.settings().maxToolResultBytes);
    this.nativeOperations=new NativeOperations(store);
    this.host = new SandboxHost(root, resolve('sandbox/RoomSandbox/bin/Release/net10.0-windows/RoomSandbox.exe'));
    this.workspaces = new Workspaces(root);
    service.onCancel = id => this.active.get(id)?.abort(new Error('用户取消'));
    service.onInput = (id, text) => {
      const input=this.inputs.get(id);if(!input)throw new Error('输入通道已断开，请修改目标后重新启动');
      assertRunFence(store,input.fence);
      const run=store.get<Run>('runs',id)!;run.status='running';run.updatedAt=now();store.event(run.roomId,'run.updated',SYSTEM,{run},null,id);
      queueMicrotask(()=>input.receive(text));
    };
    service.onApply = id => this.apply(id);
    this.host.on('notification', frame => {
      if (frame.type === 'sandbox.toolRequest') void this.handleTool(frame);
      if(frame.type==='sandbox.started'&&frame.appContainer&&frame.job){
        const fence=this.executions.get(frame.runId);if(!fence)return;
        try { const run=assertRunFence(this.store,fence);if(frame.limits){run.sandbox={...defaultSandbox,...frame.limits,verifiedAt:now()};this.store.event(run.roomId,'sandbox.verified',SYSTEM,{runId:run.id,generation:fence.generation,executionId:fence.executionId,sandbox:run.sandbox},null,run.id);} } catch { /* An old process cannot refresh a newer run's sandbox proof. */ }
      }
    });
  }
  start() { this.timer = setInterval(() => this.tick(), 250); this.timer.unref(); this.tick(); queueMicrotask(() => this.recoverInterrupted()); }
  tick() {
    if (this.closed) return;
    this.store.atomic(() => {
      for(const fence of this.executions.values()){
        let run:Run;try{run=assertRunFence(this.store,fence,{allowTerminal:true,allowStaleTask:true});}catch{continue;}
        if(!['running','waiting_input'].includes(run.status)||!run.leaseUntil)continue;
        if(Date.parse(run.leaseUntil)<=Date.now()){
          run.generation=(run.generation??1)+1;delete run.executionId;delete run.leaseUntil;run.status=run.codex?'unknown':'interrupted';run.error='执行租约过期；旧进程结果已隔离，副作用需核对';run.updatedAt=now();
          this.store.event(run.roomId,'run.recovered',SYSTEM,{run},null,run.id);
          if(run.taskId){const task=this.store.get<Task>('tasks',run.taskId);if(task&&task.version===run.taskVersion){task.status=run.status;this.store.event(run.roomId,'task.updated',SYSTEM,{task});}}
          this.active.get(run.id)?.abort(new Error('执行租约过期'));this.service.settleDiscussion(run);
        }else if(Date.parse(run.leaseUntil)-Date.now()<this.store.settings().taskLeaseMs/2){
          run.leaseUntil=new Date(Date.now()+this.store.settings().taskLeaseMs).toISOString();run.updatedAt=now();this.store.event(run.roomId,'run.lease.renewed',SYSTEM,{run},null,run.id);
        }
      }
      for (const discussion of this.store.list<Discussion>('discussions')) if (discussion.status === 'active' && Date.now() >= Date.parse(discussion.deadline)) this.service.stopDiscussion(discussion, '讨论时间上限');
      // External Agents heartbeat while they run. If the lease expires without a
      // heartbeat (runner died), return the task to the open pool for re-claim.
      for (const task of this.store.list<Task>('tasks')) {
        if (task.status !== 'running' || !task.leaseUntil || Date.now() <= Date.parse(task.leaseUntil)) continue;
        const hasManagedRun = this.store.list<Run>('runs', task.roomId).some(run => run.taskId === task.id && !terminalStates.has(run.status));
        if (hasManagedRun) continue;
        const previousAgentId = task.agentId;
        task.status = 'proposed'; task.agentId = 'unassigned'; task.open = true; task.version += 1; task.generation=(task.generation??1)+1;delete task.leaseUntil;delete task.externalContext;
         this.store.event(task.roomId, 'task.lease_expired', SYSTEM, { task, previousAgentId });
      }
    });
    const runs = this.store.list<Run>('runs');
    const settings=this.store.settings();
    for (const run of fairOrder(runs,this.fairServed,this.schedulerWeights())) {
      if (this.active.size >= settings.concurrency) break;
      if (run.status !== 'queued' || this.active.has(run.id)) continue;
      const thread = this.threadKey(run);
      if (thread && runs.some(other => other.id !== run.id && this.threadKey(other) === thread &&
        (this.active.has(other.id) || (other.codex && !['completed','canceled'].includes(other.codex.phase) && ['unknown','interrupted'].includes(other.status))))) continue;
      if ([...this.active.keys()].some(id => { const r = this.store.get<Run>('runs', id); return r?.agentId === run.agentId && r.roomId === run.roomId; })) continue;
      // Host-mode tasks edit the real project in place: never let two of them
      // write the same directory at once. Other work keeps running in parallel.
      const projectKey = this.hostProjectKey(run);
      if (projectKey && [...this.active.keys()].some(id => this.hostProjectKey(this.store.get<Run>('runs', id)) === projectKey)) continue;
      if (run.taskId) {
        const task = this.store.get<Task>('tasks', run.taskId)!;
        const dependencies = task.dependencies.map(id => this.store.get<Task>('tasks', id));
        if (dependencies.some(t => !t || ['failed','canceled','superseded','interrupted','unknown'].includes(t.status))) { this.finish(run, 'failed', '依赖任务未成功'); continue; }
        if (dependencies.some(t => t?.status !== 'completed')) continue;
        try{const inputs=dependencyInputs(this.store,task);run.dependencyVersions=inputs.versions;run.inputArtifacts=inputs.artifacts;}catch(error){this.finish(run,'failed',(error as Error).message);continue;}
      }
      const controller = new AbortController(); this.active.set(run.id, controller);
      this.fairServed.set(run.roomId+'/'+run.agentId,Date.now());
      // Legacy queued work keeps its original authorization: no implicit extra
      // model turns on upgrade, but old-context success is still rejected.
      run.contextPolicy??={...settings.contextPolicy,maxRounds:0};run.lifecycleVersion??=1;
      run.limits??={memoryMb:settings.memoryMb,maxProcesses:settings.maxProcesses,timeoutMs:run.taskId?settings.taskTimeoutMs:settings.chatTimeoutMs,tokenBudget:settings.tokenBudget,costBudgetUsd:settings.costBudgetUsd};
      run.generation??=1;run.executionId=uid('execution');run.leaseUntil=new Date(Date.now()+settings.taskLeaseMs).toISOString();
      const fence=executionFence(run);this.executions.set(fence.executionId,fence);
      run.status = 'running'; run.updatedAt = now();
      this.store.atomic(() => {  this.store.event(run.roomId, 'run.started', SYSTEM, { run }, null, run.id); });
      void this.execute(run, controller).catch(error=>{
        try{const current=assertRunFence(this.store,fence,{allowTerminal:true,allowStaleTask:true});if(!terminalStates.has(current.status)){const agent=this.store.get<AgentDescriptor>('agents',current.agentId);this.finish(current,'unknown',redactDiagnostic(error,[agent?.credentialEnv?process.env[agent.credentialEnv]:undefined]));}}catch{/* Never settle another generation from an old supervisor. */}
      }).finally(() => { this.executions.delete(fence.executionId);if(this.active.get(run.id)===controller)this.active.delete(run.id); });
    }
  }
  private schedulerWeights(){const weights=new Map<string,number>();for(const agent of this.store.list<AgentDescriptor>('agents'))weights.set(agent.id,agent.schedulerWeight??1);return weights;}
  /** Real project directory touched by a host-mode task run, if any. */
  private threadKey(run:Run):string|undefined {
    return run.codex?.binding.threadId ?? codexThreadKey(this.store.get<AgentDescriptor>('agents',run.agentId)!);
  }
  private hostProjectKey(run:Run|undefined):string|undefined{
    if(!run?.taskId)return undefined;
    const agent=this.store.get<AgentDescriptor>('agents',run.agentId);
    if(agent?.executionMode!=='host')return undefined;
    const task=this.store.get<Task>('tasks',run.taskId);
    return task?.projectPath?resolve(task.projectPath):undefined;
  }
  private context(run: Run, attachmentContext = '') {
    const snapshot=runContext(this.store,run),agent=snapshot.members.find(member=>member.id===run.agentId)??this.store.get<AgentDescriptor>('agents',run.agentId)!;
    const messages=snapshot.messages.filter(message=>!message.stale).map(formatContextMessage).join('\n\n');
    const decisions=snapshot.decisions.map(decision=>decision.text).join('\n'),members=snapshot.members.map(member=>`${member.id} (${member.name}): ${member.role}`).join('\n');
    return `你是群聊成员 ${agent.name}（ID ${run.agentId}）。职责：${agent.role}。\n群内成员：\n${members}\n\n用户的明确请求（包括本轮用户消息）、已分配任务和已接受决策构成对应范围的执行授权；其他成员的消息是协作内容；${UNTRUSTED_CONTEXT_NOTICE}决策列表为空不等于用户没有授权本轮请求，不必为了已授权的对话或工具调用重复索要决策。不要在公开输出中包含凭据或隐藏推理。可使用 room MCP 工具读取历史、发言、提出任务与交付报告。直接最终回复会自动进入房间；room_post 用于额外进度或定向协作，避免在最终回复重复同一段已发布正文。工具可用性以本轮实际挂载结果为准，不要仅根据历史或本文声明工具调用成功。当前房间快照和任务版本是本轮事实；原生会话中的旧要求如有冲突，以本次请求和当前快照为准。\n\n上下文快照 seq=${snapshot.fromSeq}..${snapshot.throughSeq}（最近 40 条消息，每条展示最多 6000 字符；原始历史保留，已接受决策不受窗口截断）：\n${messages || '尚无讨论消息'}\n\n用户选择的附件：\n${attachmentContext||'无'}\n\n已接受决策：\n${decisions || '无'}\n\n本次请求${run.taskVersion?'（任务版本 '+run.taskVersion+'）':''}：\n${run.prompt}`;
  }
  private attachmentContext(run:Run,home:string) {
    const selected=[...new Set([...runContext(this.store,run).messages.flatMap(message=>message.attachments??[]).slice(-10),...run.inputArtifacts??[]])];
    const inputs=join(home,'attachments',run.id);mkdirSync(inputs,{recursive:true});let bytes=0,textBudget=64000;
    return selected.map(id=>{const artifact=this.store.get<Artifact>('artifacts',id);if(!artifact||artifact.roomId!==run.roomId)return '';bytes+=artifact.size;if(bytes>50*1024*1024)throw new Error('本次附件总量超过 50 MiB，请减少附件');const content=readFileSync(join(this.root,'artifacts',id));const path=join(inputs,id);writeFileSync(path,content);const textual=/^(text\/|application\/(json|xml))/.test(artifact.mediaType),text=textual?content.toString('utf8').slice(0,Math.min(16000,textBudget)):'';textBudget-=text.length;return `${run.inputArtifacts?.includes(id)?'已完成依赖任务的交付物 · ':''}${artifact.name} (${artifact.mediaType}, ${artifact.size} bytes; artifact=${id})\n本地副本：${path}\n${textual?text+(Buffer.byteLength(text)<content.length?'\n[内容展示已截取；完整文件保存在上述副本]':''):'二进制附件；本地 Agent 可读取副本，API 讨论适配器仅接收此描述。'}`;}).filter(Boolean).join('\n\n');
  }
  private requestInput(run:Run,question:string,signal:AbortSignal):Promise<string> {
    signal.throwIfAborted();assertRunIdentity(this.store,run);this.publishMessage(run,question,uid('msg'),false,true);
    const current=this.store.get<Run>('runs',run.id)!;current.status='waiting_input';current.updatedAt=now();this.store.atomic(()=>{this.store.event(run.roomId,'run.updated',SYSTEM,{run:current},null,run.id);});
    const fence=executionFence(run);
    return new Promise((resolve,reject)=>{
      const cleanup=()=>{if(this.inputs.get(run.id)?.fence===fence)this.inputs.delete(run.id);signal.removeEventListener('abort',abort);};
      const abort=()=>{cleanup();try{const current=assertRunIdentity(this.store,run,true);if(current.status==='waiting_input'){current.status='running';current.updatedAt=now();this.store.event(run.roomId,'run.updated',SYSTEM,{run:current},null,run.id);}}catch{/* A previous generation cannot resume the current input wait. */}reject(signal.reason);};
      this.inputs.set(run.id,{fence,receive:text=>{cleanup();try{assertRunIdentity(this.store,run);resolve(text);}catch(error){reject(error);}}});
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    });
  }
  private async consumeAttempt(run:Run,controller:AbortController,options:{agent:AgentDescriptor;workspace:string;home:string;scope:string;prompt:string;hostMode:boolean;attached:boolean}){
    const {agent,workspace,home,scope,prompt,hostMode,attached}=options,fence=executionFence(run);
    const artifacts:Extract<AgentOutput,{type:'artifact'}>[]=[];
    let nativeIntent:ToolOperation|undefined;
    let text = '', messageId = uid('msg'), deltaIndex = 0,partialTimer:ReturnType<typeof setTimeout>|undefined;
    const checkpoint=()=>{clearTimeout(partialTimer);partialTimer=undefined;try{const saved=this.publishPartial(run,text,messageId,Math.max(0,deltaIndex-1));if(!saved){const current=this.store.get<Run>('runs',run.id);if(current?.partial&&!current.finalMessageId&&['running','waiting_input'].includes(current.status)){partialTimer=setTimeout(checkpoint,Math.max(1,PARTIAL_INTERVAL_MS-(Date.now()-Date.parse(current.partial.createdAt))));partialTimer.unref();}}}catch{/* Cancellation or a new generation revokes this draft writer. */}};
    try {
      if(['codex','claude','deepseek'].includes(agent.provider))nativeIntent=this.nativeOperations.begin(fence,agent,prompt,attached?undefined:this.store.session(scope));
      const saveCodexState=(state:CodexRunState)=>{
        assertRunIdentity(this.store,run);
        run.codex=state;run.nativeSessionId=state.binding.threadId;
        const current=this.store.get<Run>('runs',run.id)!;
        current.codex=state;current.nativeSessionId=state.binding.threadId;
        if(current.status!=='cancel_requested')current.status='running';
        current.updatedAt=now();this.store.atomic(()=>{this.store.event(run.roomId,'run.updated',SYSTEM,{run:current},null,run.id);});
      };
      for await (const output of (this.options.adapter??runAdapter)({ onNativeEvidence:nativeIntent?evidence=>this.nativeOperations.observe(nativeIntent!,evidence):undefined, executionId:fence.executionId,agent, run, prompt, workspace, home, stateRoot: this.root, hostMode, onRoomTool: hostMode ? (request:any) => this.executeTool(run.id, request, fence) : undefined, nativeSession: attached?undefined:this.store.session(scope), signal: controller.signal, host: this.host, saveCodexState, requestInput:(question,signal)=>this.requestInput(run,question,signal?AbortSignal.any([controller.signal,signal]):controller.signal) })) {
        assertRunIdentity(this.store,run);
        if(!attached||run.codex?.nativeStatus!=='completed')controller.signal.throwIfAborted();
        if (output.type === 'text') {
          text += output.text; if (text.length > 1000000) throw new Error('回复超过大小上限');
          const delta: StreamDelta = { type: 'message.delta',generation:run.generation,executionId:run.executionId, roomId: run.roomId, runId: run.id, messageId, index: deltaIndex++, text: output.text };
          for (const listener of this.streamListeners) listener(delta);
          if(!partialTimer)checkpoint();
        } else if (output.type === 'session') {
          if(!attached)this.store.saveSession(scope, output.id); run.nativeSessionId = output.id;
          const current=this.store.get<Run>('runs',run.id)!;current.nativeSessionId=output.id;this.store.atomic(()=>{this.store.event(run.roomId,'run.updated',SYSTEM,{run:current},null,run.id);});
        } else if(output.type==='remote-task'){
          run.remoteTaskId=output.id;const current=this.store.get<Run>('runs',run.id)!;current.remoteTaskId=output.id;this.store.atomic(()=>{this.store.event(run.roomId,'run.updated',SYSTEM,{run:current},null,run.id);});
        } else if (output.type === 'usage') {run.usage=output.usage;const current=this.store.get<Run>('runs',run.id)!;current.usage=output.usage;current.usageByGeneration={...current.usageByGeneration,[String(run.generation??1)]:output.usage};this.store.atomic(()=>{this.store.event(run.roomId,'run.updated',SYSTEM,{run:current},null,run.id);});const budget=budgetError(run.limits,current.usageByGeneration);if(budget)throw new BudgetExceeded(budget);}
        else if (output.type === 'input') { this.publishMessage(run, output.question, uid('msg')); }
        else if (output.type === 'artifact'){if(artifacts.length>=10||Buffer.byteLength(output.text)>2**20)throw new Error('候选交付物超过 10 份或单份 1 MiB 上限');artifacts.push(output);}
      }
      if(nativeIntent)this.nativeOperations.complete(nativeIntent);
      return {text,messageId,artifacts};
    }catch(error){
      if(nativeIntent&&error instanceof NativeExecutionFailed){try{this.nativeOperations.complete(nativeIntent,'failed');}catch(uncertain){this.nativeOperations.abandon(nativeIntent);throw uncertain;}}
      if(nativeIntent)this.nativeOperations.abandon(nativeIntent);
      try{if(text.trim())this.publishPartial(run,text,messageId,Math.max(0,deltaIndex-1));}catch{/* Preserve only authorized checkpoints. */}
      if(nativeIntent&&!controller.signal.aborted&&!(error instanceof ExecutionUnknown)&&!(error instanceof RemoteCanceled)&&!(error instanceof NativeExecutionFailed)&&!(error instanceof BudgetExceeded))throw new ExecutionUnknown('原生执行未取得完整可核对回执：'+redactDiagnostic(error,[agent.credentialEnv?process.env[agent.credentialEnv]:undefined]),{cause:error});
      throw error;
    }
    finally{clearTimeout(partialTimer);}
  }
  private async execute(initialRun: Run, controller: AbortController) {
    let run=initialRun;const fence=executionFence(run),ownedExecutions=new Set([fence.executionId]);
    const agent = this.store.get<AgentDescriptor>('agents', run.agentId)!;
    const timeout = setTimeout(() => controller.abort(new Error('运行达到时间上限')), run.limits!.timeoutMs);
    try {
      if (!agent?.enabled || !this.store.room(run.roomId)?.members.includes(agent.id)) throw new Error('Agent 已停用或不在当前房间');
      if(run.effectScope==='conversation-only'&&!['api','demo'].includes(agent.provider))throw new Error('Agent 执行能力已变化，请显式重试以重新确认执行范围');
      if(agent.connectionMode==='external')throw new Error('成员已改用外部会话，不启动旧的托管运行');
      const report = await diagnose(agent, this.host);
      if (!report.ready) throw new Error(report.checks.filter(c => !c.passed).map(c => c.detail).join('；'));
      controller.signal.throwIfAborted();assertRunFence(this.store,fence);
      const task = run.taskId ? this.store.get<Task>('tasks', run.taskId) : undefined;
      const attached = agent.connectionMode === 'attach';
      const hostMode = agent.executionMode === 'host';
      let workspace:string, baseline:Map<string,string>|undefined;
      if (attached) {
        workspace = agent.codexBinding!.expectedCwd;
        if(task?.projectPath && resolve(task.projectPath).toLowerCase()!==resolve(workspace).toLowerCase())throw new Error('任务项目目录与附着线程目录不一致');
        if(task){task.status='running';this.store.atomic(()=>{this.store.event(run.roomId,'task.updated',SYSTEM,{task});});}
      } else if (run.taskId) {
        if (hostMode && task?.projectPath) {
          workspace = resolve(task.projectPath);
          try { if (!statSync(workspace).isDirectory()) throw new Error('不是目录'); }
          catch (error) { throw new Error(`本机直连无法访问项目目录 ${workspace}：${(error as Error).message}`); }
          baseline = hostStatus(workspace);
          task.status = 'running'; this.store.atomic(() => {  this.store.event(run.roomId, 'task.updated', SYSTEM, { task }); });
        } else {
          workspace = join(this.root, 'sandboxes', run.id, 'workspace');
          if (task?.projectPath) {
            const manifest = this.workspaces.snapshot(task.projectPath, run.id); workspace = manifest.workspace;
            task.workspaceId = run.id; task.status = 'running'; this.store.atomic(() => {  this.store.event(run.roomId, 'task.updated', SYSTEM, { task }); });
          } else mkdirSync(workspace, { recursive: true });
        }
      } else workspace = hostMode ? prepareHostChatWorkspace(this.root, run) : prepareChatWorkspace(this.root, run);
      const home = join(this.root, 'homes', `${run.roomId}_${run.agentId}`); mkdirSync(home, { recursive: true });
      const scope = sessionKey(run,agent,workspace);
      let supplement='';
      while(true){
      const attachments=this.attachmentContext(run,home);
      const prompt=attached?`[已有 Codex 会话附着；房间 ${run.roomId}；本轮 ${run.id}]\n本轮最终正文会自动回传房间。本应用没有新增或更改 MCP；已有工具可能绑定其他房间，请勿用它们向错误房间发言。需审批或补充输入时由原客户端处理。\n\n${this.context(run,attachments)}`:this.context(run,attachments);
      const candidate=await this.consumeAttempt(run,controller,{agent,workspace,home,scope,prompt:prompt+(supplement?'\n\n'+supplement:''),hostMode,attached});
      const {text,messageId}=candidate;
      assertRunIdentity(this.store,run);
      if(!attached||run.codex?.nativeStatus!=='completed')controller.signal.throwIfAborted();
      const current = this.store.get<Run>('runs', run.id)!; if (current.status === 'cancel_requested'&&run.codex?.nativeStatus!=='completed') throw new Error('取消已请求');
      if(current.stopReason==='superseded'){this.finish(run,'superseded','已被新目标替代');return;}
      const delta=contextDelta(this.store,run);
      if(delta){
        supplement=reconciliationPrompt(delta,JSON.stringify({message:text,artifacts:candidate.artifacts}));
        const next=advanceContext(this.store,run,delta);this.executions.delete(run.executionId!);this.executions.set(next.executionId!,executionFence(next));ownedExecutions.add(next.executionId!);run=next;continue;
      }
      this.store.atomic(()=>{
      assertContextCurrent(this.store,run);
      if(run.contextPending)this.store.event(run.roomId,'run.context.confirmed',SYSTEM,{runId:run.id,generation:run.generation,executionId:run.executionId,throughSeq:run.contextSeq},null,run.id);
      for(const artifact of candidate.artifacts)this.publishArtifact(run,artifact.name,artifact.text,artifact.mediaType);
      if (text.trim()) this.publishFinalMessage(run, text, messageId);
      if (!attached && task?.projectPath) {
        if (hostMode) {
          this.publishArtifact(run, `${task.title.slice(0,60)} · 本机变更清单`, hostChangeReport(workspace, baseline));
        } else {
          const changes = this.workspaces.changes(run.id);
          if (changes.changes.length) {
            const artifact = this.publishArtifact(run, `${task.title.slice(0,60)} · 文件差异`, changes.patch, 'text/x-diff', 'patch');
            writeFileSync(join(this.root, 'artifacts', `${artifact.id}.changes.json`), JSON.stringify(changes));
          }
        }
      }
      // Host-mode chat runs share one room workspace; checkpoint each run so
      // another Agent's handoff can be reviewed and reverted with Git.
      if (hostMode && !attached && !run.taskId) {
        const checkpoint = commitSharedWorkspace(workspace, `room run ${run.id} (${agent.id})`);
        if (checkpoint.changed) this.store.event(run.roomId, 'room.git.checkpoint', { id: agent.id, kind: 'agent' }, { runId: run.id, agentId: agent.id, workspace, commit: checkpoint.commit ?? null }, null, run.id);
      }
      this.finish(run, 'completed');
      });break;
      }
    } catch (error) {
      try { assertRunIdentity(this.store,run,true); } catch { return; }
      if(run.taskId&&this.store.get<Task>('tasks',run.taskId)?.version!==run.taskVersion){this.finish(run,error instanceof ExecutionUnknown?'unknown':['api','a2a'].includes(agent.provider)&&controller.signal.aborted?'interrupted':'superseded','任务目标已变化，旧执行结果未提交');return;}
      if(error instanceof ProtocolError&&error.code==='lease_expired'){this.finish(run,'interrupted','执行租约已过期，未提交迟到输出');return;}
      const message = redactDiagnostic(error,[agent?.credentialEnv?process.env[agent.credentialEnv]:undefined,agent?.codexBinding?.credentialEnv?process.env[agent.codexBinding.credentialEnv]:undefined]);
      const contextFailure=error instanceof ProtocolError&&error.code.startsWith('context_');
      const status = error instanceof BudgetExceeded?'failed':contextFailure?'failed':error instanceof ExecutionUnknown?'unknown':run.codex?.nativeStatus==='completed'?'completed':run.codex?.nativeStatus==='failed'?'failed':error instanceof RemoteCanceled?'canceled':controller.signal.aborted ? ['api','a2a'].includes(agent.provider) ? 'interrupted' : 'canceled' : 'failed';
      this.finish(run, status, status==='completed'?undefined:status==='interrupted' && ['api','a2a'].includes(agent.provider) ? '已停止接收；远程计算是否停止未知。' : message);
    } finally { clearTimeout(timeout);for(const id of ownedExecutions)this.executions.delete(id); }
  }
  publishMessage(run: Run, text: string, id = uid('msg'),final=false,allowOutdated=false) {
    this.store.atomic(() => {
      const current=assertRunIdentity(this.store,run);
      if(!allowOutdated)assertContextCurrent(this.store,current);
      if(current.stopReason==='superseded')throw new ProtocolError('superseded','旧运行已被新目标替代',409);
      const currentTask = run.taskId ? this.store.get<Task>('tasks', run.taskId) : undefined;
      const message: Message = { id,...(final?{final:true,supersedes:current.partial?.id}:{}),roomId: run.roomId, actor: { id: run.agentId, kind: 'agent' }, text, mentions: [], attachments: [], createdAt: now(), runId: run.id, trust: trustForActor(this.store,{id:run.agentId,kind:'agent'}),...(run.taskId?{taskId:run.taskId,taskVersion:run.taskVersion}:{}), basedOnSeq: contextSeqOf(run),generation:run.generation,executionId:run.executionId, stale: Boolean(currentTask && currentTask.version !== run.taskVersion) };
       this.store.event(run.roomId, 'chat.message.created', message.actor, { message }, null, run.id);
    });
  }
  publishPartial(run:Run,text:string,messageId:string,streamIndex:number){
    if(!text.trim())return undefined;
    return this.store.atomic(()=>{
      const current=assertRunIdentity(this.store,run);
      if(!['running','waiting_input'].includes(current.status)||current.finalMessageId)throw new ProtocolError('run_not_active','运行不能再提交草稿',409);
      if(current.partial&&Date.now()-Date.parse(current.partial.createdAt)<PARTIAL_INTERVAL_MS)return undefined;
      const bytes=Buffer.from(text),partial={id:uid('partial'),messageId,text:new TextDecoder().decode(bytes.subarray(0,PARTIAL_MAX_BYTES),{stream:true}),streamIndex,truncated:bytes.length>PARTIAL_MAX_BYTES,createdAt:now(),supersedes:current.partial?.id};
      this.store.event(run.roomId,'run.partial',{id:run.agentId,kind:'agent'},{runId:run.id,baseSeq:contextSeqOf(run),generation:run.generation??1,executionId:run.executionId,partial},null,run.id);return partial;
    });
  }
  publishFinalMessage(run: Run, text: string, id = uid('msg')) {
    const current=assertRunIdentity(this.store,run);
    assertContextCurrent(this.store,current);
    if(current.stopReason==='superseded')throw new ProtocolError('superseded','旧运行已被新目标替代',409);
    const alreadyPosted = this.store.list<Message>('messages', run.roomId).find(message =>
      message.runId === run.id && message.actor.kind === 'agent' && message.actor.id === run.agentId && message.text.trim() === text.trim());
    if(!alreadyPosted)this.publishMessage(run,text,id,true);
    else if(current.finalMessageId!==alreadyPosted.id)this.store.event(run.roomId,'run.finalized',SYSTEM,{runId:run.id,messageId:alreadyPosted.id,generation:run.generation??1,executionId:run.executionId,supersedes:current.partial?.id},null,run.id);
  }
  publishArtifact(run: Run, name: string, text: string, mediaType = 'text/plain', kind: Artifact['kind'] = 'report'): Artifact {
    assertRunIdentity(this.store,run);assertContextCurrent(this.store,run);
    if (text.length > 2 ** 20) throw new Error('交付物超过 1 MiB 文本上限');
    const artifact: Artifact = { id: uid('artifact'), roomId: run.roomId, runId: run.id,generation:run.generation,executionId:run.executionId, taskId: run.taskId, name: name.slice(0,160), kind, mediaType, size: Buffer.byteLength(text), createdAt: now() };
    mkdirSync(join(this.root, 'artifacts'), { recursive: true }); writeFileSync(join(this.root, 'artifacts', artifact.id), text);
    this.store.atomic(() => {  this.store.event(run.roomId, 'artifact.created', { id: run.agentId, kind: 'agent' }, { artifact }, null, run.id); }); return artifact;
  }
  finish(run: Run, status: Run['status'], error?: string, reconciliation=false) {
    this.store.atomic(() => {
      assertRunIdentity(this.store,run,true);
      const current = this.store.get<Run>('runs', run.id); if (!current || (terminalStates.has(current.status)&&!(reconciliation&&['unknown','interrupted'].includes(current.status)))) return;
      if(status==='completed')assertContextCurrent(this.store,current);
      if(current.stopReason==='superseded'&&['completed','failed','canceled','superseded'].includes(status))status='superseded';
      Object.assign(run,current);delete run.leaseUntil;
      Object.assign(run, { sandbox:current.sandbox,status, error: error?.slice(0,2000), updatedAt: now() });  this.store.event(run.roomId, reconciliation?'run.reconciled':'run.updated', SYSTEM, { run }, null, run.id);
      if (run.taskId) {
        const task = this.store.get<Task>('tasks', run.taskId);
        if (task && task.version === run.taskVersion) { task.status = status;  this.store.event(run.roomId, 'task.updated', SYSTEM, { task }); }
      }
      this.service.settleDiscussion(run);
    });
    this.toolCalls.delete(run.id);
    const stored=this.store.get<Run>('runs',run.id);
    if(stored&&this.shouldAutoRetry(stored))queueMicrotask(()=>this.autoRetry(stored));
  }
  private consumeToolCall(run:Run){const max=this.store.settings().maxToolCallsPerRun,used=this.toolCalls.get(run.id)??0;if(used>=max)throw new ProtocolError('tool_budget_exceeded',`单次运行工具调用已达上限（${max}）`,429);this.toolCalls.set(run.id,used+1);}
  /** Absence of Room writes is insufficient: native and remote effects remain unobservable. */
  private recoverInterrupted(){
    if(!this.store.settings().recoverInterruptedChatRuns)return;
    for(const candidate of this.store.list<Run>('runs')){
      if(candidate.status!=='interrupted'||candidate.effectScope!=='conversation-only'||candidate.taskId||candidate.discussionId||(candidate.recoveryCount??0)>=1)continue;
      const agent=this.store.get<AgentDescriptor>('agents',candidate.agentId);
      if(!agent?.enabled||!['demo','api'].includes(agent.provider)||agent.executionMode!=='sandbox'||agent.connectionMode==='external')continue;
      if(this.store.list<ToolOperation>('operations',candidate.roomId).some(operation=>operation.runId===candidate.id))continue;
      if(this.store.list<Artifact>('artifacts',candidate.roomId).some(artifact=>artifact.runId===candidate.id))continue;
      const room=this.store.room(candidate.roomId);if(!room)continue;
      try{
        this.store.atomic(()=>{
          const run=this.store.get<Run>('runs',candidate.id);if(!run||run.status!=='interrupted')return;
          if((run.recoveryCount??0)>=1||this.store.list<Run>('runs',run.roomId).some(item=>item.autoRetryOf===run.id))return;
          const next=this.service.enqueue(candidate.roomId,candidate.agentId,candidate.prompt,room.seq,{autoRetryOf:candidate.id,recoveryCount:1});
          run.recoveryCount=1;run.updatedAt=now();
          this.store.event(run.roomId,'run.updated',SYSTEM,{run},null,run.id);
          this.store.event(run.roomId,'audit.recorded',SYSTEM,{action:'run.recovered:'+run.id+'->'+next.id},null,run.id);
        });
      }catch{/* Queue, rate, or history limits leave the run interrupted rather than guessing. */}
    }
  }
  /** Automatic retry is intentionally narrower than the owner retry command: sandbox-only chat runs without recorded side effects. */
  private shouldAutoRetry(run:Run){
    const settings=this.store.settings();
    if(!settings.autoRetryChatRuns||settings.maxAutoRetries<=0)return false;
    if(run.status!=='failed'||run.effectScope!=='conversation-only'||run.taskId||run.discussionId)return false;
    if((run.autoRetryCount??0)>=settings.maxAutoRetries)return false;
    const agent=this.store.get<AgentDescriptor>('agents',run.agentId);
    if(!agent?.enabled||!['demo','api'].includes(agent.provider)||agent.executionMode!=='sandbox'||agent.connectionMode==='external')return false;
    const failure=classifyFailure(run.error,'failed');
    if(!['timeout','network','provider'].includes(failure.kind))return false;
    if(this.store.list<ToolOperation>('operations',run.roomId).some(operation=>operation.runId===run.id))return false;
    if(this.store.list<Artifact>('artifacts',run.roomId).some(artifact=>artifact.runId===run.id))return false;
    return true;
  }
  private autoRetry(run:Run){
    try{
      this.store.atomic(()=>{
      const current=this.store.get<Run>('runs',run.id);if(!current||!this.shouldAutoRetry(current))return;
      if(this.store.list<Run>('runs',run.roomId).some(item=>item.autoRetryOf===run.id))return;
      if(this.store.list<Run>('runs',run.roomId).some(item=>item.id!==run.id&&item.agentId===run.agentId&&!terminalStates.has(item.status)))return;
      const next=this.service.enqueue(run.roomId,run.agentId,run.prompt,this.store.room(run.roomId)!.seq,{autoRetryOf:run.id,autoRetryCount:(run.autoRetryCount??0)+1});
      this.store.event(run.roomId,'audit.recorded',SYSTEM,{action:'auto.retry:'+run.id+'->'+next.id},null,run.id);
      });
    }catch{/* Queue, rate, or budget limits still apply to automatic retries. */}
  }
  /** Explicit recovery does not submit or restart a model request. */
  async reconcileCodex(runId:string,cancel=false) {
    const run=this.store.get<Run>('runs',runId);
    if(!run?.codex)throw new ProtocolError('not_found','此运行没有 Codex 附着记录',404);
    if(!run.contextPolicy){run.contextPolicy={...this.store.settings().contextPolicy,maxRounds:0};this.store.event(run.roomId,'run.updated',SYSTEM,{run},null,run.id);}
    if(['completed','failed','canceled','superseded'].includes(run.status)&&['completed','canceled'].includes(run.codex.phase))return {location:run.codex.phase==='canceled'?'canceled':'turn',phase:run.codex.phase,run};
    if(this.active.has(run.id)||[...this.active.keys()].some(id=>this.threadKey(this.store.get<Run>('runs',id)!)===run.codex!.binding.threadId))throw new ProtocolError('thread_busy','线程正在由 Room 调度，请使用运行的停止按钮',409);
    if(!['unknown','interrupted'].includes(run.status))throw new ProtocolError('invalid_state','只核对状态未知或已中断的附着运行',409);
    const controller=new AbortController();this.active.set(run.id,controller);
    try {
      const state=structuredClone(run.codex),found=await reconcileAttachedRun(state,state.executable,cancel);
      if(found.kind==='queued'){state.queuedSubmissionId=found.submission.id;state.phase='queued';}
      if(found.kind==='turn'){
        if(!['inProgress','completed','failed','interrupted'].includes(found.turn.status))throw new ExecutionUnknown('Codex 返回未知轮次状态');
        state.nativeTurnId=found.turn.id;state.nativeStatus=found.turn.status;state.phase=found.turn.status==='inProgress'?'running':found.turn.status==='interrupted'?'canceled':'completed';
      }
      if(found.kind==='canceled')state.phase='canceled';
      run.codex=state;run.updatedAt=now();
      this.store.atomic(()=>{this.store.event(run.roomId,'run.updated',SYSTEM,{run},null,run.id);});
      if(found.kind==='canceled')this.finish(run,'canceled','已确认移除本运行的原生排队项',true);
      else if(found.kind==='turn'&&found.turn.status!=='inProgress'){
        if(found.turn.itemsView&&found.turn.itemsView!=='full')throw new ExecutionUnknown('后端未提供完整轮次，不能确认交付');
        this.nativeOperations.reconcileCodex(run,found.turn);
        const text=(found.turn.items??[]).filter((item:any)=>item.type==='agentMessage'&&typeof item.text==='string').map((item:any)=>item.text).join('\n\n');
        if(text.trim()&&run.stopReason!=='superseded')this.publishFinalMessage(run,text,uid('msg'));
        this.finish(run,found.turn.status==='completed'?'completed':found.turn.status==='interrupted'?'canceled':'failed',undefined,true);
      }
      return {location:found.kind,phase:state.phase,run:this.store.get<Run>('runs',run.id)};
    } finally {this.active.delete(run.id);}
  }
  private apply(id: string) {
    const artifact = this.store.get<Artifact>('artifacts', id)!;
    if (artifact.kind !== 'patch') throw new ProtocolError('not_applicable','这份交付物不是可应用的文件差异',409);
    if (artifact.applied) throw new ProtocolError('already_applied','这份交付物已经应用',409);
    const run=artifact.runId?this.store.get<Run>('runs',artifact.runId):undefined,task=artifact.taskId?this.store.get<Task>('tasks',artifact.taskId):undefined;
    if(!run||!task||run.taskId!==task.id||run.roomId!==artifact.roomId||task.roomId!==artifact.roomId)throw new ProtocolError('artifact_binding_invalid','交付物缺少一致的任务与运行来源',409);
    if(artifact.generation!==undefined&&artifact.generation!==(run.generation??1))throw new ProtocolError('stale_generation','交付物属于旧执行 generation，不能应用',409);
    if(task.version!==run.taskVersion)throw new ProtocolError('stale_artifact','交付物基于旧任务版本，不能应用',409);
    if(run.status!=='completed')throw new ProtocolError('run_not_completed','交付物所属运行尚未成功完成，不能应用',409);
    for(const [id,version] of Object.entries(run.dependencyVersions??{})){const dependency=this.store.get<Task>('tasks',id);if(dependency?.version!==version||dependency.status!=='completed')throw new ProtocolError('stale_dependency','依赖任务版本或完成状态已变化，不能应用旧交付物',409);}
    const changes = JSON.parse(readFileSync(join(this.root, 'artifacts', `${id}.changes.json`), 'utf8'));
    const result = this.workspaces.apply(changes.manifest, changes.changes); artifact.applied = true;
     this.store.event(artifact.roomId, 'artifact.applied', { id: 'owner', kind: 'human' }, { artifact, ...result }); return result;
  }
  private async handleTool(frame: any) {
    const fence=this.executions.get(frame.runId);
    const result=fence?await this.executeTool(fence.runId,frame.request,fence):{error:'执行通道已经失效',code:'stale_generation'};
    await this.host.request('toolResponse', { runId: frame.runId, requestId: frame.requestId, result }).catch(() => {});
  }
  /** Room tool call from either the sandbox host pipe or a host-mode named pipe. */
  async executeTool(runId: string, request: any, fence?:RunFence): Promise<any> {
    const run = this.store.get<Run>('runs', runId);
    try {
      if (!run || !this.active.has(run.id) || this.active.get(run.id)!.signal.aborted || !['running','waiting_input'].includes(run.status)) throw new ProtocolError('run_not_active','运行没有活动授权',409);
      if(fence)assertRunFence(this.store,fence);
      else if(run.executionId)throw new ProtocolError('execution_identity_required','工具通道缺少不可变的执行授权',409);
      const args=request?.arguments??{},name=request?.name,actor={id:run.agentId,kind:'agent' as const};const toolAgent=this.store.get<AgentDescriptor>('agents',run.agentId);assertRoomToolAllowed(toolAgent?.roomToolPolicy,String(name),toolAgent?.allowedRoomTools);this.consumeToolCall(run);
      const commandId=fence?'tool_'+digest([run.id,fence.generation,request?.operationId]).slice(0,64):uid('tool');
      const scope={runId:run.id,...(fence?{generation:fence.generation,executionId:fence.executionId}:{})};
      let action:()=>unknown;
      if(name==='room_read'){
        action=()=>{const snapshot=runContext(this.store,run);return {roomId:run.roomId,contextStatus:{providedThroughSeq:contextSeqOf(run),headSeq:this.store.room(run.roomId)!.seq,requiresReconciliation:Boolean(contextDelta(this.store,run))},fromSeq:snapshot.fromSeq,throughSeq:snapshot.throughSeq,members:snapshot.members,messages:snapshot.messages.map(message=>({...message,text:message.text.slice(0,6000),truncated:message.text.length>6000})),decisions:snapshot.decisions};};
      }else if(name==='room_inbox'){
        const input=z.object({afterSeq:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(200).default(100)}).strict().parse(args);
        action=()=>{const events=this.store.events(run.roomId,input.afterSeq,input.limit);const nextSeq=events.at(-1)?.seq??input.afterSeq;return {roomId:run.roomId,fromSeq:input.afterSeq,nextSeq,hasMore:events.length===input.limit,events:events.map(event=>({seq:event.seq,type:event.type,createdAt:event.createdAt,payload:event.payload}))};};
      }else if(name==='room_post'){
        const input=z.object({text:z.string().min(1).max(32000),mentions:z.array(z.string()).default([])}).strict().parse(args);
        assertRoomPostLength(toolAgent,input.text);
        action=()=>this.service.execute({version:VERSION,commandId,roomId:run.roomId,type:'message.send',payload:input},actor,scope);
      }else if(name==='task_propose'){
        const input=z.object({title:z.string().min(1).max(5000),agentId:z.string(),dependencies:z.array(z.string()).max(20).default([])}).strict().parse(args);
        assertTaskTitleLength(toolAgent,input.title);
        action=()=>this.service.execute({version:VERSION,commandId,roomId:run.roomId,type:'task.create',payload:input},actor,scope);
      }else if(name==='task_claim'){
        const input=z.object({taskId:z.string()}).strict().parse(args);
        action=()=>this.service.execute({version:VERSION,commandId,roomId:run.roomId,type:'task.claim',payload:{...input,managed:true}},actor,scope);
      }else if(name==='artifact_publish'){
        const input=z.object({name:z.string().min(1).max(160),text:z.string().max(2**20)}).strict().parse(args);
        action=()=>this.publishArtifact(run,input.name,input.text);
      }else throw new ProtocolError('unsupported_tool','不支持的群聊工具');
      const commit=()=>{const result=action();this.store.event(run.roomId,'run.tool.completed',actor,{runId:run.id,generation:run.generation??1,executionId:run.executionId,name,success:true},null,run.id);return result;};
      if(fence&&name!=='room_read'){
        if(typeof request?.operationId!=='string')throw new ProtocolError('operation_id_required','写工具需要稳定 operationId',400);
        return this.operations.execute(fence,request.operationId,name,args,commit);
      }
      return this.store.atomic(commit);
    }catch(error){
      const agent=run?this.store.get<AgentDescriptor>('agents',run.agentId):undefined;
      if(run&&this.active.has(run.id)&&!this.active.get(run.id)!.signal.aborted){
        try{if(fence)assertRunFence(this.store,fence);else if(run.executionId)throw new Error('Missing fence');
          this.store.event(run.roomId,'run.tool.completed',{id:run.agentId,kind:'agent'},{runId:run.id,generation:run.generation??1,executionId:run.executionId,name:String(request?.name??'').slice(0,100),success:false},null,run.id);
        }catch{ /* A rejected old callback cannot append an audit fact as the new run. */ }
      }
      return {error:redactDiagnostic(error,[agent?.credentialEnv?process.env[agent.credentialEnv]:undefined]),code:error instanceof ProtocolError?error.code:'tool_failed'};
    }
  }
  /**
   * External (MCP/plugin) Agent tool call: an Agent process running in its own
   * environment joins a room through a scoped token instead of a managed run.
   * Tools are limited to room read/post, task proposal and report publication.
   */
  async agentTool(agentId: string, roomId: string, name: string, args: any, commandId=uid('tool')): Promise<any> {
    const agent = this.store.get<AgentDescriptor>('agents', agentId), room = this.store.room(roomId);
    if (!agent || !agent.enabled) throw new Error('Agent 未启用');
    if (!room || !room.members.includes(agentId)) throw new Error('Agent 不在该房间');
    assertRoomToolAllowed(agent.roomToolPolicy,String(name),agent.allowedRoomTools);
    if(['room_read','room_status'].includes(name))z.object({}).strict().parse(args??{});
    const actor = { id: agentId, kind: 'agent' as const };
    this.store.event(roomId, 'agent.tool.called', actor, { agentId, name: String(name).slice(0, 100) }, null, null);
    if (name === 'room_read') {
      const context = captureContext(this.store, roomId, room.seq);
      return { roomId, fromSeq: context.fromSeq, throughSeq: context.throughSeq, members: context.members, messages: context.messages.map(message => ({ ...message, text: message.text.slice(0, 6000), truncated: message.text.length > 6000 })), decisions: context.decisions };
    }
    if (name === 'room_inbox') {
      const input = z.object({ afterSeq: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(200).default(100) }).strict().parse(args);
      const events = this.store.events(roomId, input.afterSeq, input.limit), nextSeq = events.at(-1)?.seq ?? input.afterSeq;
      return { roomId, fromSeq: input.afterSeq, nextSeq, hasMore: events.length === input.limit, events: events.map(event => ({ seq: event.seq, type: event.type, createdAt: event.createdAt, payload: event.payload })) };
    }
    if (name === 'room_post') {
      const input = z.object({ text: z.string().min(1).max(32000), mentions: z.array(z.string()).default([]) }).strict().parse(args);
      assertRoomPostLength(agent,input.text);
      return this.service.execute({ version: VERSION, commandId, roomId, type: 'message.send', payload: input }, actor);
    }
    if (name === 'task_propose') {
      const input = z.object({ title: z.string().min(1).max(5000), agentId: z.string(), dependencies: z.array(z.string()).max(20).default([]) }).strict().parse(args);
      assertTaskTitleLength(agent,input.title);
      return this.service.execute({ version: VERSION, commandId, roomId, type: 'task.create', payload: input }, actor);
    }
    if (name === 'task_claim') {
      const input = z.object({ taskId: z.string() }).strict().parse(args);
      return this.service.execute({ version: VERSION, commandId, roomId, type: 'task.claim', payload: { ...input, managed: false } }, actor);
    }
    if (name === 'task_complete') {
      const input = z.object({ taskId: z.string(), taskVersion: z.number().int().positive(), generation:z.number().int().positive().optional(), contextToken:z.string().optional(), ok: z.boolean().default(true), summary: z.string().max(8000).default('') }).strict().parse(args);
      return this.service.execute({ version: VERSION, commandId, roomId, type: 'task.complete', payload: input }, actor);
    }
    if (name === 'task_context') {
      const input = z.object({taskId:z.string(),taskVersion:z.number().int().positive(),generation:z.number().int().positive().optional()}).strict().parse(args);
      return this.service.execute({version:VERSION,commandId,roomId,type:'task.context',payload:input},actor);
    }
    if (name === 'task_heartbeat') {
      const input = z.object({ taskId: z.string(), taskVersion: z.number().int().positive(), generation:z.number().int().positive().optional() }).strict().parse(args);
      return this.service.execute({ version: VERSION, commandId, roomId, type: 'task.heartbeat', payload: input }, actor);
    }
    if (name === 'artifact_publish') {
      const input = z.object({ name: z.string().min(1).max(160), text: z.string().max(2 ** 20) }).strict().parse(args);
      const hash=digest({kind:'agent-tool',actor,roomId,name,input});
      return this.store.atomic(() => {
        const previous=this.store.receipt(commandId);
        if(previous){if(previous.hash!==hash)throw new ProtocolError('idempotency_conflict','同一 commandId 不能用于不同内容',409);return previous.receipt;}
        const artifact: Artifact = { id: uid('artifact'), roomId, name: input.name, kind: 'report', mediaType: 'text/plain', size: Buffer.byteLength(input.text), createdAt: now() };
        mkdirSync(join(this.root, 'artifacts'), { recursive: true }); writeFileSync(join(this.root, 'artifacts', artifact.id), input.text);
        this.store.event(roomId, 'artifact.created', actor, { artifact }, commandId);
        const result={artifact:{id:artifact.id,name:artifact.name,size:artifact.size}};this.store.saveReceipt(commandId,hash,result);return result;
      });
    }
    if (name === 'room_status') {
      const tasks = this.store.list<Task>('tasks', roomId).map(task => ({ id: task.id, title: task.title, agentId: task.agentId, status: task.status, version: task.version,generation:task.generation??1, open: Boolean(task.open), dependencies: task.dependencies }));
      return { room: { id: room.id, name: room.name, seq: room.seq, members: room.members }, tasks };
    }
    if (name === 'room_wait') {
      const input = z.object({ afterSeq: z.number().int().nonnegative().optional(), timeoutMs: z.number().int().min(500).max(25000).default(15000) }).strict().parse(args ?? {});
      const startSeq = input.afterSeq ?? room.seq, deadline = Date.now() + input.timeoutMs;
      if(startSeq>room.seq)throw new ProtocolError('invalid_cursor','游标超出当前房间事件序号',400);
      let cursor=startSeq;
      while (Date.now() < deadline) {
        if(!this.store.get<AgentDescriptor>('agents',agentId)?.enabled||!this.store.room(roomId)?.members.includes(agentId))throw new ProtocolError('forbidden','Agent 房间访问已撤销',403);
        const events=this.store.events(roomId,cursor,1000),messages:unknown[]=[];
        for(const event of events){cursor=event.seq;if(event.type==='chat.message.created')messages.push(event.payload.message);if(messages.length===20)break;}
        if(messages.length)return {roomId,fromSeq:startSeq,throughSeq:cursor,timeout:false,messages};
        await new Promise(resolve => setTimeout(resolve, events.length===1000?0:Math.max(0,Math.min(200,deadline-Date.now()))));
      }
      return { roomId, fromSeq: startSeq, throughSeq: cursor, timeout: true, messages: [] };
    }
    throw new Error('不支持的房间工具');
  }
  async close() {
    this.toolCalls.clear();
    this.closed = true; if (this.timer) clearInterval(this.timer);
    for (const controller of this.active.values()) controller.abort(new Error('服务关闭'));
    this.host.close();
    const end = Date.now() + 12000; while (this.active.size && Date.now() < end) await new Promise(r => setTimeout(r, 50));
  }
}
