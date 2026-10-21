import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ProtocolError, type Artifact, type Integration, type Run, type Task } from '../../../packages/protocol/src/index.ts';
import { digest, now, SYSTEM } from './store.ts';
import type { EventStore } from './ports/event-store.ts';
import { acquireResource, canonicalProjectKey, quarantineResource, releaseResource } from './resource-manager.ts';
import { killProcessTreeWithProof, type ProcessTreeProof } from './host.ts';
import { assertTargetUnchanged, artifactSetHash, prepareIntegrationStaging, stagingRootFor, targetManifestHash, verifierManifestHash } from './integration-staging.ts';

/**
 * Integration queue runner.
 *
 * Integrations are admitted per canonical project: one validation, apply or
 * rollback operation per project at a time, across rooms and bindings. A busy
 * project never blocks another project, and verification runs outside the
 * worker tick so the event loop keeps serving HTTP, WebSocket and adapters.
 */
export interface IntegrationHost {
  store: EventStore;
  root: string;
  apply(artifactId: string, hashes?: { targetBeforeHash?: string; targetAfterHash?: string }): { journalId: string; changedFiles: number };
  /** Canonical project directory of an integration, if it targets one. */
  projectSource(integration: Integration): string | undefined;
}

interface InFlight {
  integrationId: string;
  projectKey?: string;
  leaseId?: string;
  controller: AbortController;
  staging?: string;
  cleanupProof?: ProcessTreeProof;
  startedAt: string;
}

const allowedVerificationExecutables = new Set(['node', 'npm', 'npx', 'git', 'python', 'python3', 'dotnet']);
const verificationTimeoutMs = 120000;
const verificationOutputLimit = 1024 * 1024;
const activeIntegrationStatuses: Integration['status'][] = ['validating', 'staging', 'testing', 'applying'];

export class IntegrationRunner {
  private readonly inFlight = new Map<string, InFlight>();
  private closed = false;

  constructor(private host: IntegrationHost, private options: { maxConcurrentVerifications?: number } = {}) {}

  /** Staging directories that must not be removed by the retention sweeper. */
  protectedStaging(): Set<string> {
    return new Set([...this.inFlight.values()].map(item => item.staging).filter((value): value is string => Boolean(value)));
  }

  inFlightIds(): string[] {
    return [...this.inFlight.keys()];
  }

  /**
   * Start whatever can be started right now.
   *
   * The tick never waits for a verification: it only takes the project lease
   * and hands the work to the background runner.
   */
  tick(): void {
    if (this.closed) return;
    const integrations = this.host.store.list<Integration>('integrations')
      .filter(item => item.status === 'queued' || (item.status === 'ready_to_apply' && item.authorization === 'authorized'))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const maxVerifications = this.options.maxConcurrentVerifications ?? 2;
    let running = [...this.inFlight.values()].filter(item => item.staging).length;
    for (const integration of integrations) {
      if (this.inFlight.has(integration.id)) continue;
      if (running >= maxVerifications) break;
      const source = this.host.projectSource(integration);
      const projectKey = source ? canonicalProjectKey(source) : undefined;
      let leaseId: string | undefined;
      if (projectKey) {
        try {
          const lease = acquireResource(this.host.store, {
            roomId: integration.roomId,
            kind: 'project',
            key: projectKey,
            run: { id: `integration_${integration.id}`, generation: 1, executionId: `integration_${integration.id}` },
            capacity: 1
          });
          leaseId = lease.id;
        } catch {
          // Another room or binding holds this project. Skip it and let the
          // other projects continue.
          continue;
        }
      }
      const controller = new AbortController();
      this.inFlight.set(integration.id, { integrationId: integration.id, projectKey, leaseId, controller, startedAt: now() });
      running += 1;
      void this.process(integration, { projectKey, leaseId, controller }).catch(() => {
        /* The runner records the failure state; the tick stays unaffected. */
      });
    }
  }

  /**
   * Record a transition only if the integration is still in the expected
   * phase. This is the short re-check before any durable result write.
   */
  private update(original: Integration, expectedStatus: Integration['status'], status: Integration['status'], extra: Partial<Integration> = {}): Integration {
    const current = this.host.store.get<Integration>('integrations', original.id);
    if (!current) return original;
    if (current.status !== expectedStatus) return current;
    const next: Integration = { ...current, ...extra, status, updatedAt: now() };
    this.host.store.atomic(() => { this.host.store.event(current.roomId, 'integration.updated', SYSTEM, { integration: next }); });
    return next;
  }

