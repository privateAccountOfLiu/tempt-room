import { ProtocolError, normalizeRoom, terminalStates, type AgentSession, type Discussion, type Integration, type ResourceLease, type Room, type Run, type Subscription, type Task, type WakeIntent } from '../../../packages/protocol/src/index.ts';
import type { EventStore } from './ports/event-store.ts';

/**
 * Pure room configuration planning.
 *
 * A configuration is saved as one complete room object, one revision and one
 * room.configured event. Validation happens before any write, so an unknown
 * member or a busy removed member rolls back the name/description change too.
 */
export interface RoomConfigurationInput {
  name: string;
  description: string;
  members: string[];
  expectedRevision: number;
}

export interface RoomConfigurationPlan {
  next: Room;
  addedMemberIds: string[];
  removedMemberIds: string[];
  revision: number;
  changed: boolean;
}

/** Human-readable, structured reasons a member cannot be removed right now. */
export function memberBusyReasons(store: EventStore, roomId: string, memberId: string): string[] {
  const reasons: string[] = [];
  const activeRun = store.list<Run>('runs', roomId).some(run => run.agentId === memberId && !terminalStates.has(run.status));
  if (activeRun) reasons.push('active-run');
  const activeTask = store.list<Task>('tasks', roomId).some(task => task.agentId === memberId && ['proposed', 'queued', 'running', 'waiting_input', 'cancel_requested'].includes(task.status));
  if (activeTask) reasons.push('active-task');
  const activeDiscussion = store.list<Discussion>('discussions', roomId).some(discussion => discussion.status === 'active' && discussion.participants.includes(memberId));
  if (activeDiscussion) reasons.push('active-discussion');
  const activeLease = store.list<ResourceLease>('resource_leases', roomId).some(lease => {
    if (!['active', 'quarantined'].includes(lease.status)) return false;
    const run = store.get<Run>('runs', lease.holderRunId);
    return run?.agentId === memberId;
  });
  if (activeLease) reasons.push('resource-lease');
  return reasons;
}

/** Plan a revision-guarded full room update. Validation only; no writes. */
export function planRoomConfiguration(store: EventStore, room: Room, input: RoomConfigurationInput): RoomConfigurationPlan {
  const current = normalizeRoom(room);
  if (current.status !== 'active') throw new ProtocolError('room_inactive', '房间当前不可修改', 409);
  if (current.revision !== input.expectedRevision) throw new ProtocolError('room_revision_conflict', '房间设置已被其他窗口修改，请刷新后重试', 409);
  const members = [...new Set(input.members)];
  for (const member of members) if (!store.get('agents', member)) throw new ProtocolError('invalid_member', '成员不存在', 400);
  const addedMemberIds = members.filter(member => !current.members.includes(member));
  const removedMemberIds = current.members.filter(member => !members.includes(member));
  for (const member of removedMemberIds) {
    const reasons = memberBusyReasons(store, current.id, member);
    if (reasons.length > 0) throw new ProtocolError('member_busy', `成员 ${member} 仍有未结束的工作：${reasons.join(', ')}`, 409);
  }
  const name = input.name.trim();
  const next: Room = {...current, name, description: input.description, members, revision: current.revision + 1};
  const changed = name !== current.name || input.description !== current.description || addedMemberIds.length > 0 || removedMemberIds.length > 0;
  return {next, addedMemberIds, removedMemberIds, revision: changed ? (next.revision ?? current.revision + 1) : current.revision, changed};
}

/** End idle logical sessions/subscriptions for removed members. */
export function retireRemovedMembers(store: EventStore, roomId: string, removedMemberIds: string[], actor: {id: string; kind: 'human' | 'agent' | 'system'}): void {
  if (removedMemberIds.length === 0) return;
  const removed = new Set(removedMemberIds);
  for (const session of store.list<AgentSession>('agent_sessions', roomId)) {
    if (!removed.has(session.agentId) || session.status !== 'active') continue;
    const ended: AgentSession = {...session, status: 'ended', updatedAt: new Date().toISOString()} as AgentSession;
    store.event(roomId, 'agent_session.ended', actor, {agentSession: ended});
  }
  for (const subscription of store.list<Subscription>('subscriptions', roomId)) {
    if (!subscription.agentSessionId) continue;
    const session = store.get<AgentSession>('agent_sessions', subscription.agentSessionId);
    if (session && removed.has(session.agentId) && subscription.enabled) {
      store.event(roomId, 'subscription.updated', actor, {subscription: {...subscription, enabled: false}});
    }
  }
}

/** Plan a deletion request; repeated requests return the existing state. */
export function planRoomDeletion(room: Room, expectedRevision: number, actorId: string, commandId: string): {next?: Room; status: 'deleting' | 'deleted'} {
  const current = normalizeRoom(room);
  if (current.status === 'deleting' || current.status === 'deleted') return {status: current.status};
  if (current.revision !== expectedRevision) throw new ProtocolError('room_revision_conflict', '房间设置已被其他窗口修改，请刷新后重试', 409);
  return {status: 'deleting', next: {...current, revision: current.revision + 1, status: 'deleting', deletion: {requestedAt: new Date().toISOString(), requestedBy: actorId, commandId, pendingReasons: []}}};
}
