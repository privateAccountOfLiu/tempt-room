import type { InboxDelivery, InputBatch, Integration, Run, WakeIntent } from '../../../packages/protocol/src/index.ts';
import type { BudgetReservation } from '../../../packages/protocol/src/index.ts';
import type { Store } from './store.ts';

export interface RoomMetrics {
  queueDepth: number;
  activeRuns: number;
  oldestPendingAgeMs: number;
  unknownRuns: number;
  pendingWakes: number;
  pendingDeliveries: number;
  unknownBatches: number;
  unknownIntegrations: number;
  integrationConflicts: number;
  budgetReservedUsd: number;
  unknownCostReservations: number;
  subscriptions: number;
  enqueueToStartAvgMs: number;
  enqueueToStartP95Ms: number;
  runDurationAvgMs: number;
  enqueueToStartHistogram: Record<string, number>;
  runDurationHistogram: Record<string, number>;
}

const isPending = (run: Run) => run.status === 'queued';

export function collectMetrics(store: Store): RoomMetrics {
  let queueDepth = 0, activeRuns = 0, oldestPendingAgeMs = 0, unknownRuns = 0;
  const startLatencies: number[] = [], durations: number[] = [];
  for (const run of store.list<Run>('runs')) {
    if (isPending(run)) {
      queueDepth++;
      oldestPendingAgeMs = Math.max(oldestPendingAgeMs, Math.max(0, Date.now() - Date.parse(run.createdAt)));
    }
    if (['running', 'waiting_input'].includes(run.status)) activeRuns++;
    if (run.status === 'unknown') unknownRuns++;
    if (run.startedAt) startLatencies.push(Math.max(0, Date.parse(run.startedAt) - Date.parse(run.createdAt)));
    if (run.startedAt && run.finishedAt) durations.push(Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt)));
  }
  const pendingWakes = store.list<WakeIntent>('wake_intents').filter(item => item.status === 'pending').length;
  const pendingDeliveries = store.list<InboxDelivery>('inbox_deliveries').filter(item => item.status === 'pending' || item.status === 'batched').length;
  const unknownBatches = store.list<InputBatch>('input_batches').filter(item => item.status === 'unknown').length;
  const integrations = store.list<Integration>('integrations');
  const reservations = store.list<BudgetReservation>('budget_reservations');
  return {
    queueDepth,
    activeRuns,
    oldestPendingAgeMs,
    unknownRuns,
    pendingWakes,
    pendingDeliveries,
    unknownBatches,
    unknownIntegrations: integrations.filter(item => item.status === 'unknown').length,
    integrationConflicts: integrations.filter(item => item.status === 'conflict').length,
    budgetReservedUsd: Number(reservations.filter(item => item.status === 'reserved' || item.status === 'unknown').reduce((sum, item) => sum + item.reservedUsd, 0).toFixed(4)),
    unknownCostReservations: reservations.filter(item => item.status === 'unknown').length,
    subscriptions: store.list('subscriptions').length,
    enqueueToStartAvgMs: average(startLatencies),
    enqueueToStartP95Ms: percentile(startLatencies, 0.95),
    runDurationAvgMs: average(durations),
    enqueueToStartHistogram: histogram(startLatencies),
    runDurationHistogram: histogram(durations)
  };
}

/** Prometheus text exposition with no unbounded labels. */
export function metricsText(metrics: RoomMetrics): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(metrics)) {
    if (name === 'enqueueToStartHistogram' || name === 'runDurationHistogram') continue;
    lines.push(`tempt_room_${name} ${value}`);
  }
  for (const [metric, buckets] of [['enqueueToStart', metrics.enqueueToStartHistogram], ['runDuration', metrics.runDurationHistogram]] as const) {
    for (const [le, count] of Object.entries(buckets)) lines.push(`tempt_room_${metric}_bucket{le="${le}"} ${count}`);
    lines.push(`tempt_room_${metric}_count ${Object.values(buckets).at(-1) ?? 0}`);
  }
  return lines.join('\n') + '\n';
}

function average(values: number[]): number { return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0; }
function percentile(values: number[], ratio: number): number { if (!values.length) return 0; const sorted=[...values].sort((a,b)=>a-b); return Math.round(sorted[Math.min(sorted.length-1, Math.floor((sorted.length-1)*ratio))]); }

function histogram(values: number[]): Record<string, number> { const bounds=[100,500,1000,5000,30000]; const result: Record<string, number>={}; for(const bound of bounds)result[String(bound)]=values.filter(value=>value<=bound).length;result['+Inf']=values.length;return result; }