  private async process(original: Integration, context: { projectKey?: string; leaseId?: string; controller: AbortController }): Promise<void> {
    let integration = original;
    const controller = context.controller;
    try {
      if (integration.status === 'queued') {
        integration = this.update(integration, 'queued', 'validating');
        if ((integration as unknown as {status?: string}).status !== 'validating') return;
        const artifact = this.host.store.get<Artifact>('artifacts', integration.artifactId);
        const task = artifact?.taskId ? this.host.store.get<Task>('tasks', artifact.taskId) : undefined;
        const run = integration.runId ? this.host.store.get<Run>('runs', integration.runId) : undefined;
        if (!artifact || !task) throw new ProtocolError('artifact_binding_invalid', '交付物缺少一致的来源任务', 409);
        if (run && run.taskVersion !== undefined && task.version !== run.taskVersion) throw new ProtocolError('stale_artifact', '任务版本已变化，候选交付物不能继续集成', 409);
        const changes = JSON.parse(readFileSync(join(this.host.root, 'artifacts', `${integration.artifactId}.changes.json`), 'utf8'));
        const artifactHash = digest(changes);
        if (integration.artifactHash && integration.artifactHash !== artifactHash) throw new ProtocolError('stale_artifact', '集成候选文件在验证前已被修改', 409);
        const source = this.host.projectSource(integration);
        if (!source) throw new ProtocolError('invalid_project', '集成缺少项目源目录', 409);
        const checks = task.contract?.acceptance ?? [];
        const verifierHash = verifierManifestHash(checks);
        const previousTarget = this.previousAppliedTarget(integration, source);
        const expectedTarget = previousTarget ?? integration.baseManifestHash;
        const currentTargetHash = targetManifestHash(source);
        if (expectedTarget !== undefined && currentTargetHash !== expectedTarget) throw new ProtocolError('source_changed', '当前项目目标与可认可基线不一致，不能复用旧集成结论', 409);
        const allowedPaths = task.allowedPaths ?? task.contract?.projectBinding.allowedPaths ?? [];
        const staging = stagingRootFor(this.host.root, integration.id);
        const entry = this.inFlight.get(integration.id);
        if (entry) entry.staging = staging;
        const staged = prepareIntegrationStaging({ source, staging, changes: changes.changes ?? [], allowedPaths, requireAllowedPaths: Boolean(task.contract) });
        const artifactSet = artifactSetHash(this.appliedArtifactIds(integration, source), artifact.id);
        const integrity = {
          artifactHash,
          verifiedTargetManifestHash: staged.verifiedTargetManifestHash,
          stagedManifestHash: staged.stagedManifestHash,
          appliedArtifactSetHash: artifactSet,
          verifierManifestHash: verifierHash
        };
        if (checks.length) {
          integration = this.update(integration, 'validating', 'testing', integrity);
          const verification = await this.runChecks(checks, staging, controller.signal);
          if (entry) entry.cleanupProof = verification.cleanupProof;
          if (verification.rejected) {
            this.update(integration, 'testing', 'verification_failed', { ...integrity, verificationId: `verification_${integration.id}`, errorCode: verification.rejected });
            return;
          }
          if (verification.exitCode !== 0) {
            this.update(integration, 'testing', 'verification_failed', {
              ...integrity,
              verificationId: `verification_${integration.id}`,
              verificationExitCode: verification.exitCode,
              verificationOutputHash: digest(verification.output),
              errorCode: `verification_exit_${verification.exitCode}`
            });
            return;
          }
          integration = this.update(integration, 'testing', 'testing', {
            ...integrity,
            verificationId: `verification_${integration.id}`,
            verificationExitCode: 0,
            verificationOutputHash: digest(verification.output),
            verificationEnvironment: verification.environment
          });
          integration = this.update(integration, 'testing', 'ready_to_apply', {
            ...integrity,
            verificationId: `verification_${integration.id}`,
            verificationExitCode: 0,
            verificationOutputHash: digest(verification.output),
            ...(verification.environment ? { verificationEnvironment: verification.environment } : {})
          });
        } else {
          if (entry) entry.cleanupProof = {checkedAt: now(), remainingProcesses: 0, trackedProcesses: 0, evidence: 'taskkill-tree-scan' };
          integration = this.update(integration, 'validating', 'ready_to_apply', integrity);
        }
        if (integration.authorization === 'waiting') return;
      }

      // Re-read the durable state before applying. A concurrent authorization,
      // room deletion or integration recovery must not be overwritten by a
      // stale in-memory copy.
      const ready = this.host.store.get<Integration>('integrations', integration.id);
      if (!ready || ready.status !== 'ready_to_apply' || ready.authorization === 'waiting') return;
      const artifact = this.host.store.get<Artifact>('artifacts', ready.artifactId);
      if (!artifact || !this.host.store.room(ready.roomId)) throw new ProtocolError('integration_state_changed', '集成期间对象已失效', 409);
      if (!ready.verifiedTargetManifestHash || !ready.stagedManifestHash) throw new ProtocolError('recovery_required', '集成缺少目标摘要，需重新验证', 409);
      const frozenTask = artifact.taskId ? this.host.store.get<Task>('tasks', artifact.taskId) : undefined;
      if (frozenTask) {
        if (ready.taskVersion !== undefined && frozenTask.version !== ready.taskVersion) throw new ProtocolError('stale_artifact', '任务版本在验证后发生变化', 409);
        const currentVerifier = verifierManifestHash(frozenTask.contract?.acceptance ?? []);
        if (ready.verifierManifestHash && currentVerifier !== ready.verifierManifestHash) throw new ProtocolError('stale_artifact', '验证器在验证后发生变化', 409);
      }
      const currentChanges = JSON.parse(readFileSync(join(this.host.root, 'artifacts', `${ready.artifactId}.changes.json`), 'utf8'));
      if (ready.artifactHash && digest(currentChanges) !== ready.artifactHash) throw new ProtocolError('stale_artifact', '验证后候选文件已被修改', 409);
      const source = this.host.projectSource(ready);
      if (!source) throw new ProtocolError('invalid_project', '集成缺少项目源目录', 409);
      assertTargetUnchanged(source, ready.verifiedTargetManifestHash);
      const applying = this.update(ready, 'ready_to_apply', 'applying');
      if ((applying as unknown as {status?: string}).status !== 'applying') return;
      const result = this.host.apply(ready.artifactId, { targetBeforeHash: ready.verifiedTargetManifestHash, targetAfterHash: ready.stagedManifestHash });
      const appliedArtifact = this.host.store.get<Artifact>('artifacts', ready.artifactId);
      if (!appliedArtifact?.applied) throw new ProtocolError('integration_state_changed', '应用后未记录 artifact.applied', 409);
      const afterHash = targetManifestHash(source);
      if (afterHash !== ready.stagedManifestHash) throw new ProtocolError('integration_state_changed', '应用后目标摘要与已验证 staging 不一致', 409);
      this.update(applying, 'applying', 'applied', { journalId: result.journalId, appliedTargetManifestHash: afterHash });
      try { rmSync(stagingRootFor(this.host.root, ready.id), { recursive: true, force: true }); } catch { /* Keep artifacts if cleanup is denied. */ }
    } catch (error) {
      const current = this.host.store.get<Integration>('integrations', integration.id);
      if (controller.signal.aborted) {
        if (current && activeIntegrationStatuses.includes(current.status)) this.update(current, current.status, 'unknown', { errorCode: 'integration_aborted' });
        return;
      }
      const code = (error as any)?.code as string | undefined;
      const status: Integration['status'] = code === 'already_applied' ? 'applied'
        : ['apply_conflict', 'source_changed', 'stale_generation', 'stale_artifact', 'stale_dependency', 'artifact_binding_invalid', 'run_not_completed'].includes(code ?? '') ? 'conflict'
          : code === 'recovery_required' ? 'blocked'
            : code === 'integration_state_changed' ? 'unknown'
              : 'unknown';
      if (current) this.update(current, current.status, status, { ...(code ? { errorCode: code } : {}) });
    } finally {
      const entry = this.inFlight.get(integration.id);
      if (entry?.leaseId) {
        const rawProof = entry.cleanupProof ?? (entry.staging ? undefined : { checkedAt: now(), remainingProcesses: 0, evidence: 'integration-no-verifier' });
        const proof = rawProof ? { checkedAt: rawProof.checkedAt, remainingProcesses: rawProof.remainingProcesses, evidence: rawProof.evidence } : undefined;
        try {
          if (proof && proof.remainingProcesses === 0) releaseResource(this.host.store, integration.roomId, entry.leaseId, proof);
          else quarantineResource(this.host.store, integration.roomId, entry.leaseId, proof ? `integration verifier cleanup incomplete (${proof.remainingProcesses})` : 'integration verifier cleanup proof missing');
        } catch {
          /* A lease that cannot be released with proof stays active/quarantined. */
        }
      }
      this.inFlight.delete(integration.id);
    }
  }

