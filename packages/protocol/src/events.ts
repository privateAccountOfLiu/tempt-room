import { z } from 'zod';
import {discussionSchema as discussion} from './discussion.ts';
import { actorSchema, artifactSchema, messageSchema, runContextSchema, runSchema, sandboxProfileSchema, taskSchema } from './models.ts';
import { executionSettingsSchema } from './settings.ts';
import {runPartialSchema} from './run-state.ts';
import {contextDeltaSchema} from './reconciliation.ts';
import { toolOperationSchema,nativeReconciliationSchema } from './execution.ts';
import { agentSessionSchema,capabilityEvidenceSchema,discussionRoundSchema,inboxDeliverySchema,inputBatchSchema,subscriptionSchema,wakeIntentSchema } from './collaboration.ts';

const id=z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const room=z.object({id,name:z.string(),description:z.string(),members:z.array(id),createdAt:z.string().datetime(),seq:z.number().int().nonnegative()}).passthrough();
const decision=z.object({id,roomId:id.optional(),text:z.string(),accepted:z.boolean(),actor:actorSchema}).passthrough();
const body=(fields:Record<string,z.ZodType>)=>z.object(fields).passthrough();
export const projectionTableNames=['messages','tasks','runs','artifacts','discussions','decisions','contexts','operations','agent_sessions','subscriptions','inbox_deliveries','input_batches','wake_intents','capability_evidence','discussion_rounds'] as const;
export type ProjectionTable=typeof projectionTableNames[number];
const checkpointRow=z.object({id}).passthrough();
// Older checkpoint payloads predate the B02 tables; missing arrays decode as empty.
export const projectionCheckpointSchema=z.object({room,rows:z.object({messages:z.array(checkpointRow),tasks:z.array(checkpointRow),runs:z.array(checkpointRow),artifacts:z.array(checkpointRow),discussions:z.array(checkpointRow),decisions:z.array(checkpointRow),contexts:z.array(checkpointRow),agent_sessions:z.array(checkpointRow).default([]),subscriptions:z.array(checkpointRow).default([]),inbox_deliveries:z.array(checkpointRow).default([]),input_batches:z.array(checkpointRow).default([]),wake_intents:z.array(checkpointRow).default([]),capability_evidence:z.array(checkpointRow).default([]),discussion_rounds:z.array(checkpointRow).default([]),operations:z.array(checkpointRow).default([])}).strict(),reason:z.enum(['legacy-migration','manual-snapshot'])}).strict();

