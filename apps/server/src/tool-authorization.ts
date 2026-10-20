import { roomToolNames, type Actor } from '../../../packages/protocol/src/index.ts';
import { digest, type CapabilityEvidence, verifiedCapabilityState } from './adapter-capabilities.ts';

export type ToolAuthorizationDecision = 'allow' | 'deny';
export interface ToolAuthorizationResult {
  decision: ToolAuthorizationDecision;
  reason?: 'run_fence_missing' | 'capability_unverified' | 'path_traversal' | 'reserved_device_name' | 'alternate_data_stream' | 'unknown_tool';
  argumentDigest: string;
}

export interface AuthorizeToolInput {
  actor: Actor;
  runFence?: {runId: string; generation?: number; executionId?: string};
  fingerprint?: string;
  capabilityEvidence?: readonly CapabilityEvidence[];
  tool: string;
  args: unknown;
  resourceScope?: string;
  transport?: 'managed' | 'external';
}

const writeTools = new Set<string>(['room_post', 'task_propose', 'task_claim', 'task_context', 'task_complete', 'task_heartbeat', 'artifact_publish', 'room_input_ack']);
const knownTools = new Set<string>(roomToolNames);

/** Shared pre-tool policy for room tools. It only narrows existing permissions;
 * transport-level allowlists remain authoritative. */
export function authorizeTool(input: AuthorizeToolInput): ToolAuthorizationResult {
  const argumentDigest = digest({tool: input.tool, args: input.args});
  if (!knownTools.has(input.tool)) return {decision: 'deny', reason: 'unknown_tool', argumentDigest};
  const unsafe = unsafePathReason(input.args);
  if (unsafe) return {decision: 'deny', reason: unsafe, argumentDigest};
  if (input.actor.kind === 'agent') {
    if (input.transport !== 'external' && (!input.runFence?.runId || !input.runFence.generation || !input.runFence.executionId)) return {decision: 'deny', reason: 'run_fence_missing', argumentDigest};
    if (writeTools.has(input.tool)) {
      const state = verifiedCapabilityState(input.fingerprint ?? '', input.capabilityEvidence ?? [], 'preToolGate');
      if (state !== 'verified_supported') return {decision: 'deny', reason: 'capability_unverified', argumentDigest};
    }
  }
  return {decision: 'allow', argumentDigest};
}

function unsafePathReason(value: unknown): ToolAuthorizationResult['reason'] | undefined {
  if (typeof value === 'string') return checkPathLikeString(value);
  if (Array.isArray(value)) { for (const item of value) { const reason = unsafePathReason(item); if (reason) return reason; } return undefined; }
  if (value && typeof value === 'object') { for (const item of Object.values(value as Record<string, unknown>)) { const reason = unsafePathReason(item); if (reason) return reason; } }
  return undefined;
}

function checkPathLikeString(value: string): ToolAuthorizationResult['reason'] | undefined {
  if (!/[\\/:]/.test(value)) return undefined;
  const normalized = value.replaceAll('\\', '/');
  if (normalized.split('/').some(segment => segment === '..')) return 'path_traversal';
  const withoutDrive = normalized.replace(/^[a-zA-Z]:/, '');
  if (withoutDrive.includes(':')) return 'alternate_data_stream';
  for (const segment of normalized.split('/')) {
    const base = segment.split('.')[0]?.toUpperCase();
    if (['CON', 'PRN', 'AUX', 'NUL'].includes(base) || /^(COM|LPT)[1-9]$/.test(base)) return 'reserved_device_name';
  }
  return undefined;
}
