import { createHash } from 'node:crypto';
import type { Decision, Run, RunContext, Task } from '../../../packages/protocol/src/index.ts';

export type ContextSegmentKind = 'objective' | 'constraints' | 'related' | 'subscription' | 'history';
export interface ContextSegment {
  kind: ContextSegmentKind;
  text: string;
  bytes: number;
  hash: string;
  fromSeq: number;
  throughSeq: number;
  truncated: boolean;
  omitted: number;
}
export interface ContextSegmentOptions {
  totalBudgetBytes?: number;
  objectiveBudgetBytes?: number;
  constraintsBudgetBytes?: number;
  relatedBudgetBytes?: number;
  historyBudgetBytes?: number;
  subscriptionBudgetBytes?: number;
  incrementalText?: string;
}

export const defaultContextSegmentOptions: Required<Omit<ContextSegmentOptions, 'incrementalText'>> = {
  totalBudgetBytes: 64 * 1024,
  objectiveBudgetBytes: 16 * 1024,
  constraintsBudgetBytes: 20 * 1024,
  relatedBudgetBytes: 8 * 1024,
  historyBudgetBytes: 20 * 1024,
  subscriptionBudgetBytes: 8 * 1024
};

/** Build deterministic prompt segments. Objective and accepted constraints are
 * never displaced by recent chat, and oversized facts fail rather than being
 * silently marked as consumed. */
export function buildContextSegments(run: Run, context: RunContext, task?: Task, options: ContextSegmentOptions = {}): ContextSegment[] {
  const config = {...defaultContextSegmentOptions, ...options};
  const objective = byteLength(run.prompt);
  if (objective > config.objectiveBudgetBytes) throw new ContextSegmentTooLarge('objective', objective, config.objectiveBudgetBytes);
  const constraints = context.decisions.map(decisionText).join('\n');
  if (byteLength(constraints) > config.constraintsBudgetBytes) throw new ContextSegmentTooLarge('constraints', byteLength(constraints), config.constraintsBudgetBytes);
  const related = relatedText(run, task);
  if (byteLength(related) > config.relatedBudgetBytes) throw new ContextSegmentTooLarge('related', byteLength(related), config.relatedBudgetBytes);
  const incremental = options.incrementalText ?? '';
  if (byteLength(incremental) > config.subscriptionBudgetBytes) throw new ContextSegmentTooLarge('subscription', byteLength(incremental), config.subscriptionBudgetBytes);
  const fixedBytes = objective + byteLength(constraints) + byteLength(related) + byteLength(incremental);
  const totalBudget = Math.max(0, config.totalBudgetBytes - fixedBytes);
  const historyBudget = Math.min(config.historyBudgetBytes, totalBudget);
  const selected: string[] = [];
  let used = 0, omitted = 0;
  for (const message of [...context.messages].reverse()) {
    const line = `${message.actor.id}：${message.text}`;
    const bytes = byteLength(line) + 1;
    if (used + bytes > historyBudget) { omitted++; continue; }
    selected.unshift(line); used += bytes;
  }
  return [
    segment('objective', run.prompt, run.basedOnSeq, run.basedOnSeq, false, 0),
    segment('constraints', constraints, context.fromSeq, context.throughSeq, false, 0),
    segment('related', related, context.fromSeq, context.throughSeq, false, 0),
    ...(incremental ? [segment('subscription', incremental, context.fromSeq, context.throughSeq, false, 0)] : []),
    segment('history', selected.join('\n'), context.fromSeq, context.throughSeq, omitted > 0, omitted)
  ];
}

export class ContextSegmentTooLarge extends Error {
  readonly code = 'context_segment_too_large';
  constructor(readonly segment: ContextSegmentKind, readonly actualBytes: number, readonly budgetBytes: number) {
    super(`${segment} segment is ${actualBytes} bytes, budget is ${budgetBytes}`);
    this.name = 'ContextSegmentTooLarge';
  }
}

function decisionText(decision: Decision): string {
  return `[已接受决定] ${decision.text}`;
}

function relatedText(run: Run, task?: Task): string {
  const parts: string[] = [];
  if (task) parts.push(`task=${task.id} version=${task.version ?? '?'}`);
  if (run.taskId) parts.push(`run.taskId=${run.taskId} taskVersion=${run.taskVersion ?? '?'}`);
  if (run.sourceCommit) parts.push(`sourceCommit=${run.sourceCommit}`);
  if (run.dirtyBaselineHash) parts.push(`dirtyBaselineHash=${run.dirtyBaselineHash}`);
  if (run.projectBindingId) parts.push(`projectBinding=${run.projectBindingId} bindingVersion=${run.bindingVersion ?? '?'}`);
  if (task?.contract) {
    const binding=task.contract.projectBinding;
    parts.push(`objective=${task.contract.objective}`);
    parts.push(`acceptance=${task.contract.acceptance.map(check => check.description).join(' | ')}`);
    parts.push(`baselineRef=${binding.baselineRef} manifestHash=${binding.manifestHash}`);
    if (binding.allowedPaths.length) parts.push(`allowedPaths=${binding.allowedPaths.join(',')}`);
    parts.push('externalReadVersion=unknown');
  }
  return parts.join('\n');
}

function segment(kind: ContextSegmentKind, text: string, fromSeq: number, throughSeq: number, truncated: boolean, omitted: number): ContextSegment {
  return {kind, text, bytes: byteLength(text), hash: createHash('sha256').update(text).digest('hex'), fromSeq, throughSeq, truncated, omitted};
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