export type ProjectorName='room'|'message'|'task'|'run'|'artifact'|'discussion'|'decision'|'context'|'settings'|'audit'|'checkpoint'|'sandbox'|'operation'|'partial'|'final'|'context-confirmed'|'agent-session'|'subscription'|'inbox-delivery'|'input-batch'|'wake-intent'|'capability-evidence'|'discussion-round';
export interface EventDefinition {
  durability:'durable'|'ephemeral'; aggregate:'room'|'task'|'run'|'artifact'; projector:ProjectorName|null;
  schemaVersion:1; kind:string|((payload:Record<string,any>)=>string); payload:z.ZodType;
  kinds:readonly string[];
}
const definitions:Record<string,EventDefinition>=Object.create(null);
function register(types:string[],kind:EventDefinition['kind'],aggregate:EventDefinition['aggregate'],projector:ProjectorName,payload:z.ZodType){
  for(const type of types)definitions[type]={durability:'durable',aggregate,projector,schemaVersion:1,kind,payload,kinds:typeof kind==='string'?[kind]:['run.queued','run.started','run.blocked','run.cancel.requested','run.completed','run.failed','run.cancelled','run.superseded','run.interrupted','run.unknown']};
}
register(['room.created','room.updated'],'room.state','room','room',body({room}));
register(['room.members.updated'],'room.members','room','room',body({members:z.array(id)}));
register(['chat.message.created','message.posted'],'message.posted','room','message',body({message:messageSchema.passthrough()}));
register(['task.created'],'task.created','task','task',body({task:taskSchema.passthrough()}));
register(['task.updated','task.accepted','task.completed','task.state'],'task.state','task','task',body({task:taskSchema.passthrough()}));
register(['task.revised','task.version'],'task.version','task','task',body({task:taskSchema.passthrough()}));
register(['task.handoff'],'task.handoff','task','task',body({task:taskSchema.passthrough()}));
register(['task.claimed','task.claim'],'task.claim','task','task',body({task:taskSchema.passthrough()}));
register(['task.context.advanced'],'task.context','task','task',body({task:taskSchema.passthrough(),delta:contextDeltaSchema.optional()}));
register(['task.lease_expired','task.released','task.lease.renewed','task.lease'],'task.lease','task','task',body({task:taskSchema.passthrough()}));
register(['run.created','run.queued'],'run.queued','run','run',body({run:runSchema.extend({status:z.literal('queued')}).passthrough(),context:runContextSchema.passthrough().optional()}));
const runKind=(payload:Record<string,any>)=>({queued:'run.queued',running:'run.started',waiting_input:'run.blocked',cancel_requested:'run.cancel.requested',completed:'run.completed',failed:'run.failed',canceled:'run.cancelled',superseded:'run.superseded',interrupted:'run.interrupted',unknown:'run.unknown'}[payload.run.status as string]??'run.state');
register(['run.updated'],runKind,'run','run',body({run:runSchema.passthrough()}));
for(const [type,status] of Object.entries({'run.started':'running','run.blocked':'waiting_input','run.completed':'completed','run.failed':'failed','run.cancelled':'canceled','run.superseded':'superseded','run.interrupted':'interrupted','run.unknown':'unknown','run.cancel.requested':'cancel_requested'}))register([type],type,'run','run',body({run:runSchema.extend({status:z.literal(status)}).passthrough()}));
register(['run.recovered'],runKind,'run','run',body({run:runSchema.extend({status:z.enum(['interrupted','unknown'])}).passthrough()}));
register(['run.requeued'],'run.queued','run','run',body({run:runSchema.extend({status:z.literal('queued')}).passthrough()}));
register(['run.reconciled'],runKind,'run','run',body({run:runSchema.passthrough()}));
register(['run.partial'],'run.partial','run','partial',body({runId:id,baseSeq:z.number().int().nonnegative(),generation:z.number().int().positive(),executionId:id,partial:runPartialSchema}));
register(['run.finalized'],'run.finalized','run','final',body({runId:id,messageId:id,generation:z.number().int().positive(),executionId:id.optional(),supersedes:id.optional()}));
register(['run.context.advanced'],'run.context.advanced','run','run',body({run:runSchema.passthrough(),delta:contextDeltaSchema}));
register(['run.context.confirmed'],'run.context.confirmed','run','context-confirmed',body({runId:id,generation:z.number().int().positive(),executionId:id,throughSeq:z.number().int().nonnegative()}));
register(['run.lease.renewed'],'run.lease','run','run',body({run:runSchema.passthrough()}));
for(const [type,status] of Object.entries({'operation.started':'started','operation.completed':'completed','operation.unknown':'unknown'}))register([type],type,'run','operation',body({operation:toolOperationSchema.extend({status:z.literal(status)})}));
register(['operation.reconciled'],'operation.reconciled','run','operation',body({operation:toolOperationSchema.extend({status:z.literal('completed')}),proof:nativeReconciliationSchema}));
register(['artifact.created','artifact.published'],'artifact.published','artifact','artifact',body({artifact:artifactSchema.passthrough()}));
register(['artifact.applied'],'artifact.applied','artifact','artifact',body({artifact:artifactSchema.extend({applied:z.literal(true)}).passthrough()}));
register(['discussion.started','discussion.paused','discussion.resumed','discussion.round','discussion.scheduled','discussion.completed','discussion.stopped','discussion.summary.updated'],'discussion.state','room','discussion',body({discussion}));
register(['decision.proposed','decision.accepted'],'decision.state','room','decision',body({decision}));
register(['settings.updated'],'settings.updated','room','settings',body({settings:executionSettingsSchema}));
register(['sandbox.verified'],'run.sandbox','run','sandbox',body({runId:id,sandbox:sandboxProfileSchema.extend({verifiedAt:z.string().datetime()})}));
register(['agent.wake.requested'],'agent.wake.requested','room','audit',body({agentId:id,messageId:id,connectionMode:z.literal('external')}));
register(['agent.configured'],'agent.configured','room','audit',body({agentId:id}));
register(['run.tool.completed'],'audit.recorded','run','audit',body({runId:id,name:z.string(),success:z.boolean()}));
register(['agent.tool.called'],'audit.recorded','room','audit',body({agentId:id,name:z.string()}));
register(['room.git.checkpoint'],'audit.recorded','run','audit',body({runId:id,agentId:id,workspace:z.string(),commit:z.string().nullable()}));
register(['audit.recorded'],'audit.recorded','room','audit',body({action:z.string().min(1)}));
register(['agent_session.created','agent_session.paused','agent_session.resumed','agent_session.ended'],'agent.session.state','room','agent-session',body({agentSession:agentSessionSchema.passthrough()}));
register(['subscription.updated'],'subscription.updated','room','subscription',body({subscription:subscriptionSchema.passthrough()}));
register(['inbox.delivered'],'inbox.delivered','room','inbox-delivery',body({delivery:inboxDeliverySchema.passthrough()}));
register(['input.batch.created','input.batch.provided','input.batch.acknowledged','input.batch.expired'],'input.batch.state','run','input-batch',body({batch:inputBatchSchema.passthrough()}));
register(['wake.requested','wake.assigned','wake.suppressed'],'wake.intent','room','wake-intent',body({wakeIntent:wakeIntentSchema.passthrough()}));
register(['capability.verified'],'capability.verified','room','capability-evidence',body({capabilityEvidence:capabilityEvidenceSchema.passthrough()}));
register(['discussion.round.opened','discussion.round.closed','discussion.round.late.received'],'discussion.round','room','discussion-round',body({round:discussionRoundSchema.passthrough()}));
register(['projection.checkpoint'],'projection.checkpoint','room','checkpoint',projectionCheckpointSchema);
register(['context.captured'],'context.captured','room','context',body({context:runContextSchema.extend({id,roomId:id}).passthrough()}));
for(const type of ['token.delta','message.delta','typing','presence','ack'])definitions[type]={durability:'ephemeral',aggregate:'room',projector:null,schemaVersion:1,kind:type,kinds:[type],payload:z.record(z.string(),z.unknown())};
for(const definition of Object.values(definitions)){Object.freeze(definition.kinds);Object.freeze(definition);}
export const eventRegistry:Readonly<Record<string,EventDefinition>>=Object.freeze(definitions);
export class EventContractError extends Error {constructor(public code:string,message:string){super(message);}}

