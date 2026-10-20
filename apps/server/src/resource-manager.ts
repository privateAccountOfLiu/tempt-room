import { ProtocolError, type CleanupProof, type ResourceLease, type Run } from '../../../packages/protocol/src/index.ts';
import { now, Store, SYSTEM, uid } from './store.ts';

export interface AcquireInput {
  roomId: string;
  kind: ResourceLease['kind'];
  key: string;
  run: Pick<Run, 'id' | 'generation' | 'executionId'>;
  capacity?: number;
  leaseMs?: number;
}

export function acquireResource(store: Store, input: AcquireInput): ResourceLease {
  return store.atomic(() => {
    const canonicalKey = normalizeResourceKey(input.key);
    const existing = store.list<ResourceLease>('resource_leases', input.roomId).filter(item => item.canonicalKey === canonicalKey && ['active', 'quarantined'].includes(item.status));
    if (existing.some(item => item.status === 'quarantined')) throw new ProtocolError('resource_quarantined', `资源仍处于隔离状态：${canonicalKey}`, 409);
    if (existing.length >= (input.capacity ?? 1)) throw new ProtocolError('resource_busy', `资源已被其他运行占用：${canonicalKey}`, 409);
    const lease: ResourceLease = {
      id: uid('lease'), roomId: input.roomId, kind: input.kind, canonicalKey, capacity: input.capacity ?? 1,
      holderRunId: input.run.id, ...(input.run.executionId ? {executionId: input.run.executionId} : {}), generation: input.run.generation ?? 1,
      status: 'active', ...(input.leaseMs ? {leaseUntil: new Date(Date.now() + input.leaseMs).toISOString()} : {}), createdAt: now(), updatedAt: now()
    };
    store.event(input.roomId, 'resource.acquired', SYSTEM, {lease});
    return lease;
  });
}

export function releaseResource(store: Store, roomId: string, leaseId: string, proof: CleanupProof): ResourceLease {
  return store.atomic(() => {
    const lease = store.list<ResourceLease>('resource_leases', roomId).find(item => item.id === leaseId);
    if (!lease) throw new ProtocolError('not_found', '资源租约不存在', 404);
    if (!['active', 'quarantined'].includes(lease.status)) throw new ProtocolError('invalid_state', '只有 active/quarantined 租约可以释放', 409);
    if (proof.remainingProcesses > 0) throw new ProtocolError('cleanup_unproven', '仍检测到受控进程，不能释放资源', 409);
    const next: ResourceLease = {...lease, status: 'released', cleanupProof: proof, updatedAt: now()};
    store.event(roomId, 'resource.released', SYSTEM, {lease: next});
    return next;
  });
}

export function quarantineResource(store: Store, roomId: string, leaseId: string, reason: string): ResourceLease {
  return store.atomic(() => {
    const lease = store.list<ResourceLease>('resource_leases', roomId).find(item => item.id === leaseId);
    if (!lease) throw new ProtocolError('not_found', '资源租约不存在', 404);
    const next: ResourceLease = {...lease, status: 'quarantined', quarantineReason: reason.slice(0, 500), updatedAt: now()};
    store.event(roomId, 'resource.quarantined', SYSTEM, {lease: next});
    return next;
  });
}

/** Leases from a previous process have no trustworthy cleanup proof. */
export function expireQuarantinedLeases(store: Store, ttlMs: number): number {
  if (ttlMs <= 0) return 0;
  const cutoff = Date.now() - ttlMs;
  let expired = 0;
  for (const lease of store.list<ResourceLease>('resource_leases').filter(item => item.status === 'quarantined' && Date.parse(item.updatedAt) <= cutoff)) {
    const next: ResourceLease = {...lease, status: 'revoked', updatedAt: now()};
    store.event(lease.roomId, 'resource.released', SYSTEM, {lease: next});
    expired++;
  }
  return expired;
}

export function recoverResourceLeases(store: Store): number {
  let recovered = 0;
  for (const lease of store.list<ResourceLease>('resource_leases').filter(item => item.status === 'active')) {
    quarantineResource(store, lease.roomId, lease.id, 'restart_without_cleanup_proof');
    recovered++;
  }
  return recovered;
}

export function expireResourceLeases(store: Store): number {
  let expired = 0;
  for (const lease of store.list<ResourceLease>('resource_leases').filter(item => item.status === 'active' && item.leaseUntil && Date.parse(item.leaseUntil) <= Date.now())) {
    const next: ResourceLease = {...lease, status: 'revoked', updatedAt: now()};
    store.event(lease.roomId, 'resource.released', SYSTEM, {lease: next});
    expired++;
  }
  return expired;
}

export function normalizeResourceKey(key: string): string {
  const normalized = key.replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
