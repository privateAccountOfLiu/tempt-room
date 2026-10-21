import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProtocolError } from '../../../packages/protocol/src/index.ts';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export function artifactPath(stateRoot: string, artifactId: string): string {
  if (!/^artifact_[a-zA-Z0-9]+$/.test(artifactId)) throw new ProtocolError('invalid_artifact', '交付物编号非法', 400);
  return join(stateRoot, 'artifacts', artifactId);
}

export function artifactPreviewPath(stateRoot: string, artifactId: string): string {
  return `${artifactPath(stateRoot, artifactId)}.preview.png`;
}

/**
 * Install prepared original and preview bytes under the managed artifact
 * directory. Existing files are reused only when their hashes match; a
 * different file with the same artifactId is never overwritten.
 */
export function installArtifactFiles(stateRoot: string, artifactId: string, original: Buffer, preview: Buffer): {originalHash: string; previewHash: string; reused: boolean} {
  const directory = join(stateRoot, 'artifacts');
  mkdirSync(directory, {recursive: true});
  const originalTarget = artifactPath(stateRoot, artifactId);
  const previewTarget = artifactPreviewPath(stateRoot, artifactId);
  const originalHash = sha(original), previewHash = sha(preview);
  const install = (target: string, bytes: Buffer, hash: string): boolean => {
    if (existsSync(target)) {
      if (sha(readFileSync(target)) !== hash) throw new ProtocolError('artifact_conflict', '同一 artifactId 已存在不同内容', 409);
      return true;
    }
    const temp = `${target}.tmp-${createHash('sha256').update(`${Date.now()}\0${Math.random()}`).digest('hex').slice(0, 12)}`;
    try {
      writeFileSync(temp, bytes);
      renameSync(temp, target);
    } catch (error) {
      try { rmSync(temp, {force: true}); } catch { /* noop */ }
      throw new ProtocolError('artifact_install_failed', `交付物文件安装失败：${(error as Error).message}`, 500);
    }
    return false;
  };
  const originalExisted = install(originalTarget, original, originalHash);
  const previewExisted = install(previewTarget, preview, previewHash);
  return {originalHash, previewHash, reused: originalExisted && previewExisted};
}

/** Only remove files that are inside the caller-managed artifact directory. */
export function removeArtifactFiles(stateRoot: string, artifactId: string): void {
  const directory = join(stateRoot, 'artifacts');
  for (const target of [artifactPath(stateRoot, artifactId), artifactPreviewPath(stateRoot, artifactId)]) {
    if (!target.startsWith(directory + require('node:path').sep)) continue;
    try { rmSync(target, {force: true}); } catch { /* retention cleans later */ }
  }
}