  /** Target hash recorded by the latest applied integration for this source. */
  private previousAppliedTarget(integration: Integration, source: string): string | undefined {
    const canonical = canonicalProjectKey(source);
    const candidates = this.host.store.list<Integration>('integrations')
      .filter(item => item.status === 'applied' && item.id !== integration.id && item.appliedTargetManifestHash)
      .map(item => ({ item, source: this.host.projectSource(item) }))
      .filter((value): value is { item: Integration; source: string } => Boolean(value.source && canonicalProjectKey(value.source) === canonical))
      .sort((left, right) => right.item.updatedAt.localeCompare(left.item.updatedAt));
    return candidates[0]?.item.appliedTargetManifestHash;
  }

  /** Artifacts already applied to this source, used for the artifact-set hash. */
  private appliedArtifactIds(integration: Integration, source: string): string[] {
    const canonical = canonicalProjectKey(source);
    return this.host.store.list<Integration>('integrations')
      .filter(item => item.status === 'applied' && item.id !== integration.id)
      .filter(item => { const other = this.host.projectSource(item); return Boolean(other && canonicalProjectKey(other) === canonical); })
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .map(item => item.artifactId);
  }
  /**
   * Run the frozen acceptance checks.
   *
   * Checks run one after another in the staging directory. Only allowlisted
   * executables are accepted; a shell command string stays on the legacy path
   * and is never built from untrusted parts.
   */
  private async runChecks(checks: any[], cwd: string, signal: AbortSignal): Promise<{ exitCode?: number; output: string; rejected?: string; environment?: Integration['verificationEnvironment']; cleanupProof?: ProcessTreeProof }> {
    let output = '';
    let cleanupProof: ProcessTreeProof | undefined;
    for (const check of checks) {
      if (signal.aborted) throw new ProtocolError('integration_aborted', '集成验收被取消', 409);
      let result: { exitCode?: number; output: string; cleanupProof?: ProcessTreeProof };
      if (check.argv?.length) {
        const executable = basename(check.argv[0]).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
        if (!allowedVerificationExecutables.has(executable)) return { rejected: 'verification_command_rejected', output, cleanupProof };
        result = await this.spawnCapture(check.argv[0], check.argv.slice(1), cwd, signal);
      } else {
        result = await this.spawnCapture(check.command, [], cwd, signal, true);
      }
      cleanupProof = result.cleanupProof ?? cleanupProof;
      output += result.output;
      if (result.exitCode !== 0) return { exitCode: result.exitCode, output, cleanupProof };
    }
    return { exitCode: 0, output, environment: this.environment(), cleanupProof };
  }

