import type {AgentOutput} from '../../../../packages/protocol/src/index.ts';
import {runAdapter, type AdapterContext} from '../adapters.ts';

/**
 * F01 agent transport port. One open execution yields the existing adapter
 * output stream. Optional service-oriented operations are capability-gated by
 * each implementation; local adapters simply leave them unsupported.
 */
export interface AgentExecution {
  outputs: AsyncIterable<AgentOutput>;
  close?(): void;
}

export interface AgentTransport {
  openExecution(context: AdapterContext): AgentExecution;
  /** Deliver input to a live service execution when the provider supports it. */
  provideInput?(executionId: string, text: string): boolean;
  /** Ask the provider to cancel its own execution tree/task. */
  cancel?(executionId: string, reason?: unknown): void;
  /** Query a previously submitted execution after a disconnect or timeout. */
  queryOutcome?(executionId: string): Promise<unknown>;
}

/** Production adapter transport: the existing local/API/A2A/native adapters. */
export class LocalAdapterTransport implements AgentTransport {
  constructor(private readonly adapter: typeof runAdapter = runAdapter) {}
  openExecution(context: AdapterContext): AgentExecution {
    return {outputs: this.adapter(context)};
  }
}

export const localAgentTransport = new LocalAdapterTransport();
