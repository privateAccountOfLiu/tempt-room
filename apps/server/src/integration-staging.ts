import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ProtocolError } from '../../../packages/protocol/src/index.ts';
import { manifestHashOf, scanProjectFiles } from './project-files.ts';
import { safePath } from './workspaces.ts';

/**
 * Staging composition for integrations.
 *
 * An integration is never assembled from the candidate's own stale manifest.
 * The current, approved source target is scanned and copied first, then the
 * candidate changes are applied on top after their `before` hashes match.
 * This makes "A then B" mean the combination that will really be applied,
 * including files neither task touched.
 */
export interface StagedIntegration {
  verifiedTargetManifestHash: string;
  stagedManifestHash: string;
}

/** Hash of a workspace/run manifest (the run's frozen input snapshot). */
export function workspaceManifestHash(manifest: { files?: Record<string, { hash?: string; content?: string }> }): string {
  const files = Object.entries(manifest.files ?? {})
    .map(([path, file]) => ({
      path,
      size: file.content ? Buffer.from(file.content, 'base64').byteLength : 0,
      sha256: String(file.hash ?? '')
    }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return manifestHashOf(files);
}

/** Current target manifest hash for a source directory. */
export function targetManifestHash(source: string): string {
  return scanProjectFiles(source).manifestHash;
}

export function verifierManifestHash(checks: unknown): string {
  return createHash('sha256').update(JSON.stringify(checks)).digest('hex');
}

export function artifactSetHash(previous: string[], current: string): string {
  return createHash('sha256').update([...new Set([...previous, current])].sort().join('\n')).digest('hex');
}

const normalizedPath = (value: string) => value.replaceAll('\\', '/');

/**
 * Build the staging tree from the current approved target plus candidate
 * changes. Returns the target and staged manifest hashes. Any mismatch is
 * rejected before a verifier runs.
 */
export function prepareIntegrationStaging(input: {
  source: string;
  staging: string;
  changes: { path: string; before: string | null; after: string | null }[];
  allowedPaths?: string[];
  requireAllowedPaths?: boolean;
}): StagedIntegration {
  const target = scanProjectFiles(input.source);
  const allowed = new Set((input.allowedPaths ?? []).map(normalizedPath));
  for (const change of input.changes) {
    const path = normalizedPath(change.path);
    if (input.requireAllowedPaths && allowed.size > 0 && !allowed.has(path)) {
      throw new ProtocolError('artifact_binding_invalid', `候选补丁修改了 allowedPaths 之外的文件：${path}`, 409);
    }
    const current = target.contents.get(path);
    const currentHash = current ? createHash('sha256').update(current).digest('hex') : null;
    if (currentHash !== change.before) {
      throw new ProtocolError('apply_conflict', `候选补丁的 before 与当前目标不一致：${path}`, 409);
    }
  }

  rmSync(input.staging, { recursive: true, force: true });
  mkdirSync(input.staging, { recursive: true });
  for (const [path, content] of target.contents) {
    const destination = safePath(input.staging, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  for (const change of input.changes) {
    const destination = safePath(input.staging, change.path);
    if (change.after === null) { try { unlinkSync(destination); } catch { /* deleted or never present */ } continue; }
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, Buffer.from(change.after, 'base64'));
  }
  return { verifiedTargetManifestHash: target.manifestHash, stagedManifestHash: scanProjectFiles(input.staging).manifestHash };
}

/** Re-check that the mutable source still equals the verified target. */
export function assertTargetUnchanged(source: string, expectedHash: string): void {
  const current = scanProjectFiles(source).manifestHash;
  if (current !== expectedHash) throw new ProtocolError('source_changed', '验证后源目录发生变化，不能复用旧 PASS', 409);
}

/** Fingerprint of the frozen verifier declaration, persisted on the integration. */
export function freezeVerifier(checks: unknown): string {
  return verifierManifestHash(checks);
}

export function stagingRootFor(root: string, integrationId: string): string {
  return join(root, 'staging', integrationId);
}
