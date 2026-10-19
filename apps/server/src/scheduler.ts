import type { Run } from '../../../packages/protocol/src/index.ts';

/**
 * Legacy least-recently-served ordering. Kept for compatibility and for
 * callers that only need a stateless stable order. The Worker uses
 * ReadyScheduler below, which tracks weighted credits across dispatches.
 */
export function fairOrder(runs: readonly Run[], servedAt: ReadonlyMap<string, number>): Run[] {
  return [...runs].sort((a, b) => {
    const aServed = servedAt.get(`${a.roomId}/${a.agentId}`) ?? 0;
    const bServed = servedAt.get(`${b.roomId}/${b.agentId}`) ?? 0;
    if (aServed !== bServed) return aServed - bServed;
    return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  });
}

interface FlowState { credit: number; wait: number; weight: number }
interface RoomState { flows: Map<string, FlowState>; weightSignature: string; servedAt: number }

/**
 * Dispatch-slot fairness:
 * - rooms are polled round-robin;
 * - inside a room each Agent flow follows smooth weighted round-robin;
 * - a flow that has waited maxBypassDispatches eligible dispatches is served
 *   next so a newly added or high-weight flow cannot starve it forever.
 *
 * A picked flow is only marked as served after the caller commits run.started.
 */
export class ReadyScheduler {
  private rooms = new Map<string, RoomState>();
  private clock = 0;

  reset(): void { this.rooms.clear(); this.clock = 0; }

  pick(eligible: readonly Run[], weights: ReadonlyMap<string, number> = new Map(), maxBypassDispatches = 5): Run | undefined {
    if (!eligible.length) return undefined;
    const byRoom = new Map<string, Map<string, Run[]>>();
    for (const run of eligible) {
      const flow = `${run.roomId}/${run.agentId}`;
      if (!byRoom.has(run.roomId)) byRoom.set(run.roomId, new Map());
      const flows = byRoom.get(run.roomId)!;
      if (!flows.has(flow)) flows.set(flow, []);
      flows.get(flow)!.push(run);
    }
    // Choose the room that was served least recently; an empty/blocked room is
    // simply absent from the eligible map and cannot hold other rooms back.
    const roomId = [...byRoom.keys()].sort((a, b) => {
      const served = (this.rooms.get(a)?.servedAt ?? 0) - (this.rooms.get(b)?.servedAt ?? 0);
      return served || a.localeCompare(b);
    })[0];
    const flows = byRoom.get(roomId)!;
    const state = this.roomState(roomId, flows, weights);
    // Add credit/wait for every currently eligible flow. A flow that is blocked
    // has no eligible run and therefore accumulates neither.
    for (const [flow, runs] of flows) {
      const entry = state.flows.get(flow)!;
      entry.credit += entry.weight;
      entry.wait += 1;
      runs.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
    }
    const bypass = [...flows.keys()].filter(flow => state.flows.get(flow)!.wait >= maxBypassDispatches);
    let chosenFlow: string;
    if (bypass.length) {
      chosenFlow = bypass.sort((a, b) => {
        const aw = state.flows.get(a)!, bw = state.flows.get(b)!;
        return bw.wait - aw.wait || bw.credit - aw.credit || a.localeCompare(b);
      })[0];
    } else {
      chosenFlow = [...flows.keys()].sort((a, b) => {
        const aw = state.flows.get(a)!, bw = state.flows.get(b)!;
        const aOldest = flows.get(a)![0].createdAt, bOldest = flows.get(b)![0].createdAt;
        return bw.credit - aw.credit || aOldest.localeCompare(bOldest) || a.localeCompare(b);
      })[0];
    }
    const totalWeight = [...flows.keys()].reduce((sum, flow) => sum + state.flows.get(flow)!.weight, 0);
    state.flows.get(chosenFlow)!.credit -= totalWeight;
    const chosenRuns = flows.get(chosenFlow)!;
    return chosenRuns[0];
  }

  /** Commit a dispatch after its fencing/start event succeeded. */
  recordServed(run: Run): void {
    const flow = `${run.roomId}/${run.agentId}`;
    const state = this.rooms.get(run.roomId);
    const entry = state?.flows.get(flow);
    if (entry) entry.wait = 0;
    if (state) state.servedAt = ++this.clock;
  }

  private roomState(roomId: string, flows: Map<string, Run[]>, weights: ReadonlyMap<string, number>): RoomState {
    const signature = [...flows.keys()].sort().map(flow => `${flow}:${weights.get(flow.split('/')[1]) ?? 1}`).join('|');
    let state = this.rooms.get(roomId);
    if (!state) { state = {flows: new Map(), weightSignature: signature, servedAt: 0}; this.rooms.set(roomId, state); }
    if (state.weightSignature !== signature) {
      // A changed eligible set or weight starts with clean credit; wait counts
      // of continuing flows are retained so a join cannot reset a pending bypass.
      for (const flow of [...state.flows.keys()]) if (!flows.has(flow)) state.flows.delete(flow);
      for (const flow of flows.keys()) {
        const existing = state.flows.get(flow);
        if (existing) existing.credit = 0;
        else state.flows.set(flow, {credit: 0, wait: 0, weight: weights.get(flow.split('/')[1]) ?? 1});
      }
      state.weightSignature = signature;
    }
    for (const flow of flows.keys()) {
      const entry = state.flows.get(flow);
      if (!entry) state.flows.set(flow, {credit: 0, wait: 0, weight: weights.get(flow.split('/')[1]) ?? 1});
      else entry.weight = weights.get(flow.split('/')[1]) ?? 1;
    }
    return state;
  }
}
