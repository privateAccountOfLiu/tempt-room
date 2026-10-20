import { z } from 'zod';
import {discussionPrompt,assessConvergence,discussionSummaryPrompt} from './discussions.ts';
import { agentSchema,contextSeqOf,taskContractSchema, capabilitiesFor, commandSchema,payloadSchemas,executionSettingsSchema, ProtocolError, VERSION, terminalStates, roomBudgetError, type Actor, type AgentDescriptor, type Artifact, type Command, type Discussion, type Message, type Receipt, type Run, type Task, type Decision, type AgentSession, type Subscription, type WakeIntent, type ProjectBinding, type Integration, type BudgetReservation, type CapabilityEvidence } from '../../../packages/protocol/src/index.ts';
import { digest, now, OWNER, Store, SYSTEM, uid } from './store.ts';
import {assertContextCurrent} from './context-reconciliation.ts';
import { assertRunFence } from './execution.ts';
import { captureContext } from './context.ts';
import { adaptiveTimeoutMs } from './adaptive.ts';
import { trustForActor } from './trust.ts';
import {provideTaskContext,assertExternalContextCurrent} from './external-context.ts';
import {agentCapabilityFingerprint,capabilityEvidenceId,verifiedCapabilityState} from './adapter-capabilities.ts';
import {InputDeliveryService} from './input-delivery.ts';
import {releaseResource} from './resource-manager.ts';
import {canonicalProjectPath,buildProjectManifest,projectBaseCommit} from './project-manifest.ts';
import {taskVerificationRecordSchema} from '../../../packages/protocol/src/index.ts';

/** External (non-managed) claims must heartbeat within this window or the worker recycles the task. */
const externalTaskLeaseMs = (store: Store) => store.settings().taskLeaseMs;

