import type { RoomEvent } from '../../../packages/protocol/src/index.ts';

export interface OutboundDeliverySummary {
  deliveryId: string;
  url: string;
  throughSeq: number;
  redacted: boolean;
  createdAt: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  lastError?: string;
  deliveredAt?: string;
}

/** Derive owner-visible outbound state from the durable event log. */
export function summarizeOutboundDeliveries(events: readonly RoomEvent[], maxAttempts = 8): OutboundDeliverySummary[] {
  const deliveries = new Map<string, OutboundDeliverySummary>();
  for (const event of events) {
    const payload = event.payload as any;
    if (event.type === 'outbound.enqueued' && payload?.deliveryId) {
      deliveries.set(payload.deliveryId, {deliveryId: payload.deliveryId, url: payload.url, throughSeq: payload.throughSeq, redacted: payload.redacted, createdAt: payload.createdAt, status: 'pending', attempts: 0});
    } else if (event.type === 'outbound.attempted' && deliveries.has(payload?.deliveryId)) {
      const delivery = deliveries.get(payload.deliveryId)!;
      delivery.attempts++;
      if (payload.error) delivery.lastError = payload.error;
    } else if (event.type === 'outbound.delivered' && deliveries.has(payload?.deliveryId)) {
      const delivery = deliveries.get(payload.deliveryId)!;
      delivery.status = 'delivered';
      delivery.deliveredAt = payload.at;
    }
  }
  for (const delivery of deliveries.values()) if (delivery.attempts >= maxAttempts && delivery.status === 'pending') delivery.status = 'failed';
  return [...deliveries.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
