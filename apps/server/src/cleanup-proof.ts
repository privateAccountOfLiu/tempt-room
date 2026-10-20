import type { CleanupProof } from '../../../packages/protocol/src/index.ts';

/** A proof only authorizes release when it asserts a known-empty process tree. */
export function cleanupProofComplete(proof?: CleanupProof): boolean {
  return Boolean(proof) && proof!.remainingProcessesKnown !== false && proof!.remainingProcesses === 0;
}

export function incompleteCleanupProof(checkedAt: string, evidence: string, exitCode?: number): CleanupProof {
  return {checkedAt, remainingProcesses: 0, remainingProcessesKnown: false, evidence, ...(exitCode === undefined ? {} : {exitCode})};
}
