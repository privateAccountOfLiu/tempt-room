import type { RoomEvent } from '../../../packages/protocol/src/index.ts';

export interface OutboundDeliverySummary {
  deliveryId: string;
  url: string;
  throughSeq: number;
  redacted: boolean;
  createdAt: string;
  status: 'pending' | 'delivered' | 'failed' | 'cleared';
  attempts: number;
  lastError?: string;
  deliveredAt?: string;
}

/** Derive owner-visible outbound state from the durable event log. */
export function summarizeOutboundDeliveries(events: readonly RoomEvent[], maxAttempts = 8): OutboundDeliverySummary[] {
  const deliveries = new Map<string, OutboundDeliverySummary>();
  const cleared = new Set<string>();
  for (const event of events) {
    const payload = event.payload as any;
    if (event.type === 'audit.recorded' && typeof payload?.action === 'string' && payload.action.startsWith('outbound.cleared:')) { cleared.add(payload.action.slice('outbound.cleared:'.length)); continue; }
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
  for (const delivery of deliveries.values()) {
    if (cleared.has(delivery.deliveryId) && delivery.status !== 'delivered') delivery.status = 'cleared';
    else if (delivery.attempts >= maxAttempts && delivery.status === 'pending') delivery.status = 'failed';
  }
  return [...deliveries.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export interface OutboundAuditRoom {
  roomId: string;
  roomName: string;
  pending: number;
  delivered: number;
  failed: number;
  cleared: number;
  deliveries: OutboundDeliverySummary[];
}

export function summarizeOutboundAudit(input: {generatedAt: string; rooms: readonly {roomId: string; roomName: string; deliveries: readonly OutboundDeliverySummary[]}[]}): {generatedAt: string; totals: {pending: number; delivered: number; failed: number; cleared: number}; rooms: OutboundAuditRoom[]} {
  const rooms = input.rooms.map(room => {
    const count = (status: OutboundDeliverySummary['status']) => room.deliveries.filter(delivery => delivery.status === status).length;
    return {roomId: room.roomId, roomName: room.roomName, pending: count('pending'), delivered: count('delivered'), failed: count('failed'), cleared: count('cleared'), deliveries: [...room.deliveries]};
  });
  return {generatedAt: input.generatedAt, totals: {pending: rooms.reduce((sum, room) => sum + room.pending, 0), delivered: rooms.reduce((sum, room) => sum + room.delivered, 0), failed: rooms.reduce((sum, room) => sum + room.failed, 0), cleared: rooms.reduce((sum, room) => sum + room.cleared, 0)}, rooms};
}
