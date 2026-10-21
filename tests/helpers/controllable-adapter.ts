import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentOutput } from '../../packages/protocol/src/index.ts';
import type { AdapterContext } from '../../apps/server/src/adapters.ts';

export interface ProbeEntry {
  runId: string;
  agentId: string;
  taskId?: string;
  workspace: string;
  prompt: string;
  baselineHash?: string;
  outputFiles: string[];
  enteredAtNs: string;
}

export interface AdapterProbe {
  /** Promise resolved when the Worker actually enters this adapter. */
  entered(runId: string): Promise<ProbeEntry>;
  /** Wait until `count` adapters have been entered, with a hard timeout. */
  waitForEntered(count: number, timeoutMs?: number): Promise<ProbeEntry[]>;
  /** Let one run finish and produce its work. */
  release(runId: string): void;
  /** Fail one run with a concrete error. */
  fail(runId: string, error: Error): void;
  /** Release every currently entered run. */
  releaseAll(): void;
  entries(): ProbeEntry[];
  timeline(): Array<{ runId: string; agentId: string; phase: string; atNs: string }>;
  reset(): void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/**
 * Deterministic adapter used by parallel-dispatch tests.
 *
 * It is entered by the real Worker, records the actual workspace and frozen
 * baseline, then blocks until the test releases it. No sleep is used to guess
 * whether a Worker started: `waitForEntered` resolves from the adapter itself.
 */
export function createControllableAdapter(options: { outputs?: (context: AdapterContext) => string[] } = {}) {
  const waiters = new Map<string, Deferred<ProbeEntry>>();
  const gates = new Map<string, Deferred<void>>();
  const records = new Map<string, ProbeEntry>();
  const events: Array<{ runId: string; agentId: string; phase: string; atNs: string }> = [];
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const stamp = () => `${process.hrtime.bigint()}ns`;

  const adapter = (context: AdapterContext): AsyncIterable<AgentOutput> => {
    const outputFiles = options.outputs?.(context) ?? [`${context.agent.id}.txt`];
    const entry: ProbeEntry = {
      runId: context.run.id,
      agentId: context.agent.id,
      ...(context.run.taskId ? { taskId: context.run.taskId } : {}),
      workspace: context.workspace,
      prompt: context.prompt,
      ...(context.run.dirtyBaselineHash ? { baselineHash: context.run.dirtyBaselineHash } : {}),
      outputFiles,
      enteredAtNs: stamp()
    };
    events.push({ runId: entry.runId, agentId: entry.agentId, phase: 'entered', atNs: entry.enteredAtNs });
    records.set(entry.runId, entry);
    waiters.get(entry.runId)?.resolve(entry);
    const gate = deferred<void>();
    gates.set(entry.runId, gate);
    notify();
    return (async function* () {
      await gate.promise;
      for (const file of outputFiles) {
        const target = join(context.workspace, file);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, `completed ${file}\n`);
      }
      events.push({ runId: entry.runId, agentId: entry.agentId, phase: 'released', atNs: stamp() });
      yield { type: 'text', text: `${entry.agentId} completed ${outputFiles.join(', ')}` } as AgentOutput;
    })();
  };

  const probe: AdapterProbe = {
    entered(runId) {
      const existing = records.get(runId);
      if (existing) return Promise.resolve(existing);
      let waiter = waiters.get(runId);
      if (!waiter) { waiter = deferred<ProbeEntry>(); waiters.set(runId, waiter); }
      return waiter.promise;
    },
    waitForEntered(count, timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`adapter entries ${records.size}/${count} within ${timeoutMs}ms`)); }, timeoutMs);
        timer.unref?.();
        const check = () => {
          if (records.size < count) return;
          clearTimeout(timer);
          listeners.delete(check);
          resolve([...records.values()]);
        };
        listeners.add(check);
        check();
      });
    },
    release(runId) {
      const gate = gates.get(runId);
      if (!gate) throw new Error(`adapter ${runId} has not been entered`);
      gate.resolve(undefined);
    },
    fail(runId, error) {
      const gate = gates.get(runId);
      if (!gate) throw new Error(`adapter ${runId} has not been entered`);
      gate.reject(error);
    },
    releaseAll() { for (const runId of gates.keys()) gates.get(runId)!.resolve(undefined); },
    entries() { return [...records.values()]; },
    timeline() { return [...events]; },
    reset() { records.clear(); gates.clear(); waiters.clear(); events.length = 0; }
  };
  return { adapter, probe };
}
