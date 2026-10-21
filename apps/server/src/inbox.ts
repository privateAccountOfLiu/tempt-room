import { ProtocolError, terminalStates, type AgentSession, type InboxDelivery, type RoomEvent, type Subscription, type WakeIntent } from '../../../packages/protocol/src/index.ts';
import { digest, now, Store, SYSTEM } from './store.ts';
import { shouldWake } from './wake-policy.ts';
import type { EventStore } from './ports/event-store.ts';

export interface InboxScanResult {
  blocked?: string;
  scanSeq: number;
  throughSeq: number;
  deliveries: string[];
  wakeIntents: string[];
  matchedEventIds: string[];
}

/**
 * Persistent subscription scanner. It is deliberately independent from Run
 * creation: delivery and wake intent are facts, execution is a later decision.
 */
export class InboxService {
  constructor(private store: EventStore) {}

  scan(roomId: string, agentSessionId: string, options: {throughSeq?: number} = {}): InboxScanResult {
    return this.store.atomic(() => this.scanInsideTransaction(roomId, agentSessionId, options.throughSeq));
  }

  private scanInsideTransaction(roomId: string, agentSessionId: string, throughOption?: number): InboxScanResult {
    const subscription = this.store.list<Subscription>('subscriptions', roomId).find(item => item.agentSessionId === agentSessionId);
    const throughSeq = throughOption ?? this.store.room(roomId)!.seq;
    if (!subscription) return {blocked: 'no_subscription', scanSeq: 0, throughSeq, deliveries: [], wakeIntents: [], matchedEventIds: []};
    const session = this.store.get<AgentSession>('agent_sessions', agentSessionId);
    if (!session) return {blocked: 'no_agent_session', scanSeq: subscription.scanSeq, throughSeq, deliveries: [], wakeIntents: [], matchedEventIds: []};
    if (!subscription.enabled) return {blocked: 'subscription_disabled', scanSeq: subscription.scanSeq, throughSeq, deliveries: [], wakeIntents: [], matchedEventIds: []};
    if (session.status !== 'active') return {blocked: 'agent_session_inactive', scanSeq: subscription.scanSeq, throughSeq, deliveries: [], wakeIntents: [], matchedEventIds: []};
    if (!this.store.room(roomId)?.members.includes(session.agentId)) return {blocked: 'membership_revoked', scanSeq: subscription.scanSeq, throughSeq, deliveries: [], wakeIntents: [], matchedEventIds: []};
    if (throughSeq < subscription.scanSeq) throw new ProtocolError('invalid_cursor', '扫描水位早于订阅游标', 400);

    const pending = this.store.list<InboxDelivery>('inbox_deliveries', roomId).filter(delivery => delivery.status === 'pending' || delivery.status === 'batched');
    let pendingCount = pending.length;
    let pendingBytes = pending.reduce((sum, delivery) => sum + (delivery.sourceBytes ?? 0), 0);
    const plannedDeliveries: InboxDelivery[] = [], plannedWakes: WakeIntent[] = [], matchedEventIds: string[] = [];
    for (const event of this.store.scanEvents(roomId, {afterSeq: subscription.scanSeq, throughSeq, pageSize: 500})) {
      const decision = shouldWake(event, session, subscription);
      if (!decision.wake) continue;
      matchedEventIds.push(event.eventId);
      const deliveryId = 'del_' + digest([agentSessionId, event.eventId]).slice(0, 64);
      const wakeId = 'wake_' + digest([agentSessionId, event.eventId]).slice(0, 64);
      if (this.store.get<InboxDelivery>('inbox_deliveries', deliveryId) || this.store.get<WakeIntent>('wake_intents', wakeId)) continue;
      const sourceBytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
      const delivery: InboxDelivery = {id: deliveryId, agentSessionId, sourceEventId: event.eventId, sourceSeq: event.seq, status: 'pending', sourceBytes};
      const wakeIntent: WakeIntent = {id: wakeId, scopeKey: decision.scopeKey ?? `${agentSessionId}:${event.eventId}`, agentSessionId, sourceEventId: event.eventId, sourceSeq: event.seq, deliveryMode: subscription.deliveryMode, status: 'pending'};
      plannedDeliveries.push(delivery); plannedWakes.push(wakeIntent);
      pendingCount++; pendingBytes += sourceBytes;
    }
    const settings = this.store.settings();
    if (pendingCount > settings.maxInboxDeliveries) throw new ProtocolError('inbox_full', `收件箱 + 待投递超过 ${settings.maxInboxDeliveries} 条上限`, 429);
    if (pendingBytes > settings.maxInboxBytes) throw new ProtocolError('inbox_full', `收件箱 + 待投递超过 ${settings.maxInboxBytes} 字节上限`, 429);

    for (const delivery of plannedDeliveries) this.store.event(roomId, 'inbox.delivered', SYSTEM, {delivery});
    for (const wakeIntent of plannedWakes) this.store.event(roomId, 'wake.requested', SYSTEM, {wakeIntent, reason: 'subscription_match'});
    const nextSubscription: Subscription = {...subscription, scanSeq: throughSeq};
    if (nextSubscription.scanSeq !== subscription.scanSeq) this.store.event(roomId, 'subscription.updated', SYSTEM, {subscription: nextSubscription});
    return {scanSeq: throughSeq, throughSeq, deliveries: plannedDeliveries.map(delivery => delivery.id), wakeIntents: plannedWakes.map(wakeIntent => wakeIntent.id), matchedEventIds};
  }


}