  private environment(): Integration['verificationEnvironment'] {
    const version = (command: string, args: string[]) => {
      try {
        const result = spawnSync(command, args, {encoding: 'utf8', windowsHide: true, timeout: 5000});
        return result.status === 0 ? String(result.stdout).trim() : undefined;
      } catch { return undefined; }
    };
    const npmCli = process.env.npm_execpath;
    const npm = npmCli ? version(process.execPath, [npmCli, '--version']) : version(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version']);
    const git = version('git', ['--version']);
    return {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      ...(npm ? {npm} : {}),
      ...(git ? {git} : {})
    };
  }

  /** Spawn one verification command and capture a bounded amount of output. */
  private spawnCapture(command: string, args: string[], cwd: string, signal: AbortSignal, useShell = false): Promise<{ exitCode?: number; output: string; cleanupProof?: ProcessTreeProof }> {
    return new Promise((resolvePromise) => {
      let child;
      try {
        child = spawn(command, args, { cwd, shell: useShell, windowsHide: true, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        resolvePromise({ exitCode: 1, output: String((error as Error).message) });
        return;
      }
      let output = '';
      let settled = false;
      let cleanupProof: ProcessTreeProof | undefined;
      const finish = (exitCode?: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (!cleanupProof) cleanupProof = killProcessTreeWithProof(child.pid);
        resolvePromise({ exitCode, output, cleanupProof });
      };
      const collect = (chunk: Buffer) => {
        if (output.length >= verificationOutputLimit) return;
        output += chunk.toString('utf8');
        if (output.length > verificationOutputLimit) output = output.slice(0, verificationOutputLimit);
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      const timer = setTimeout(() => {
        // The whole process tree is stopped and checked, not only the child.
        cleanupProof = killProcessTreeWithProof(child.pid);
        finish(124);
      }, verificationTimeoutMs);
      timer.unref();
      const onAbort = () => {
        cleanupProof = killProcessTreeWithProof(child.pid);
        finish(130);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      child.on('error', error => { output += String(error.message); finish(1); });
      child.on('close', code => finish(code ?? 0));
    });
  }

  /** Stop and await the verifiers this runner owns. */
  async close(): Promise<{ pending: string[] }> {
    this.closed = true;
    for (const entry of this.inFlight.values()) entry.controller.abort(new Error('服务关闭'));
    const deadline = Date.now() + 12000;
    while (this.inFlight.size && Date.now() < deadline) await new Promise(done => setTimeout(done, 50));
    return { pending: [...this.inFlight.keys()] };
  }
}
