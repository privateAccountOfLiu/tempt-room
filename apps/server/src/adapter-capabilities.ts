import { createHash } from 'node:crypto';
import type { AgentDescriptor } from '../../../packages/protocol/src/index.ts';

/** Stable names for adapters capabilities. These are probe subjects, not
 * provider promises: a capability only has meaning with matching evidence. */
export const capabilityNames = [
  'streamOutput',
  'nextTurnInput',
  'toolBoundaryInput',
  'steerDuringRun',
  'cancelOwnedTree',
  'cancelRemoteTask',
  'resumeSession',
  'queryOutcome',
  'usageScope',
  'preToolGate'
] as const;
export type CapabilityName = typeof capabilityNames[number];
export type CapabilityState = 'verified_supported' | 'verified_unsupported' | 'unverified';

export interface AdapterFingerprintInput {
  provider: string;
  adapterVersion: string;
  executableVersion?: string;
  runtimeLayout?: string;
  connectionMode: 'managed' | 'external' | 'attach';
  executionMode: 'sandbox' | 'host';
  model?: string;
  /** Hash/digest of behavior-affecting config; never secret values. */
  configDigest?: string;
}
export interface CapabilityEvidence {
  fingerprint: string;
  capability: CapabilityName;
  state: CapabilityState;
  mode: string;
  testedAt: string;
  suiteVersion: string;
  evidenceHash: string;
  reason?: string;
}
export interface ProbeContract {
  supported?: readonly CapabilityName[];
  unsupported?: readonly CapabilityName[];
  mode?: Partial<Record<CapabilityName, string>>;
  reasons?: Partial<Record<CapabilityName, string>>;
}
export interface ProbeOptions {
  suiteVersion?: string;
  testedAt?: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value as Record<string, unknown>).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
export function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }

/** Bind evidence to the actual adapter implementation, executable, execution
 * mode and behavior-affecting config. Any change yields a new fingerprint. */
export function adapterFingerprint(input: AdapterFingerprintInput): string {
  return digest({
    schema: 'tempt-room-adapter-fingerprint/v1',
    provider: input.provider,
    adapterVersion: input.adapterVersion,
    executableVersion: input.executableVersion ?? null,
    runtimeLayout: input.runtimeLayout ?? null,
    connectionMode: input.connectionMode,
    executionMode: input.executionMode,
    model: input.model ?? null,
    configDigest: input.configDigest ?? null
  });
}

/** Deterministic contract probe. It only reports what the contract explicitly
 * declares; all other capabilities stay unverified, never "supported". */
export function probeSimulatedCapabilities(contract: ProbeContract, fingerprint: string, options: ProbeOptions = {}): CapabilityEvidence[] {
  const suiteVersion = options.suiteVersion ?? 'capabilities-sim-v1';
  const testedAt = options.testedAt ?? new Date().toISOString();
  const supported = new Set(contract.supported ?? []), unsupported = new Set(contract.unsupported ?? []);
  for (const name of [...supported, ...unsupported]) if (!capabilityNames.includes(name)) throw new Error(`Unknown capability: ${name}`);
  for (const name of supported) if (unsupported.has(name)) throw new Error(`Capability is both supported and unsupported: ${name}`);
  return capabilityNames.map(capability => {
    const state: CapabilityState = supported.has(capability) ? 'verified_supported' : unsupported.has(capability) ? 'verified_unsupported' : 'unverified';
    const mode = state === 'unverified' ? 'not_run' : contract.mode?.[capability] ?? 'simulated-contract';
    const evidenceHash = digest({fingerprint, capability, state, mode, suiteVersion});
    return {fingerprint, capability, state, mode, testedAt, suiteVersion, evidenceHash, ...(state === 'unverified' && contract.reasons?.[capability] ? {reason: contract.reasons[capability]} : {})};
  });
}

/** Route only evidence produced for this exact fingerprint. Stale evidence is
 * unverified rather than silently promoted to supported/unsupported. */
export function verifiedCapabilityState(fingerprint: string, evidence: readonly CapabilityEvidence[], capability: CapabilityName): CapabilityState {
  const match = evidence.find(item => item.capability === capability && item.fingerprint === fingerprint);
  return match?.state ?? 'unverified';
}

export function capabilitySummary(evidence: readonly CapabilityEvidence[]): Record<CapabilityState, number> {
  const summary: Record<CapabilityState, number> = {verified_supported: 0, verified_unsupported: 0, unverified: 0};
  for (const item of evidence) summary[item.state]++;
  return summary;
}

/** Bind capability evidence to the configured adapter fingerprint. */
export function agentCapabilityFingerprint(agent: AgentDescriptor): string {
  return adapterFingerprint({
    provider: agent.provider,
    adapterVersion: 'tempt-room-0.1-adapter',
    executableVersion: agent.version || undefined,
    runtimeLayout: agent.executionMode === 'host' ? 'host' : agent.runtimeDirectory ? 'runtime-directory' : 'managed',
    connectionMode: agent.connectionMode,
    executionMode: agent.executionMode,
    model: agent.model || undefined,
    configDigest: digest({responseFormat: agent.responseFormat ?? 'text', credentialConfigured: Boolean(agent.credentialEnv)})
  });
}

/** Only deterministic demo behavior is a verified contract here. Real CLI
 * adapters stay unverified until an explicit authorized probe run. */
export function agentInterceptionGaps(agent: AgentDescriptor): {capability: CapabilityName; reason: string; interceptable: boolean}[] {
  if (agent.provider === 'demo') return [];
  if (['codex', 'claude', 'deepseek'].includes(agent.provider)) return [
    {capability: 'preToolGate', reason: '本地 CLI 以 bypass 权限运行，工具调用发生在 CLI 进程内，房间无法拦截', interceptable: false},
    {capability: 'steerDuringRun', reason: agent.connectionMode === 'attach' ? 'attach 只桥接消息，不提供运行中 steer' : 'oneshot CLI 运行期间没有 steer 通道', interceptable: false},
    {capability: 'toolBoundaryInput', reason: 'CLI 工具调用不经过房间 tool 通道', interceptable: false}
  ];
  return [{capability: 'preToolGate', reason: '远程/API Agent 的工具调用在远端执行，房间只能审计协议边界', interceptable: false}];
}

export function probeConfiguredAgent(agent: AgentDescriptor, testedAt = new Date().toISOString()): {fingerprint: string; evidence: CapabilityEvidence[]} {
  const fingerprint = agentCapabilityFingerprint(agent);
  const supported = agent.provider === 'demo' ? ['streamOutput', 'nextTurnInput'] as CapabilityName[] : [];
  const unsupported = agent.provider === 'demo' ? [] as CapabilityName[] : [];
  const reasons: Partial<Record<CapabilityName, string>> = agent.provider === 'demo' ? {} : {preToolGate: 'adapter 未声明可拦截的权限通道', steerDuringRun: 'adapter 未声明运行中 steer 通道', toolBoundaryInput: 'adapter 未声明工具边界输入通道'};
  return {fingerprint, evidence: probeSimulatedCapabilities({supported, unsupported, reasons}, fingerprint, {suiteVersion: 'capabilities-sim-v1', testedAt})};
}

export function capabilityEvidenceId(fingerprint: string, capability: CapabilityName): string {
  return 'cap_' + digest([fingerprint, capability]).slice(0, 64);
}
