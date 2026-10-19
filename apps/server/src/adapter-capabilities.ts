import { createHash } from 'node:crypto';

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
    return {fingerprint, capability, state, mode, testedAt, suiteVersion, evidenceHash};
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