export class RoomService {
  onCancel: (runId: string) => void = () => {};
  onApply: (artifactId: string) => Record<string, unknown> = () => { throw new ProtocolError('not_available', '成果应用服务不可用', 503); };
  onRollback: (integrationId: string, actor: Actor) => Record<string, unknown> = () => { throw new ProtocolError('not_available', '集成回滚服务不可用', 503); };
  onInput: (runId: string, text: string) => void = () => {};
  readonly inputDelivery: InputDeliveryService;
  private activeTraceId?:string;
  constructor(public store: Store) { this.inputDelivery = new InputDeliveryService(store); }
  execute(raw: unknown, actor: Actor = OWNER,scope?:{runId:string;generation?:number;executionId?:string}): Receipt {
    const parsed = commandSchema.safeParse(raw); if (!parsed.success) throw new ProtocolError('invalid_command', parsed.error.message);
    const command = parsed.data, hash = digest({ command, actor,...(scope?{scope}:{}) });
    const previousTrace=this.activeTraceId;this.activeTraceId=uid('trace');
    try{ return this.store.atomic(() => {
      if(scope){const run=this.store.get<Run>('runs',scope.runId);if(run&&(run.executionId||scope.generation!==undefined||scope.executionId!==undefined))assertRunFence(this.store,{runId:run.id,roomId:command.roomId!,agentId:actor.id,generation:scope.generation!,executionId:scope.executionId!});}
      const previous = this.store.receipt(command.commandId);
      if (previous) { if (previous.hash !== hash) throw new ProtocolError('idempotency_conflict', '同一 commandId 不能用于不同内容', 409); return previous.receipt; }
      if (command.roomId && !this.store.room(command.roomId)) throw new ProtocolError('not_found', '房间不存在', 404);
      if (actor.kind === 'agent') {
        if (!command.roomId || !this.store.room(command.roomId)?.members.includes(actor.id)) throw new ProtocolError('forbidden', '不是该房间的成员', 403);
        if (!['message.send', 'decision.propose', 'task.create', 'task.claim', 'task.context', 'task.complete', 'task.heartbeat', 'input.ack'].includes(command.type)) throw new ProtocolError('forbidden', 'Agent 无权执行此命令', 403);
      }
      if(scope){const run=this.store.get<Run>('runs',scope.runId);if(actor.kind!=='agent'||!run||run.roomId!==command.roomId||run.agentId!==actor.id||!['running','waiting_input'].includes(run.status))throw new ProtocolError('forbidden','工具消息不属于当前活动运行',403);}
      if(scope&&['message.send','task.create','task.claim'].includes(command.type))assertContextCurrent(this.store,this.store.get<Run>('runs',scope.runId)!);
      const result = this.dispatch(command, actor,scope);
      const receipt: Receipt = { commandId: command.commandId, accepted: true, result };
      this.store.saveReceipt(command.commandId, hash, receipt); return receipt;
    });}finally{this.activeTraceId=previousTrace;}
  }
  private requireRoom(command: Command) { if (!command.roomId) throw new ProtocolError('room_required', '需要房间编号'); return command.roomId; }
  private dispatch(command: Command, actor: Actor,scope?:{runId:string;generation?:number;executionId?:string}): Record<string, unknown> {
    const p = command.payload as Record<string,unknown>;
    switch (command.type) {
      case 'settings.update':{
        const settings=executionSettingsSchema.parse({...p,contextPolicy:p.contextPolicy??this.store.settings().contextPolicy});this.store.saveSettings(settings);
        for(const room of this.store.rooms())this.store.event(room.id,'settings.updated',actor,{settings},command.commandId);
        return {settings};
      }
      case 'room.create': {
        const input = z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(300).default(''), members: z.array(z.string()).default([]) }).parse(p);
        for (const id of input.members) if (!this.store.get('agents', id)) throw new ProtocolError('invalid_member', '成员不存在');
        const room = { id: uid('room'), ...input, createdAt: now(), seq: 0 }; this.store.putRoom(room,actor); return { roomId: room.id };
      }
      case 'room.update': {
        const roomId = this.requireRoom(command), room = this.store.room(roomId)!;
        const input = z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(300).default('') }).parse(p);
        Object.assign(room, input); this.store.event(roomId, 'room.updated', actor, { room }); return { roomId };
      }
      case 'room.members.set': {
        const roomId = this.requireRoom(command), members = z.array(z.string()).max(30).parse(p.members);
        for (const id of members) if (!this.store.get('agents', id)) throw new ProtocolError('invalid_member', '成员不存在');
        const room = this.store.room(roomId)!; room.members = [...new Set(members)]; this.store.event(roomId, 'room.members.updated', actor, { members: room.members }); return {};
      }
      case 'agent.save': {
        const agent = agentSchema.parse(p); if (agent.provider === 'demo' && !agent.id.startsWith('demo-')) throw new ProtocolError('invalid_agent', '保留的演示类型');
        const previous=this.store.get<AgentDescriptor>('agents',agent.id);
        if(previous && (previous.connectionMode==='attach'||agent.connectionMode==='attach')) {
          const binding=(value:AgentDescriptor)=>JSON.stringify([value.provider,value.connectionMode,value.executionMode,value.codexBinding,value.executable,value.version]);
          const unresolved=this.store.list<Run>('runs').some(run=>run.agentId===agent.id&&(!terminalStates.has(run.status)||(run.codex&&!['completed','canceled'].includes(run.codex.phase))));
          if(unresolved&&binding(previous)!==binding(agent))throw new ProtocolError('thread_binding_busy','已有运行使用此线程绑定，请先停止并核对状态，再修改连接配置',409);
        }
        agent.capabilities=capabilitiesFor(agent.provider,agent);this.store.put('agents', agent);
        for(const room of this.store.rooms())if(room.members.includes(agent.id))this.store.event(room.id,'agent.configured',actor,{agentId:agent.id},command.commandId);
        return { agentId: agent.id };
      }
      case 'message.send': {
        const roomId = this.requireRoom(command);
        const input = z.object({ text: z.string().trim().min(1).max(32000), mentions: z.array(z.string()).max(20).default([]), replyTo: z.string().optional(), attachments: z.array(z.string()).max(10).default([]) }).parse(p);
        if (input.replyTo && this.store.get<Message>('messages', input.replyTo)?.roomId !== roomId) throw new ProtocolError('invalid_reply', '引用消息不属于此房间');
        for (const id of input.attachments) if (this.store.get<Artifact>('artifacts', id)?.roomId !== roomId) throw new ProtocolError('invalid_attachment', '附件不属于此房间');
        const room = this.store.room(roomId)!;
        for (const id of input.mentions) if (!room.members.includes(id)) throw new ProtocolError('invalid_mention', '提及的成员不在房间内');
        const message: Message = { id: uid('msg'), roomId, actor, ...input, createdAt: now(), trust: trustForActor(this.store,actor) };
        if(scope){const run=this.store.get<Run>('runs',scope.runId)!;message.runId=run.id;if(run.taskId){message.taskId=run.taskId;message.taskVersion=run.taskVersion;}message.basedOnSeq=contextSeqOf(run);message.generation=run.generation;message.executionId=run.executionId;message.stale=Boolean(run.taskId&&this.store.get<Task>('tasks',run.taskId)?.version!==run.taskVersion);}
         const event = this.store.event(roomId, 'chat.message.created', actor, { message }, command.commandId,scope?.runId??null);
        const wakeSettings=this.store.settings();
        const agentWake=actor.kind==='agent'&&wakeSettings.allowAgentMentionsToWake&&Boolean(scope)&&!this.store.get<Run>('runs',scope!.runId)?.discussionId;
        if ((actor.kind === 'human'||agentWake)&&input.mentions.length){
          let chainDepth=0;
          if(agentWake&&scope){const parent=this.store.get<Run>('runs',scope.runId);chainDepth=(parent?.wakeChainDepth??0)+1;if(chainDepth>wakeSettings.maxWakeChainDepth){this.store.event(roomId,'audit.recorded',SYSTEM,{action:'wake.chain.limit:'+scope.runId},command.commandId);chainDepth=-1;}}
          if(chainDepth>=0){const contextId=this.saveContext(roomId,event.seq);for (const agentId of new Set(input.mentions)){const agent=this.checkAgent(roomId,agentId);if(agent.connectionMode==='external')this.store.event(roomId,'agent.wake.requested',actor,{agentId,messageId:message.id,connectionMode:'external'},command.commandId);else {for(const old of this.store.list<Run>('runs',roomId))if(old.agentId===agentId&&!old.taskId&&!old.discussionId&&!terminalStates.has(old.status))this.cancel(old,'superseded');this.enqueue(roomId, agentId, input.text, event.seq, { causationId: event.eventId,contextId,wakeChainDepth:chainDepth });}}}
        }
        return { messageId: message.id };
      }
      case 'project.bind': {
        const roomId = this.requireRoom(command);
        if (actor.kind !== 'human') throw new ProtocolError('forbidden', '只有 owner 可以绑定项目', 403);
        const input = payloadSchemas['project.bind'].parse(p);
        const sourcePath = canonicalProjectPath(input.sourcePath);
        const manifest = buildProjectManifest(sourcePath);
        const version = this.store.list<ProjectBinding>('project_bindings', roomId).reduce((max, binding) => Math.max(max, binding.version), 0) + 1;
        const binding: ProjectBinding = {id: uid('binding'), roomId, sourcePath, ...(input.baseCommit ?? projectBaseCommit(sourcePath) ? {baseCommit: input.baseCommit ?? projectBaseCommit(sourcePath)!} : {}), manifestHash: manifest.manifestHash, manifestFileCount: manifest.fileCount, manifestBytes: manifest.bytes, allowedExecutionModes: input.allowedExecutionModes, verificationRefs: input.verificationRefs, version, createdAt: now(), updatedAt: now()};
        this.store.event(roomId, 'project.bound', actor, {projectBinding: binding});
        return {bindingId: binding.id, version, manifestHash: binding.manifestHash, fileCount: manifest.fileCount, bytes: manifest.bytes};
      }
      case 'capability.verify': {
        const roomId = this.requireRoom(command);
        const input = payloadSchemas['capability.verify'].parse(p);
        const recorded = input.evidence.map(item => {
          if (item.fingerprint !== input.fingerprint) throw new ProtocolError('fingerprint_mismatch', '能力证据指纹与命令不一致', 400);
          return {...item, id: capabilityEvidenceId(item.fingerprint, item.capability)};
        });
        for (const capabilityEvidence of recorded) this.store.event(roomId, 'capability.verified', actor, {capabilityEvidence});
        return {fingerprint: input.fingerprint, recorded: recorded.length};
      }
      case 'discussion.start': {
        const roomId = this.requireRoom(command);
        const input = payloadSchemas['discussion.start'].parse(p);
        input.participants = [...new Set(input.participants)]; input.participants.forEach(id => {if(this.checkAgent(roomId,id).connectionMode==='external')throw new ProtocolError('external_discussion_unavailable','外部会话需自行在线回应；当前自动轮次仅支持托管成员',409);});
        if (this.store.list<Discussion>('discussions', roomId).some(d => d.status === 'active'||d.status === 'paused'||d.summary?.status==='queued')) throw new ProtocolError('discussion_active', '请先停止当前讨论', 409);
        if (input.quorum !== undefined && input.quorum > input.participants.length) throw new ProtocolError('quorum_invalid', 'quorum 不能超过参与成员数', 400);
        if(input.summarizerId&&this.checkAgent(roomId,input.summarizerId).connectionMode==='external')throw new ProtocolError('external_summary_unavailable','总结人必须是可调度的托管成员',409);
        const quorum = input.quorum ?? input.participants.length;
        if (input.maxResponses < quorum) throw new ProtocolError('quorum_unreachable', '最多响应次数小于 quorum，讨论无法推进', 400);
        const {maxDurationMs,activationLimit,...fields}=input;delete (fields as {quorum?:number}).quorum;
        const discussion: Discussion = { id: uid('disc'), roomId, ...fields, participants: input.participants, quorum, round: 1, responses: 0, activationsUsed: 0, summaryActivationsUsed: 0, ...(activationLimit !== undefined ? {activationLimit} : {}), deadline: new Date(Date.now() + maxDurationMs).toISOString(), status: 'active' };
        for (const agentId of discussion.participants) {
          const agentSession = this.createAgentSession(roomId, agentId, discussion.id);
          this.store.event(roomId, 'agent_session.created', actor, {agentSession});
        }
        const event = this.store.event(roomId, 'discussion.started', actor, { discussion });
        discussion.startedSeq=event.seq;this.scheduleRound(discussion, event.seq); return { discussionId: discussion.id };
      }
      case 'discussion.stop': {
        const roomId = this.requireRoom(command), id = z.string().parse(p.discussionId), discussion = this.store.get<Discussion>('discussions', id);
        if (!discussion || discussion.roomId !== roomId) throw new ProtocolError('not_found', '讨论不存在', 404);
        this.stopDiscussion(discussion, '用户停止'); return {};
      }
      case 'discussion.pause': {
        const roomId = this.requireRoom(command), id = z.string().parse(p.discussionId), discussion = this.store.get<Discussion>('discussions', id);
        if (!discussion || discussion.roomId !== roomId) throw new ProtocolError('not_found', '讨论不存在', 404);
        if (discussion.status !== 'active') throw new ProtocolError('invalid_state', '只有进行中的讨论可以暂停', 409);
        discussion.status = 'paused';
        this.store.event(roomId, 'discussion.paused', actor, {discussion});
        this.transitionDiscussionSessions(discussion, 'paused', actor);
        return {discussionId: discussion.id, status: discussion.status};
      }
      case 'discussion.resume': {
        const roomId = this.requireRoom(command), id = z.string().parse(p.discussionId), discussion = this.store.get<Discussion>('discussions', id);
        if (!discussion || discussion.roomId !== roomId) throw new ProtocolError('not_found', '讨论不存在', 404);
        if (discussion.status !== 'paused') throw new ProtocolError('invalid_state', '只有已暂停的讨论可以恢复', 409);
        discussion.status = 'active';
        this.store.event(roomId, 'discussion.resumed', actor, {discussion});
        this.transitionDiscussionSessions(discussion, 'active', actor);
        return {discussionId: discussion.id, status: discussion.status};
      }
      case 'subscription.set': {
        const roomId = this.requireRoom(command);
        const input = payloadSchemas['subscription.set'].parse(p);
        const subscription = input.subscription;
        if (subscription.roomId !== roomId) throw new ProtocolError('invalid_subscription', '订阅必须属于当前房间', 400);
        const session = this.store.get<AgentSession>('agent_sessions', subscription.agentSessionId);
        if (!session || session.roomId !== roomId) throw new ProtocolError('not_found', 'AgentSession 不存在', 404);
        if (!this.store.room(roomId)?.members.includes(session.agentId)) throw new ProtocolError('forbidden', 'Agent 不是当前房间成员', 403);
        if (subscription.scanSeq > this.store.room(roomId)!.seq) throw new ProtocolError('invalid_cursor', '订阅水位超过当前房间 head', 400);
        const previous = this.store.get<Subscription>('subscriptions', subscription.id);
        if (previous && (previous.roomId !== roomId || previous.agentSessionId !== subscription.agentSessionId)) throw new ProtocolError('subscription_conflict', '订阅 ID 已绑定其他会话', 409);
        this.store.event(roomId, 'subscription.updated', actor, {subscription});
        return {subscriptionId: subscription.id, scanSeq: subscription.scanSeq};
      }
      case 'resource.release': {
        const roomId = this.requireRoom(command);
        if (actor.kind !== 'human') throw new ProtocolError('forbidden', '只有 owner 可以解除资源隔离', 403);
        const input = payloadSchemas['resource.release'].parse(p);
        const lease = releaseResource(this.store, roomId, input.leaseId, {checkedAt: now(), remainingProcesses: input.remainingProcesses, evidence: input.evidence});
        return {leaseId: lease.id, status: lease.status};
      }
      case 'budget.reconcile': {
        const roomId = this.requireRoom(command);
        if (actor.kind !== 'human') throw new ProtocolError('forbidden', '只有 owner 可以核对预算预留', 403);
        const input = payloadSchemas['budget.reconcile'].parse(p);
        const reservation = this.store.get<BudgetReservation>('budget_reservations', input.reservationId);
        if (!reservation || reservation.roomId !== roomId) throw new ProtocolError('not_found', '预算预留不存在', 404);
        if (!['reserved', 'unknown'].includes(reservation.status)) throw new ProtocolError('invalid_state', '预留已是终态', 409);
        const next: BudgetReservation = input.decision === 'settle' ? {...reservation, status: 'settled', ...(input.actualUsd !== undefined ? {actualUsd: input.actualUsd} : {}), source: 'manual', updatedAt: now()} : {...reservation, status: 'released', source: 'manual', updatedAt: now()};
        this.store.event(roomId, 'budget.updated', actor, {reservation: next});
        return {reservationId: next.id, status: next.status};
      }
      case 'input.reconcile': {
        const roomId = this.requireRoom(command);
        if (actor.kind !== 'human') throw new ProtocolError('forbidden', '只有 owner 可以核对输入批次', 403);
        const input = payloadSchemas['input.reconcile'].parse(p);
        const batch = this.inputDelivery.reconcileBatch(roomId, input.batchId, input.decision);
        return {batchId: batch.id, status: batch.status};
      }
      case 'input.ack': {
        const roomId = this.requireRoom(command);
        const input = payloadSchemas['input.ack'].parse(p);
        if (actor.kind === 'agent') {
          const session = this.store.get<AgentSession>('agent_sessions', input.agentSessionId);
          if (!session || session.roomId !== roomId || session.agentId !== actor.id) throw new ProtocolError('forbidden', '只能确认自己的输入批次', 403);
        }
        const batch = this.inputDelivery.acknowledgeBatch(roomId, input.batchId, input.agentSessionId, input.receiptEvidence ?? `${actor.kind}-ack`);
        return {batchId: batch.id, status: batch.status};
      }
      case 'task.create': {
        const roomId = this.requireRoom(command);
        const input = z.object({ title: z.string().trim().min(1).max(5000), agentId: z.string().optional(), projectPath: z.string().max(1500).default(''), dependencies: z.array(z.string()).max(20).default([]), open: z.boolean().default(false), contract:taskContractSchema.optional(), projectBindingId:z.string().optional(), bindingVersion:z.number().int().positive().optional(), requiresIntegration:z.boolean().default(false) }).parse(p);
        const strictFields=input.contract?{strict:true,objective:input.contract.objective,acceptanceChecks:input.contract.acceptance.map(check=>({...check,required:true})),allowedPaths:input.contract.projectBinding.allowedPaths,requiresAcceptance:true,requiresIntegration:input.requiresIntegration,acceptanceStatus:'pending' as const,baselineRef:input.contract.projectBinding.baselineRef,dependencyRequirements:input.contract.dependencies.map(dependency=>({taskId:dependency.taskId,taskVersion:dependency.taskVersion,requirement:dependency.condition,...(dependency.artifactHash?{artifactHash:dependency.artifactHash}:{})}))}:{};
        let binding:ProjectBinding|undefined;
        if(input.projectBindingId){binding=this.store.get<ProjectBinding>('project_bindings',input.projectBindingId);if(!binding||binding.roomId!==roomId)throw new ProtocolError('binding_not_found','项目绑定不存在',404);if(input.bindingVersion!==undefined&&input.bindingVersion!==binding.version)throw new ProtocolError('binding_version_mismatch','项目绑定版本不匹配',409);if(input.contract&&(input.contract.projectBinding.id!==binding.id||input.contract.projectBinding.version!==binding.version))throw new ProtocolError('binding_contract_mismatch','任务契约与项目绑定不一致',409);}
        if(input.contract){for(const dependency of input.contract.dependencies){const target=this.store.get<Task>('tasks',dependency.taskId);if(!target||target.roomId!==roomId)throw new ProtocolError('invalid_dependency','契约依赖任务不存在',400);if(dependency.taskVersion>target.version)throw new ProtocolError('invalid_dependency','契约依赖版本晚于当前任务版本',409);}}
        for (const id of input.dependencies) if (this.store.get<Task>('tasks', id)?.roomId !== roomId) throw new ProtocolError('invalid_dependency', '依赖任务不存在');
        if (input.open) {
          if (actor.kind !== 'human') throw new ProtocolError('forbidden', 'Agent 不能创建开放认领任务', 403);
          if (input.agentId) throw new ProtocolError('validation_error', '开放认领任务不需要指定成员', 400);
          const task: Task = { ...(this.activeTraceId?{traceId:this.activeTraceId}:{}), id: uid('task'), roomId, title: input.title, agentId: 'unassigned', projectPath: binding?.sourcePath??input.projectPath, dependencies: input.dependencies, ...(input.contract?{contract:input.contract}:{}), ...strictFields, ...(binding?{projectBindingId:binding.id,bindingVersion:binding.version,baselineManifestHash:binding.manifestHash}:{}), open: true, generation:1,version: 1, status: 'proposed', createdAt: now() };
           this.store.event(roomId, 'task.created', actor, { task },command.commandId,scope?.runId??null); return { taskId: task.id };
        }
        if (!input.agentId) throw new ProtocolError('validation_error', '请指定执行成员或选择开放认领', 400);
        this.checkAgent(roomId, input.agentId);
        const task: Task = { ...(this.activeTraceId?{traceId:this.activeTraceId}:{}), id: uid('task'), roomId, title: input.title, agentId: input.agentId, projectPath: binding?.sourcePath??input.projectPath, dependencies: input.dependencies, ...(input.contract?{contract:input.contract}:{}), ...strictFields, ...(binding?{projectBindingId:binding.id,bindingVersion:binding.version,baselineManifestHash:binding.manifestHash}:{}), generation:1,version: 1, status: actor.kind === 'agent' ? 'proposed' : 'queued', createdAt: now() };
         const event = this.store.event(roomId, 'task.created', actor, { task },command.commandId,scope?.runId??null);
        if (actor.kind === 'human'&&this.store.get<AgentDescriptor>('agents',task.agentId)?.connectionMode!=='external') this.enqueue(roomId, task.agentId, task.title, event.seq, { taskId: task.id, taskVersion: 1 });
        return { taskId: task.id };
      }
      case 'task.claim': {
        const roomId = this.requireRoom(command), input = payloadSchemas['task.claim'].parse(p), task = this.store.get<Task>('tasks', input.taskId);
        if (!task || task.roomId !== roomId) throw new ProtocolError('not_found', '任务不存在', 404);
        if (actor.kind !== 'agent') throw new ProtocolError('forbidden', '只有 Agent 可以认领任务', 403);
        const agent=this.checkAgent(roomId,actor.id);
        const assignedExternal=!input.managed&&agent.connectionMode==='external'&&task.agentId===actor.id&&task.status==='queued'&&!task.leaseUntil;
        if (!(task.open&&task.agentId==='unassigned'&&task.status==='proposed')&&!assignedExternal) throw new ProtocolError('task_not_claimable', '任务不可认领', 409);
        if(input.managed&&agent.connectionMode==='external')throw new ProtocolError('external_agent','外部会话不能启动托管运行',409);
        if (task.dependencies.some(id => this.store.get<Task>('tasks', id)?.status !== 'completed')) throw new ProtocolError('dependencies_not_ready', '依赖任务尚未全部完成，暂不可认领', 409);
        task.agentId = actor.id; task.open = false; task.version += 1;task.generation=(task.generation??1)+1;
        // Managed Agents let Tempt Room start a run. External Agents execute the
        // work in their own process and report back with task.complete.
        task.status = input.managed ? 'queued' : 'running';
        let provided:ReturnType<typeof provideTaskContext>|undefined;
        delete task.externalContext;
        if (!input.managed){task.leaseUntil = new Date(Date.now() + externalTaskLeaseMs(this.store)).toISOString();provided=provideTaskContext(this.store,task);task.externalContext=provided.receipt;}
         const event = this.store.event(roomId, 'task.claimed', actor, { task, managed: input.managed }, command.commandId);
        if (input.managed) this.enqueue(roomId, task.agentId, task.title, event.seq, { taskId: task.id, taskVersion: task.version });
        return { taskId: task.id, agentId: task.agentId, version: task.version,generation:task.generation, managed: input.managed, leaseUntil: task.leaseUntil,...(provided?{contextToken:provided.receipt.token,baseSeq:provided.receipt.baseSeq,throughSeq:provided.receipt.throughSeq,hasMore:false,context:provided.context}:{}) };
      }
      case 'task.context': {
        const roomId=this.requireRoom(command),input=payloadSchemas['task.context'].parse(p),task=this.store.get<Task>('tasks',input.taskId);
        if(!task||task.roomId!==roomId)throw new ProtocolError('not_found','任务不存在',404);
        if(actor.kind!=='agent'||task.agentId!==actor.id)throw new ProtocolError('forbidden','只能读取自己认领任务的上下文',403);
        this.requireExternalLease(task,input.taskVersion,input.generation);
        const provided=provideTaskContext(this.store,task);task.externalContext=provided.receipt;
        this.store.event(roomId,'task.context.advanced',actor,{task,...(provided.delta?{delta:provided.delta}:{})},command.commandId);
        return {taskId:task.id,version:task.version,generation:task.generation,contextToken:provided.receipt.token,baseSeq:provided.receipt.baseSeq,throughSeq:provided.receipt.throughSeq,headSeq:provided.delta?.headSeq??provided.receipt.throughSeq,hasMore:provided.receipt.hasMore,...(provided.delta?{delta:provided.delta}:{context:provided.context})};
      }
      case 'task.complete': {
        const roomId = this.requireRoom(command), input = payloadSchemas['task.complete'].parse(p), task = this.store.get<Task>('tasks', input.taskId);
        if (!task || task.roomId !== roomId) throw new ProtocolError('not_found', '任务不存在', 404);
        if (actor.kind !== 'agent') throw new ProtocolError('forbidden', '只有 Agent 可以完成任务', 403);
        if (task.agentId !== actor.id) throw new ProtocolError('forbidden', '只能完成分配给自己的任务', 403);
        if (!['running', 'queued', 'waiting_input'].includes(task.status)) throw new ProtocolError('task_not_active', '任务已经结束', 409);
        this.requireExternalLease(task, input.taskVersion,input.generation);
        assertExternalContextCurrent(this.store,task,input.contextToken);
        task.status = input.ok ? 'completed' : 'failed'; delete task.leaseUntil; if(task.strict||task.requiresAcceptance)task.acceptanceStatus=input.ok?'pending':'rejected';
         this.store.event(roomId, 'task.completed', actor, { task, ok: input.ok, summary: input.summary,contextToken:input.contextToken }, command.commandId);
        if (input.summary.trim()) {
          const message: Message = { id: uid('msg'), roomId, actor, text: input.summary.trim(), mentions: [], attachments: [], createdAt: now(),taskId:task.id,taskVersion:task.version,basedOnSeq:task.externalContext!.throughSeq,generation:task.generation,trust:trustForActor(this.store,actor) };
           this.store.event(roomId, 'chat.message.created', actor, { message }, command.commandId);
        }
        return { taskId: task.id, status: task.status,generation:task.generation };
      }
      case 'task.heartbeat': {
        const roomId = this.requireRoom(command), input = payloadSchemas['task.heartbeat'].parse(p), task = this.store.get<Task>('tasks', input.taskId);
        if (!task || task.roomId !== roomId) throw new ProtocolError('not_found', '任务不存在', 404);
        if (actor.kind !== 'agent') throw new ProtocolError('forbidden', '只有 Agent 可以续租任务', 403);
        if (task.agentId !== actor.id) throw new ProtocolError('forbidden', '只能续租分配给自己的任务', 403);
        this.requireExternalLease(task, input.taskVersion,input.generation);
        task.leaseUntil = new Date(Date.now() + externalTaskLeaseMs(this.store)).toISOString();
        this.store.event(roomId,'task.lease.renewed',actor,{task},command.commandId);
        
        return { taskId: task.id, leaseUntil: task.leaseUntil,generation:task.generation };
      }
      case 'task.release': {
        const roomId = this.requireRoom(command), input = payloadSchemas['task.release'].parse(p), task = this.store.get<Task>('tasks', input.taskId);
        if (!task || task.roomId !== roomId) throw new ProtocolError('not_found', '任务不存在', 404);
        if (actor.kind !== 'human') throw new ProtocolError('forbidden', '只有人类可以回收外部任务', 403);
        if (task.status !== 'running' || !task.leaseUntil) throw new ProtocolError('task_not_active', '只有带外部租约的进行中任务可以回收', 409);
        const previousAgentId = task.agentId;
        task.status = 'proposed'; task.agentId = 'unassigned'; task.open = true; task.version += 1;task.generation=(task.generation??1)+1; delete task.leaseUntil;delete task.externalContext;
        
        this.store.event(roomId, 'task.released', actor, { task, previousAgentId, reason: 'owner' }, command.commandId);
        return { taskId: task.id, previousAgentId, version: task.version };
      }
      case 'task.revise': {
        const roomId = this.requireRoom(command), input = z.object({ taskId: z.string(), title: z.string().trim().min(1).max(5000), contract:taskContractSchema.optional() }).parse(p);
        const task = this.store.get<Task>('tasks', input.taskId); if (!task || task.roomId !== roomId) throw new ProtocolError('not_found', '任务不存在', 404);
        if(task.agentId!=='unassigned')this.checkAgent(roomId,task.agentId);
        if(input.contract){for(const dependency of input.contract.dependencies){const target=this.store.get<Task>('tasks',dependency.taskId);if(!target||target.roomId!==roomId)throw new ProtocolError('invalid_dependency','契约依赖任务不存在',400);if(dependency.taskVersion>target.version)throw new ProtocolError('invalid_dependency','契约依赖版本晚于当前任务版本',409);}}
        const affectedTaskIds=this.reviseTaskTree(task,actor,command.commandId,current=>{current.title=input.title;if(input.contract)current.contract=input.contract;if(current.strict){current.acceptanceStatus='pending';delete current.verificationId;current.acceptedArtifactIds=[];delete current.lastVerification;}});
        return {affectedTaskIds};
      }
      case 'task.verification.record': {
        const roomId = this.requireRoom(command);
        if (actor.kind !== 'human') throw new ProtocolError('forbidden', '只有 owner 可以记录验收结果', 403);
        const input = payloadSchemas['task.verification.record'].parse(p);
        const task = this.store.get<Task>('tasks', input.taskId);
        if (!task || task.roomId !== roomId) throw new ProtocolError('not_found', '任务不存在', 404);
        if (task.version !== input.taskVersion) throw new ProtocolError('task_version_mismatch', '验收目标版本已过期', 409);
        if (!task.strict && !task.requiresAcceptance) throw new ProtocolError('legacy_task', '旧任务没有独立验收要求', 409);
        for (const artifactId of input.artifactIds) {
          const artifact = this.store.get<Artifact>('artifacts', artifactId);
          if (!artifact || artifact.roomId !== roomId || (artifact.taskId && artifact.taskId !== task.id)) throw new ProtocolError('invalid_artifact', '验收产物不存在或不属于此任务', 400);
        }
        const verification = taskVerificationRecordSchema.parse({...input, recordedAt: input.recordedAt ?? now()});
        const accepted = input.outcome === 'accepted';
        const verificationHistory = [...(task.verificationHistory ?? []), verification].slice(-20);
        const next: Task = {...task, acceptanceStatus: accepted ? 'accepted' : 'rejected', verificationId: input.verificationId, acceptedArtifactIds: accepted ? input.artifactIds : [], lastVerification: verification, verificationHistory};
        this.store.event(roomId, 'task.verification.recorded', actor, {task: next, verification});
        return {taskId: task.id, acceptanceStatus: next.acceptanceStatus, verificationId: verification.verificationId};
      }
      case 'task.accept':{
        const roomId=this.requireRoom(command),input=payloadSchemas['task.accept'].parse(p),task=this.store.get<Task>('tasks',input.taskId);
        if(!task||task.roomId!==roomId)throw new ProtocolError('not_found','任务不存在',404);
        if(task.status!=='proposed')throw new ProtocolError('task_not_proposed','此任务不在等待确认',409);
        this.checkAgent(roomId,task.agentId);if(input.projectPath!==undefined)task.projectPath=input.projectPath;
        task.status='queued';const event=this.store.event(roomId,'task.accepted',actor,{task},command.commandId);
        if(this.store.get<AgentDescriptor>('agents',task.agentId)?.connectionMode!=='external')this.enqueue(roomId,task.agentId,task.title,event.seq,{taskId:task.id,taskVersion:task.version});return {taskId:task.id};
      }
      case 'task.handoff': {
        const roomId = this.requireRoom(command), input = payloadSchemas['task.handoff'].parse(p), task = this.store.get<Task>('tasks', input.taskId);
        if (!task || task.roomId !== roomId) throw new ProtocolError('not_found', '任务不存在', 404);
        this.checkAgent(roomId, input.agentId);
        if (task.agentId === input.agentId) throw new ProtocolError('same_agent', '任务已经在目标成员名下', 409);
        const fromAgentId = task.agentId;
        const affectedTaskIds=this.reviseTaskTree(task,actor,command.commandId,current=>{current.agentId=input.agentId;current.open=false;if(current.strict){current.acceptanceStatus='pending';delete current.verificationId;current.acceptedArtifactIds=[];delete current.lastVerification;}},{type:'task.handoff',payload:{fromAgentId,toAgentId:input.agentId,note:input.note},note:input.note});
        return { taskId: task.id, fromAgentId, toAgentId: task.agentId, version: task.version,affectedTaskIds };
      }
      case 'run.cancel': {
        const roomId = this.requireRoom(command), run = this.store.get<Run>('runs', z.string().parse(p.runId));
        if (!run || run.roomId !== roomId) throw new ProtocolError('not_found', '运行不存在', 404); this.cancel(run); return { runId: run.id, status: run.status };
      }
      case 'run.retry': {
        const roomId = this.requireRoom(command), input = payloadSchemas['run.retry'].parse(p), previous = this.store.get<Run>('runs', input.runId);
        if (!previous || previous.roomId !== roomId) throw new ProtocolError('not_found', '运行不存在', 404);
        if (previous.discussionId && previous.discussionRole !== 'summary') throw new ProtocolError('discussion_retry_unavailable', '讨论响应不能使用普通 run.retry；请恢复或重新开始讨论', 409);
        if (!['failed', 'canceled', 'interrupted', 'unknown'].includes(previous.status)) throw new ProtocolError('run_not_retryable', '只有失败、取消、中断或状态待核实的运行可以重试', 409);
        const agent = this.checkAgent(roomId, previous.agentId);
        if (agent.connectionMode === 'external') throw new ProtocolError('external_agent', '外部会话的运行不能由服务端重试，请在原会话中处理', 409);
        if (this.store.list<Run>('runs', roomId).some(run => run.id !== previous.id && run.agentId === previous.agentId && !terminalStates.has(run.status))) throw new ProtocolError('run_active', '该成员仍有进行中的运行，请先等待或停止', 409);
        if(previous.discussionId){
          const discussion=this.store.get<Discussion>('discussions',previous.discussionId);
          if(previous.discussionRole!=='summary')throw new ProtocolError('discussion_retry_unavailable','讨论响应由轮次调度；如需重新讨论，请新建一场讨论',409);
          if(discussion?.summaryActivationLimit!==undefined&&(discussion.summaryActivationsUsed??0)>=discussion.summaryActivationLimit)throw new ProtocolError('summary_activation_limit','总结激活额度已用尽',429);
          if(!discussion||discussion.summary?.runId!==previous.id||discussion.summary.status==='completed')throw new ProtocolError('summary_not_retryable','此总结已完成或已由新运行替代',409);
          const next=this.enqueue(roomId,previous.agentId,previous.prompt,this.store.room(roomId)!.seq,{discussionId:discussion.id,discussionRole:'summary'});
          discussion.summary={runId:next.id,status:'queued'};this.store.event(roomId,'discussion.summary.updated',actor,{discussion},command.commandId);
          return {runId:next.id,previousRunId:previous.id};
        }
        if (previous.taskId) {
          const task = this.store.get<Task>('tasks', previous.taskId);
          if (!task || task.roomId !== roomId) throw new ProtocolError('not_found', '任务不存在', 404);
          if (task.version !== previous.taskVersion) throw new ProtocolError('stale_task_version', '任务已改版，请从任务卡重新发起', 409);
          if (!['failed', 'queued', 'canceled', 'interrupted', 'unknown'].includes(task.status)) throw new ProtocolError('task_not_retryable', '只有失败、取消、中断或排队中的任务可以重试', 409);
          if (task.status !== 'queued') { task.status = 'queued'; this.store.event(roomId, 'task.updated', actor, { task }, command.commandId); }
          const next = this.enqueue(roomId, previous.agentId, previous.prompt, this.store.room(roomId)!.seq, { taskId: task.id, taskVersion: task.version });
          return { runId: next.id, previousRunId: previous.id };
        }
        const next = this.enqueue(roomId, previous.agentId, previous.prompt, this.store.room(roomId)!.seq);
        return { runId: next.id, previousRunId: previous.id };
      }
      case 'run.input': {
        const roomId = this.requireRoom(command), input = z.object({ runId: z.string(), text: z.string().trim().min(1).max(16000) }).parse(p);
        const run = this.store.get<Run>('runs', input.runId); if (!run || run.roomId !== roomId || run.status !== 'waiting_input') throw new ProtocolError('not_waiting', '运行未等待输入', 409);
        // Only the trusted human command can supply requested input.
        this.onInput(run.id, input.text);
        const message:Message={id:uid('msg'),roomId,actor,text:input.text,mentions:[],attachments:[],runId:run.id,createdAt:now(),trust:trustForActor(this.store,actor)};this.store.event(roomId,'chat.message.created',actor,{message},command.commandId,run.id);
        return { runId: run.id };
      }
      case 'decision.propose': {
        const roomId = this.requireRoom(command), text = z.string().trim().min(1).max(5000).parse(p.text);
        const decision: Decision & { roomId: string } = { id: uid('decision'), roomId, text, actor, accepted: false };
         this.store.event(roomId, 'decision.proposed', actor, { decision }); return { decisionId: decision.id };
      }
      case 'decision.accept': {
        const roomId = this.requireRoom(command), decision = this.store.get<Decision & { roomId: string }>('decisions', z.string().parse(p.decisionId));
        if (!decision || decision.roomId !== roomId) throw new ProtocolError('not_found', '决策不存在', 404);
        decision.accepted = true;  this.store.event(roomId, 'decision.accepted', actor, { decision }); return {};
      }
      case 'artifact.integrate': {
        const roomId = this.requireRoom(command);
        const input = z.object({artifactId:z.string(),requireAuthorization:z.boolean().default(false)}).parse(p);
        const artifact = this.store.get<Artifact>('artifacts', input.artifactId);
        if (!artifact || artifact.roomId !== roomId) throw new ProtocolError('not_found', '交付物不存在', 404);
        if (artifact.kind !== 'patch') throw new ProtocolError('not_applicable', '这份交付物不是可应用的文件差异', 409);
        const existing = this.store.list<Integration>('integrations', roomId).find(item => item.artifactId === artifact.id && ['queued', 'validating', 'applying', 'applied'].includes(item.status));
        if (existing) return {integrationId: existing.id, status: existing.status};
        const unsafe = this.store.list<Integration>('integrations', roomId).find(item => item.artifactId === artifact.id && ['unknown', 'blocked'].includes(item.status));
        if (unsafe) throw new ProtocolError('integration_unknown', '该交付物存在未知/阻塞的集成记录，请先审查后再入队', 409);
        if (artifact.applied) throw new ProtocolError('already_applied', '这份交付物已经应用', 409);
        const requireAuthorization = input.requireAuthorization;
        const integration: Integration = {id: uid('integration'), roomId, artifactId: artifact.id, ...(artifact.traceId?{traceId:artifact.traceId}:{}), ...(artifact.runId ? {runId: artifact.runId} : {}), ...(artifact.taskId ? {taskId: artifact.taskId} : {}), status: 'queued', authorization: requireAuthorization ? 'waiting' : 'auto', requestActor: actor.id, createdAt: now(), updatedAt: now()};
        this.store.event(roomId, 'integration.queued', actor, {integration});
        return {integrationId: integration.id, status: integration.status};
      }
      case 'integration.authorize': {
        const roomId = this.requireRoom(command);
        if (actor.kind !== 'human') throw new ProtocolError('forbidden', '只有 owner 可以授权集成', 403);
        const input = payloadSchemas['integration.authorize'].parse(p);
        const integration = this.store.get<Integration>('integrations', input.integrationId);
        if (!integration || integration.roomId !== roomId) throw new ProtocolError('not_found', '集成不存在', 404);
        if (integration.status !== 'ready_to_apply') throw new ProtocolError('invalid_state', '集成尚未进入待授权状态', 409);
        const next: Integration = {...integration, authorization: 'authorized', updatedAt: now()};
        this.store.event(roomId, 'integration.updated', actor, {integration: next});
        return {integrationId: next.id, status: next.status, authorization: next.authorization};
      }
      case 'integration.reconcile': {
        const roomId = this.requireRoom(command);
        if (actor.kind !== 'human') throw new ProtocolError('forbidden', '只有 owner 可以核对未知集成', 403);
        const input = payloadSchemas['integration.reconcile'].parse(p);
        const integration = this.store.get<Integration>('integrations', input.integrationId);
        if (!integration || integration.roomId !== roomId) throw new ProtocolError('not_found', '集成不存在', 404);
        if (!['unknown', 'blocked'].includes(integration.status)) throw new ProtocolError('invalid_state', '只有未知/阻塞集成需要人工核对', 409);
        if (input.decision === 'mark_applied') {
          if (integration.errorCode !== 'journal_applied') throw new ProtocolError('journal_evidence_required', 'journal 未证明已应用，不能标记 applied', 409);
          const artifact = this.store.get<Artifact>('artifacts', integration.artifactId);
          if (!artifact || artifact.roomId !== roomId) throw new ProtocolError('not_found', '交付物不存在', 404);
          const next: Integration = {...integration, status: 'applied', errorCode: undefined, journalId: integration.journalId ?? 'owner-review', updatedAt: now()};
          this.store.event(roomId, 'integration.updated', actor, {integration: next});
          if (!artifact.applied) { artifact.applied = true; this.store.event(roomId, 'artifact.applied', actor, {artifact, reconciledBy: 'owner-journal-review'}); }
          return {integrationId: next.id, status: next.status};
        }
        if (input.decision === 'retry') {
          const next: Integration = {...integration, status: 'queued', authorization: 'waiting', errorCode: undefined, updatedAt: now()};
          this.store.event(roomId, 'integration.updated', actor, {integration: next});
          return {integrationId: next.id, status: next.status, authorization: next.authorization};
        }
        const next: Integration = {...integration, status: 'blocked', errorCode: 'owner_abandoned', updatedAt: now()};
        this.store.event(roomId, 'integration.updated', actor, {integration: next});
        return {integrationId: next.id, status: next.status};
      }
      case 'integration.rollback': {
        const roomId = this.requireRoom(command);
        if (actor.kind !== 'human') throw new ProtocolError('forbidden', '只有 owner 可以回滚集成', 403);
        const input = payloadSchemas['integration.rollback'].parse(p);
        const integration = this.store.get<Integration>('integrations', input.integrationId);
        if (!integration || integration.roomId !== roomId) throw new ProtocolError('not_found', '集成不存在', 404);
        if (integration.status !== 'applied') throw new ProtocolError('invalid_state', '只有已应用集成可以回滚', 409);
        return this.onRollback(integration.id, actor);
      }
      case 'artifact.apply': {
        const roomId = this.requireRoom(command), id = z.string().parse(p.artifactId), artifact = this.store.get<Artifact>('artifacts', id);
        if (!artifact || artifact.roomId !== roomId) throw new ProtocolError('not_found', '交付物不存在', 404);
        return this.onApply(id);
      }
    }
  }
  /** Any upstream version change invalidates the complete accepted dependency tree. */
  private reviseTaskTree(task:Task,actor:Actor,commandId:string,updateRoot:(task:Task)=>void,rootEvent={type:'task.revised',payload:{} as Record<string,unknown>,note:undefined as string|undefined}){
    const roomId=task.roomId,affected=new Map([[task.id,task]]),all=this.store.list<Task>('tasks',roomId);
    let changed=true;while(changed){changed=false;for(const candidate of all)if(!affected.has(candidate.id)&&(candidate.dependencies.some(id=>affected.has(id))||candidate.dependencyRequirements?.some(requirement=>affected.has(requirement.taskId)))){affected.set(candidate.id,candidate);changed=true;}}
    const queued:{task:Task;prompt:string;causationId:string}[]=[];
    for(const current of affected.values()){
      const isRoot=current.id===task.id,proposed=current.status==='proposed'&&(!isRoot||rootEvent.type!=='task.handoff');
      for(const run of this.store.list<Run>('runs',roomId).filter(run=>run.taskId===current.id&&!terminalStates.has(run.status)))this.cancel(run,'superseded');
      if(isRoot)updateRoot(current);if(current.strict||current.requiresAcceptance){current.acceptanceStatus='pending';delete current.verificationId;current.acceptedArtifactIds=[];delete current.lastVerification;}current.version++;current.generation=(current.generation??1)+1;delete current.workspaceId;delete current.leaseUntil;delete current.externalContext;
      const member=this.store.get<AgentDescriptor>('agents',current.agentId),available=member?.enabled&&this.store.room(roomId)!.members.includes(current.agentId),open=Boolean(current.open&&current.agentId==='unassigned');
      current.status=proposed||open?'proposed':available?'queued':'interrupted';
      const event=this.store.event(roomId,isRoot?rootEvent.type:'task.revised',actor,{task:current,...(isRoot?rootEvent.payload:{dependencyTaskId:task.id,reason:'依赖任务版本已变化'})},commandId);
      const prompt=isRoot&&rootEvent.note?`${current.title}\n\n[交接说明] ${rootEvent.note}`:current.title;
      if(current.status==='queued'&&member?.connectionMode!=='external')queued.push({task:current,prompt,causationId:event.eventId});
    }
    // Freeze only after the entire tree is invalidated. Otherwise the parent's
    // new run would capture downstream v1 replies before they are marked stale.
    if(queued.length){const basedOnSeq=this.store.room(roomId)!.seq,contextId=this.saveContext(roomId,basedOnSeq);for(const entry of queued)this.enqueue(roomId,entry.task.agentId,entry.prompt,basedOnSeq,{taskId:entry.task.id,taskVersion:entry.task.version,causationId:entry.causationId,contextId});}
    return [...affected.keys()];
  }
  private requireExternalLease(task: Task, taskVersion: number,generation?:number) {
    if(generation!==undefined&&generation!==(task.generation??1))throw new ProtocolError('stale_generation','任务租约 generation 已变化，拒绝旧执行',409);
    if (task.version !== taskVersion) throw new ProtocolError('stale_task_version', '任务版本已变化，不能提交旧执行结果或续租', 409);
    if (task.status !== 'running' || !task.leaseUntil) throw new ProtocolError('external_lease_required', '仅能结束或续租外部认领且仍在运行的任务', 409);
    if (!Number.isFinite(Date.parse(task.leaseUntil)) || Date.parse(task.leaseUntil) <= Date.now()) throw new ProtocolError('lease_expired', '任务租约已过期，不能提交结果或重新续租', 409);
  }
  private checkAgent(roomId: string, id: string) {
    const agent = this.store.get<AgentDescriptor>('agents', id);
    if (!agent || !this.store.room(roomId)?.members.includes(id)) throw new ProtocolError('invalid_agent', 'Agent 不在此房间');
    if (!agent.enabled) throw new ProtocolError('agent_disabled', `${agent.name} 尚未启用，请先配置并诊断`, 409);
    return agent;
  }
  private assertCostPolicy(roomId:string,agent:AgentDescriptor,limits:Partial<Run['limits']>|undefined){if(!(limits?.costBudgetUsd&&limits.costBudgetUsd>0))return;if(['demo','api'].includes(agent.provider))return;const settings=this.store.settings();if(settings.unknownCostPolicy!=='block')return;const fingerprint=agentCapabilityFingerprint(agent);const evidence=this.store.list<CapabilityEvidence>('capability_evidence',roomId).filter(item=>item.fingerprint===fingerprint);if(verifiedCapabilityState(fingerprint,evidence,'usageScope')!=='verified_supported')throw new ProtocolError('cost_unknown','该成员没有已验证的用量/费用回执能力；请先验证能力或允许未知成本策略',409);}
  private reserveBudgetForRun(run:Run){
    const settings=this.store.settings();if(!settings.roomCostBudgetUsd)return;
    const reservedUsd=run.limits?.costBudgetUsd??0;if(!reservedUsd)return;
    const reservations=this.store.list<BudgetReservation>('budget_reservations',run.roomId).filter(item=>item.status==='reserved'||item.status==='unknown');
    const reserved=reservations.reduce((sum,item)=>sum+item.reservedUsd,0);
    const spent=this.store.list<Run>('runs',run.roomId).reduce((sum,item)=>sum+Object.values(item.usageByGeneration??{}).reduce((inner,usage)=>inner+(usage?.costUsd??0),0),0);
    if(spent+reserved+reservedUsd>settings.roomCostBudgetUsd)throw new ProtocolError('room_budget_exhausted',`房间费用预算不足：已用/预留 US$ ${(spent+reserved).toFixed(4)} + 本次 US$ ${reservedUsd.toFixed(4)} > 上限 US$ ${settings.roomCostBudgetUsd.toFixed(4)}`,429);
    const reservation:BudgetReservation={id:uid('budget'),roomId:run.roomId,runId:run.id,generation:run.generation??1,reservedUsd,source:'estimate',status:'reserved',createdAt:now(),updatedAt:now()};
    this.store.event(run.roomId,'budget.reserved',SYSTEM,{reservation});
  }
  settleBudgetForRun(run:Run){
    const reservation=this.store.list<BudgetReservation>('budget_reservations',run.roomId).find(item=>item.runId===run.id&&item.status==='reserved');if(!reservation)return;
    const costs=Object.values(run.usageByGeneration??{}).flatMap(usage=>usage?.costUsd!==undefined?[usage.costUsd]:[]);
    const known=costs.length>0,actualUsd=known?costs.reduce((sum,value)=>sum+value,0):undefined;
    const next:BudgetReservation={...reservation,...(actualUsd!==undefined?{actualUsd}:{}),status:known?'settled':'unknown',source:known?'adapter':'estimate',updatedAt:now()};
    this.store.event(run.roomId,'budget.updated',SYSTEM,{reservation:next});
  }
  enqueue(roomId: string, agentId: string, prompt: string, basedOnSeq: number, extra: Partial<Run> & { causationId?: string } = {}): Run {
    const executionAgent=this.checkAgent(roomId,agentId);
    // Cost-budgeted runs from providers without verified usage are blocked by default.
    {const provisionalLimits={costBudgetUsd:extra.limits?.costBudgetUsd??this.store.settings().costBudgetUsd};this.assertCostPolicy(roomId,executionAgent,provisionalLimits);}
    if(executionAgent.connectionMode==='external')throw new ProtocolError('external_agent','外部会话不创建托管运行',409);
    const { causationId, ...fields } = extra;
    const settings=this.store.settings();
    const backlog=this.store.list<Run>('runs',roomId).filter(run=>!terminalStates.has(run.status));
    if(backlog.length>=settings.maxQueuedRunsPerRoom)throw new ProtocolError('room_queue_full',`房间待处理运行已达上限（${settings.maxQueuedRunsPerRoom}）`,429);
    if(backlog.filter(run=>run.agentId===agentId).length>=settings.maxQueuedRunsPerAgent)throw new ProtocolError('agent_queue_full',`该成员的待处理运行已达上限（${settings.maxQueuedRunsPerAgent}）`,429);
    const roomBudget=roomBudgetError(settings,this.store.list<Run>('runs',roomId));if(roomBudget)throw new ProtocolError('room_budget_exhausted',roomBudget,429);
    const recentRuns=this.store.list<Run>('runs',roomId).filter(run=>run.agentId===agentId&&Date.now()-Date.parse(run.createdAt)<60000);if(recentRuns.length>=settings.maxAgentRunsPerMinute)throw new ProtocolError('agent_rate_limited',`该成员一分钟内启动的运行已达上限（${settings.maxAgentRunsPerMinute}）`,429);
    const baseTimeoutMs=fields.taskId?settings.taskTimeoutMs:settings.chatTimeoutMs;
    const timeoutMs=settings.adaptiveTimeouts?adaptiveTimeoutMs(this.store.list<Run>('runs',roomId),agentId,fields.taskId?'task':'chat',baseTimeoutMs):baseTimeoutMs;
    const run: Run = { ...(this.activeTraceId?{traceId:this.activeTraceId}:{}), id: uid('run'), roomId, agentId, prompt, effectScope:['demo','api'].includes(executionAgent.provider)?'conversation-only':'unrestricted', basedOnSeq, status: 'queued',lifecycleVersion:1,generation:1,contextPolicy:structuredClone(settings.contextPolicy), createdAt: now(), updatedAt: now(),contextId:fields.contextId??this.saveContext(roomId,basedOnSeq),limits:{memoryMb:settings.memoryMb,maxProcesses:settings.maxProcesses,timeoutMs,tokenBudget:settings.tokenBudget,costBudgetUsd:settings.costBudgetUsd}, ...fields };
     this.reserveBudgetForRun(run);
     this.store.event(roomId, 'run.created', SYSTEM, { run }, causationId ?? null, run.id); return run;
  }
  private saveContext(roomId:string,throughSeq:number){const id=uid('context');this.store.put('contexts',{id,roomId,...captureContext(this.store,roomId,throughSeq)});return id;}
  private createAgentSession(roomId:string,agentId:string,discussionId:string):AgentSession{
    return {id:uid('as'),roomId,agentId,discussionId,status:'active',createdAt:now(),updatedAt:now()};
  }
  private transitionDiscussionSessions(discussion:Discussion,status:'active'|'paused'|'ended',actor:Actor){
    const type=status==='active'?'agent_session.resumed':status==='paused'?'agent_session.paused':'agent_session.ended';
    for(const candidate of this.store.list<AgentSession>('agent_sessions',discussion.roomId).filter(session=>session.discussionId===discussion.id)){
      const agentSession:AgentSession={...candidate,status,updatedAt:now()};
      this.store.event(discussion.roomId,type,actor,{agentSession});
    }
  }
  private scheduleRound(discussion: Discussion, basedOnSeq: number) {
    if(discussion.status!=='active'&&discussion.status!=='paused')return;
    const contextId=this.saveContext(discussion.roomId,basedOnSeq);
    const limit=discussion.activationLimit??discussion.maxResponses;
    for (const agentId of discussion.participants) {
      if (discussion.responses >= discussion.maxResponses) break;
      if ((discussion.activationsUsed??0) >= limit) { this.endDiscussion(discussion,'activation_limit','stopped',`讨论激活额度已达上限（${limit}）`); break; }
      const agentSession=this.store.list<AgentSession>('agent_sessions',discussion.roomId).find(session=>session.discussionId===discussion.id&&session.agentId===agentId);
      this.enqueue(discussion.roomId, agentId, discussionPrompt(discussion), basedOnSeq, { discussionId: discussion.id, round: discussion.round,contextId,responseSlotId:`${discussion.id}_r${discussion.round}_${agentId}`,...(agentSession?{agentSessionId:agentSession.id}:{}) });
      discussion.responses++; discussion.activationsUsed=(discussion.activationsUsed??0)+1;
    }
    this.store.event(discussion.roomId,'discussion.scheduled',SYSTEM,{discussion});
  }
  settleDiscussion(run: Run) {
    if (!run.discussionId) return;
    this.store.atomic(() => {
      const discussion = this.store.get<Discussion>('discussions', run.discussionId!); if (!discussion) return;
      if(run.discussionRole==='summary'){
        if(discussion.summary?.runId!==run.id||!['queued','interrupted'].includes(discussion.summary.status)||!terminalStates.has(run.status))return;
        const artifact=this.store.list<Artifact>('artifacts',run.roomId).find(a=>a.runId===run.id&&a.discussionId===discussion.id);
        discussion.summary={runId:run.id,status:run.status==='completed'&&artifact?'completed':run.status==='canceled'?'canceled':['unknown','interrupted'].includes(run.status)?'interrupted':'failed',...(artifact?{artifactId:artifact.id}:{}),...(run.error?{error:run.error}:run.status==='completed'&&!artifact?{error:'总结运行未生成交付物'}:{})};
        this.store.event(run.roomId,'discussion.summary.updated',SYSTEM,{discussion});return;
      }
      if(discussion.status!=='active'||run.round!==discussion.round)return;
      const round = this.store.list<Run>('runs', run.roomId).filter(r => r.discussionId === discussion.id && r.discussionRole!=='summary'&&r.round === discussion.round);
      if (!round.length) return;
      const completed = round.filter(r => r.status === 'completed');
      const quorum = Math.min(discussion.quorum ?? discussion.participants.length, round.length);
      // Convergence must hear every voice; a fast quorum cannot cancel dissenters.
      if(discussion.stopOnConvergence&&round.some(r=>!terminalStates.has(r.status)))return;
      if (completed.length < quorum) {
        if (round.some(r => !terminalStates.has(r.status))) return;
        this.endDiscussion(discussion,'no_quorum','stopped',completed.length ? `本轮未达到 quorum（${completed.length}/${quorum}）` : '本轮没有成功响应');return;
      }
      const completedAgents = new Set(completed.map(r => r.agentId));
      discussion.absent = [...new Set(discussion.participants.filter(id=>!completedAgents.has(id)))];
      for(const pending of round.filter(r=>!terminalStates.has(r.status)))this.cancel(pending,'superseded');
      const converged=discussion.stopOnConvergence&&assessConvergence(this.store,discussion,completed);
      const reason:Discussion['endReason']=Date.now()>=Date.parse(discussion.deadline)?'time_limit':converged?'converged':discussion.responses>=discussion.maxResponses?'response_limit':!discussion.stopOnConvergence&&discussion.round>=discussion.rounds?'round_limit':undefined;
      if(reason){this.endDiscussion(discussion,reason,'completed');return;}
      discussion.round++; const event = this.store.event(run.roomId, 'discussion.round', SYSTEM, { discussion });
      // Scheduling failures must not roll back an already accepted Agent response.
      try{this.scheduleRound(discussion,event.seq);}
      catch(error){this.endDiscussion(discussion,'scheduling_failed','stopped',(error as Error).message);}
    });
  }
  /** Additional model input inside one discussion turn also consumes the budget. */
  recordDiscussionContinuation(run:Run):boolean{
    if(!run.discussionId)return true;
    const discussion=this.store.get<Discussion>('discussions',run.discussionId);
    if(!discussion)return true;
    if(run.discussionRole==='summary'){
      discussion.summaryActivationsUsed=(discussion.summaryActivationsUsed??0)+1;
      const summaryLimit=discussion.summaryActivationLimit;
      if(summaryLimit&&discussion.summaryActivationsUsed>summaryLimit){discussion.summary={...discussion.summary,status:'failed',error:'总结激活额度已用尽'};this.store.event(discussion.roomId,'discussion.summary.updated',SYSTEM,{discussion});return false;}
      this.store.event(discussion.roomId,'discussion.summary.updated',SYSTEM,{discussion});return true;
    }
    if(discussion.status!=='active')return true;
    discussion.activationsUsed=(discussion.activationsUsed??0)+1;
    const limit=discussion.activationLimit;
    if(limit&&discussion.activationsUsed>limit){this.endDiscussion(discussion,'activation_limit','stopped',`讨论激活额度已达上限（${limit}）`);return false;}
    this.store.event(discussion.roomId,'discussion.round',SYSTEM,{discussion});
    return true;
  }
  private endDiscussion(discussion:Discussion,reason:NonNullable<Discussion['endReason']>,status:'completed'|'stopped',detail?:string){
    if(discussion.status!=='active'&&discussion.status!=='paused')return;
    discussion.status=status;discussion.endReason=reason;discussion.endedAt=now();
    for(const run of this.store.list<Run>('runs',discussion.roomId).filter(r=>r.discussionId===discussion.id&&r.discussionRole!=='summary'&&!terminalStates.has(r.status)))this.cancel(run,status==='completed'?'superseded':'user_cancel');
    discussion.endedSeq=this.store.room(discussion.roomId)!.seq;
    this.store.event(discussion.roomId,status==='completed'?'discussion.completed':'discussion.stopped',SYSTEM,{discussion,...(detail?{reason:detail}:{})});
    this.transitionDiscussionSessions(discussion,'ended',SYSTEM);
    if(discussion.summarizerId){
      try{
        const limit=discussion.summaryActivationLimit;
        if(limit!==undefined&&(discussion.summaryActivationsUsed??0)>=limit){discussion.summary={status:'failed',error:'总结激活额度已用尽'};}
        else{const prompt=discussionSummaryPrompt(this.store,discussion);const summary=this.enqueue(discussion.roomId,discussion.summarizerId,prompt,this.store.room(discussion.roomId)!.seq,{discussionId:discussion.id,discussionRole:'summary'});discussion.summaryActivationsUsed=(discussion.summaryActivationsUsed??0)+1;discussion.summary={runId:summary.id,status:'queued'};}
      }catch(error){discussion.summary={status:'failed',error:(error as Error).message.slice(0,2000)};}
      this.store.event(discussion.roomId,'discussion.summary.updated',SYSTEM,{discussion});
    }
  }
  /** Turn pending subscription wake intents into one queued Run per AgentSession. */
  dispatchPendingWakes(){
    this.store.atomic(()=>{
      for(const wakeIntent of this.store.list<WakeIntent>('wake_intents').filter(intent=>intent.status==='pending')){
        const session=this.store.get<AgentSession>('agent_sessions',wakeIntent.agentSessionId);
        if(!session||session.status!=='active'||!this.store.room(session.roomId)?.members.includes(session.agentId))continue;
        if(wakeIntent.deliveryMode==='steer'){
          const agent=this.store.get<AgentDescriptor>('agents',session.agentId);
          if(!agent){wakeIntent.status='suppressed';wakeIntent.suppressionReason='agent_missing';this.store.event(session.roomId,'wake.suppressed',SYSTEM,{wakeIntent});continue;}
          const fingerprint=agentCapabilityFingerprint(agent),state=verifiedCapabilityState(fingerprint,this.store.list<CapabilityEvidence>('capability_evidence',session.roomId).filter(item=>item.fingerprint===fingerprint),'steerDuringRun');
          if(state!=='verified_supported'){wakeIntent.status='suppressed';wakeIntent.suppressionReason='steer_unverified';this.store.event(session.roomId,'wake.suppressed',SYSTEM,{wakeIntent});continue;}
        }
        if(this.store.list<Run>('runs',session.roomId).some(run=>run.agentSessionId===session.id&&!terminalStates.has(run.status)))continue;
        const event=this.store.events(session.roomId,Math.max(0,wakeIntent.sourceSeq-1),1).find(item=>item.seq===wakeIntent.sourceSeq);
        const message=(event?.payload as any)?.message, task=(event?.payload as any)?.task;
        const prompt=message?.text??task?.title??('订阅命中事件 '+(event?.type??'unknown'));
        try{
          const run=this.enqueue(session.roomId,session.agentId,prompt,this.store.room(session.roomId)!.seq,{agentSessionId:session.id,...(wakeIntent.deliveryMode?{inputDeliveryMode:wakeIntent.deliveryMode}:{}),...(event?.traceId?{traceId:event.traceId}:{})});
          wakeIntent.status='assigned';wakeIntent.runId=run.id;
          this.store.event(session.roomId,'wake.assigned',SYSTEM,{wakeIntent});
        }catch{/* Queue/pressure errors leave the wake pending for a later tick. */}
      }
    });
  }
  stopDiscussion(discussion: Discussion, reason: string) {
    this.store.atomic(()=>{
      if(discussion.status==='active'||discussion.status==='paused'){
        this.endDiscussion(discussion,reason==='讨论时间上限'?'time_limit':'user_stop','stopped',reason);
      }else if(discussion.summary?.status==='queued'&&discussion.summary.runId){
        const run=this.store.get<Run>('runs',discussion.summary.runId);if(run)this.cancel(run);
      }
    });
  }
  cancel(run: Run,reason:'user_cancel'|'superseded'='user_cancel') {
    if (terminalStates.has(run.status)) return;
    run.stopReason=reason;
    run.status = run.status === 'queued' && !run.codex ? reason==='superseded'?'superseded':'canceled' : 'cancel_requested'; run.updatedAt = now();
     this.store.event(run.roomId, 'run.updated', OWNER, { run }, null, run.id);
    if(run.taskId){const task=this.store.get<Task>('tasks',run.taskId);if(task&&task.version===run.taskVersion){task.status=run.status;this.store.event(run.roomId,'task.updated',SYSTEM,{task});}}
    queueMicrotask(() => { this.onCancel(run.id); if (run.status === 'canceled'||run.status==='superseded') this.settleDiscussion(run); });
  }
}
