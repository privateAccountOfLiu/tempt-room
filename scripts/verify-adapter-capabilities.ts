// Deterministic adapter capability contract probe. It never starts a model or a
// real CLI; B05a only establishes fingerprinting, three-state evidence and a
// machine-readable probe report. Real-CLI evidence stays not_run until an
// explicit authorized run.
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { adapterFingerprint, capabilitySummary, probeSimulatedCapabilities, type AdapterFingerprintInput } from '../apps/server/src/adapter-capabilities.ts';

const project = resolve('.');
const suiteVersion = 'capabilities-sim-v1';
const generatedAt = new Date().toISOString();
const configurations: Array<{id: string; input: AdapterFingerprintInput; supported: string[]; unsupported: string[]}> = [
  {
    id: 'demo-sandbox',
    input: {provider: 'demo', adapterVersion: 'sim-v1', executableVersion: 'in-process', runtimeLayout: 'in-process', connectionMode: 'managed', executionMode: 'sandbox', model: 'deterministic', configDigest: 'demo'},
    supported: ['streamOutput', 'nextTurnInput', 'cancelOwnedTree', 'usageScope'],
    unsupported: ['steerDuringRun', 'resumeSession', 'preToolGate', 'cancelRemoteTask', 'queryOutcome', 'toolBoundaryInput']
  },
  {
    id: 'demo-host-contract',
    input: {provider: 'demo', adapterVersion: 'sim-v1', executableVersion: 'in-process', runtimeLayout: 'in-process', connectionMode: 'managed', executionMode: 'host', model: 'deterministic', configDigest: 'demo'},
    supported: ['streamOutput', 'nextTurnInput'],
    unsupported: ['preToolGate', 'steerDuringRun']
  }
];
const probes = configurations.map(configuration => {
  const fingerprint = adapterFingerprint(configuration.input);
  const evidence = probeSimulatedCapabilities({supported: configuration.supported as never[], unsupported: configuration.unsupported as never[]}, fingerprint, {suiteVersion, testedAt: generatedAt});
  return {id: configuration.id, input: configuration.input, fingerprint, summary: capabilitySummary(evidence), evidence};
});
const report = {
  schemaVersion: 1,
  generatedAt,
  suiteVersion,
  modelRequests: 0,
  source: {cwd: project},
  probes,
  realCli: {state: 'not_run', reason: 'B05a probe format only; no authorized real CLI/model execution'},
  totals: probes.reduce((totals, probe) => ({
    supported: totals.supported + probe.summary.verified_supported,
    unsupported: totals.unsupported + probe.summary.verified_unsupported,
    unverified: totals.unverified + probe.summary.unverified
  }), {supported: 0, unsupported: 0, unverified: 0})
};
const output = join(project, '.state', 'capability-probes', `run-${generatedAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
mkdirSync(output, {recursive: true});
const reportPath = join(output, 'report.json');
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(`capability probe: PASS (${probes.length} simulated contracts)`);
for (const probe of probes) console.log(`${probe.id}: ${probe.summary.verified_supported} supported / ${probe.summary.verified_unsupported} unsupported / ${probe.summary.unverified} unverified`);
console.log(`real CLI: not_run`);
console.log(`report: ${reportPath}`);