export function eventDefinition(type:string,payload:Record<string,unknown>){
  const definition=eventRegistry[type];
  if(!definition)throw new EventContractError('unregistered_event',`事件类型未注册：${type}`);
  if(definition.durability!=='durable')throw new EventContractError('ephemeral_event',`瞬态事件不能持久化：${type}`);
  const parsed=definition.payload.safeParse(payload);
  if(!parsed.success)throw new EventContractError('invalid_event_payload',`事件 ${type} 不符合 schema v${definition.schemaVersion}: ${parsed.error.message}`);
  return {definition,payload:parsed.data as Record<string,any>};
}
export function eventMetadata(type:string,payload:Record<string,unknown>,roomId:string,correlationId:string|null){
  const {definition,payload:parsed}=eventDefinition(type,payload);
  const entity=definition.aggregate==='task'?parsed.task:definition.aggregate==='artifact'?parsed.artifact:definition.aggregate==='run'?(parsed.run??(parsed.operation?{id:parsed.operation.runId}:undefined)):undefined;
  return {kind:typeof definition.kind==='function'?definition.kind(parsed):definition.kind,schemaVersion:definition.schemaVersion,durability:definition.durability,
    aggregate:{type:definition.aggregate,id:entity?.id??parsed.runId??roomId},baseSeq:parsed.run?.contextSeq??parsed.run?.basedOnSeq??parsed.message?.basedOnSeq??parsed.task?.externalContext?.throughSeq??parsed.baseSeq??parsed.throughSeq??0,
    generation:parsed.run?.generation??parsed.task?.generation??parsed.message?.generation??parsed.artifact?.generation??parsed.operation?.generation??parsed.generation??1,replyTo:parsed.message?.replyTo??null,idempotencyKey:parsed.operation?.operationId??null as string|null,traceId:parsed.run?.traceId??correlationId??null};
}
export const eventRegistryManifest=Object.entries(eventRegistry).map(([type,definition])=>({type,durability:definition.durability,aggregate:definition.aggregate,projector:definition.projector,schemaVersion:definition.schemaVersion,kinds:definition.kinds}));
