import type { Run } from '../../../packages/protocol/src/index.ts';

/**
 * Least-recently-served ordering for the Worker's single dispatch loop.
 *
 * A fast agent that just finished a run goes to the back of the conceptual
 * queue; agents that have never been served (or waited longest) go first.
 * Ties preserve creation order (aging), so no ready run can be starved by a
 * higher-throughput peer. Active/concurrency guards still live in the Worker.
 */
export function fairOrder(runs: readonly Run[], servedAt: ReadonlyMap<string, number>, weights?: ReadonlyMap<string, number>): Run[] {
  return [...runs].sort((a, b) => {
    const aKey = `${a.roomId}/${a.agentId}`, bKey = `${b.roomId}/${b.agentId}`;
    const aWeight = weights?.get(a.agentId) ?? 1, bWeight = weights?.get(b.agentId) ?? 1;
    const aServed = (servedAt.get(aKey) ?? 0) / aWeight, bServed = (servedAt.get(bKey) ?? 0) / bWeight;
    if (aServed !== bServed) return aServed - bServed;
    return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  });
}
