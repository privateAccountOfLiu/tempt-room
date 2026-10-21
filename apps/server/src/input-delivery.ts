import { ProtocolError, type InboxDelivery, type InputBatch, type InputDeliveryMode } from '../../../packages/protocol/src/index.ts';
import { digest, now, Store, SYSTEM, uid } from './store.ts';
import type { EventStore } from './ports/event-store.ts';

export interface CreateBatchInput {
  roomId: string;
  agentSessionId: string;
  runId?: string;
  generation: number;
  executionId: string;
  deliveryMode?: InputDeliveryMode;
}

/** Persist a bounded input batch before any adapter receives it. */
export class InputDeliveryService {
  constructor(private store: EventStore) {}

  createBatch(input: CreateBatchInput): InputBatch | undefined {
    return this.store.atomic(() => {
      const pending = this.store.list<InboxDelivery>('inbox_deliveries', input.roomId).filter(delivery => delivery.agentSessionId === input.agentSessionId && delivery.status === 'pending');
      if (!pending.length) return undefined;
      const sourceEventIds = pending.map(delivery => delivery.sourceEventId);
      const fromScanSeq = Math.min(...pending.map(delivery => delivery.sourceSeq)) - 1;
      const throughScanSeq = Math.max(...pending.map(delivery => delivery.sourceSeq));
      const batch: InputBatch = {
        id: uid('batch'), agentSessionId: input.agentSessionId, ...(input.runId ? {runId: input.runId} : {}),
        generation: input.generation, executionId: input.executionId,
        deliveryIds: pending.map(delivery => delivery.id), sourceEventIds,
        fromScanSeq: Math.max(0, fromScanSeq), throughScanSeq,
        payloadHash: digest({sourceEventIds, deliveryIds: pending.map(delivery => delivery.id), deliveryMode: input.deliveryMode ?? 'next-turn'}),
        deliveryMode: input.deliveryMode ?? 'next-turn', createdAt: now(), status: 'created'
      };
      this.store.event(input.roomId, 'input.batch.created', SYSTEM, {batch});
      for (const delivery of pending) this.store.event(input.roomId, 'inbox.delivered', SYSTEM, {delivery: {...delivery, status: 'batched', batchId: batch.id}});
      return batch;
    });
  }

  provideBatch(roomId: string, batchId: string, receiptEvidence: string): InputBatch {
    return this.store.atomic(() => {
      const batch = this.store.list<InputBatch>('input_batches').find(item => item.id === batchId);
      if (!batch) throw new ProtocolError('not_found', '输入批次不存在', 404);
      if (batch.status === 'provided' || batch.status === 'acknowledged') return batch;
      if (batch.status !== 'created') throw new ProtocolError('invalid_state', '输入批次不能再次提供', 409);
      const next: InputBatch = {...batch, status: 'provided', providedAt: now(), receiptEvidence: receiptEvidence.slice(0, 500)};
      this.store.event(roomId, 'input.batch.provided', SYSTEM, {batch: next});
      for (const delivery of this.store.list<InboxDelivery>('inbox_deliveries', roomId).filter(item => item.agentSessionId === batch.agentSessionId && item.batchId === batch.id)) {
        this.store.event(roomId, 'inbox.delivered', SYSTEM, {delivery: {...delivery, status: 'provided'}});
      }
      return next;
    });
  }

  acknowledgeBatch(roomId: string, batchId: string, agentSessionId: string, receiptEvidence: string): InputBatch {
    return this.store.atomic(() => {
      const batch = this.store.list<InputBatch>('input_batches').find(item => item.id === batchId);
      if (!batch) throw new ProtocolError('not_found', '输入批次不存在', 404);
      if (batch.agentSessionId !== agentSessionId) throw new ProtocolError('forbidden', '输入批次不属于该 AgentSession', 403);
      if (batch.status === 'acknowledged') return batch;
      if (batch.status !== 'provided') throw new ProtocolError('invalid_state', '只有已提供的批次可以确认', 409);
      const next: InputBatch = {...batch, status: 'acknowledged', receiptEvidence: receiptEvidence.slice(0, 500)};
      this.store.event(roomId, 'input.batch.acknowledged', SYSTEM, {batch: next});
      return next;
    });
  }


  reconcileBatch(roomId: string, batchId: string, decision: 'expire' | 'unknown' | 'provided'): InputBatch {
    return this.store.atomic(() => {
      const batch = this.store.list<InputBatch>('input_batches', roomId).find(item => item.id === batchId);
      if (!batch) throw new ProtocolError('not_found', '输入批次不存在', 404);
      if (['acknowledged', 'expired'].includes(batch.status)) throw new ProtocolError('invalid_state', '终态输入批次不能再次核对', 409);
      if (decision === 'provided' && batch.status !== 'created') throw new ProtocolError('invalid_state', '只有 created 批次可以标记 provided', 409);
      const status: InputBatch['status'] = decision === 'expire' ? 'expired' : decision === 'unknown' ? 'unknown' : 'provided';
      const next: InputBatch = {...batch, status};
      const type = decision === 'expire' ? 'input.batch.expired' : decision === 'provided' ? 'input.batch.provided' : 'input.batch.updated';
      this.store.event(roomId, type, SYSTEM, {batch: next});
      if (decision === 'expire') for (const delivery of this.store.list<InboxDelivery>('inbox_deliveries', roomId).filter(item => item.batchId === batch.id)) this.store.event(roomId, 'inbox.delivered', SYSTEM, {delivery: {...delivery, status: 'expired'}});
      return next;
    });
  }

}
