import type { AgentSession, RoomEvent, Subscription } from '../../../packages/protocol/src/index.ts';

export interface WakeDecision { wake: boolean; reason?: string; scopeKey?: string }
const excludedTypes = new Set([
  'subscription.updated', 'inbox.delivered', 'wake.requested', 'wake.assigned', 'wake.suppressed',
  'audit.recorded', 'run.tool.completed', 'agent.tool.called', 'room.git.checkpoint',
  'run.partial', 'run.finalized', 'run.updated', 'run.started', 'run.blocked', 'run.completed',
  'run.failed', 'run.cancelled', 'run.superseded', 'run.interrupted', 'run.unknown', 'run.cancel.requested',
  'typing', 'presence', 'ack', 'message.delta', 'token.delta'
]);
const assignedTypes = new Set(['task.created', 'task.handoff']);

/**
 * Pure trigger policy: subscription chooses delivery, wake policy decides
 * whether work is required. Typing/partial/status/audit never wake by default.
 */
export function shouldWake(event: RoomEvent, session: AgentSession, subscription: Subscription): WakeDecision {
  if (!subscription.enabled || session.status !== 'active') return {wake: false, reason: 'subscription_or_session_inactive'};
  if (excludedTypes.has(event.type) || event.type.startsWith('audit.') || event.type.startsWith('agent.tool.')) return {wake: false, reason: 'excluded_event'};
  if (subscription.eventTypes.length && !subscription.eventTypes.includes(event.type)) return {wake: false, reason: 'event_type_not_subscribed'};
  const scopeKey = `${session.id}:${event.eventId}`;
  if (event.type === 'chat.message.created') {
    const message = (event.payload as any).message;
    if (!message) return {wake: false, reason: 'malformed_message'};
    if (message.actor?.kind === 'agent' && message.actor.id === session.agentId) return {wake: false, reason: 'self_message'};
    if (Array.isArray(message.mentions) && message.mentions.includes(session.agentId)) return {wake: true, reason: 'explicit_mention', scopeKey};
    if (subscription.sourcePolicy === 'assigned-task' && message.taskId && message.taskId === subscription.taskIds[0]) return {wake: true, reason: 'assigned_task_message', scopeKey};
    return {wake: false, reason: 'no_trigger'};
  }
  if (assignedTypes.has(event.type) && subscription.sourcePolicy === 'assigned-task') {
    const task = (event.payload as any).task;
    if (task?.agentId === session.agentId) return {wake: true, reason: 'assigned_task', scopeKey};
  }
  return {wake: false, reason: 'no_trigger'};
}
