import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProjectManifestEntry } from '../../../packages/protocol/src/index.ts';
import { scanProjectFiles } from './project-files.ts';

const excludedDirectories = new Set(['.git', 'node_modules', 'dist', 'build', '.state', '.next', 'coverage', '.venv', '__pycache__', 'target', '.cache']);
const maxFileBytes = 8 * 1024 * 1024;

/** Resolve aliases and reject symlink/reparse-point roots before binding. */
export function canonicalProjectPath(input: string): string {
  const absolute = resolve(input);
  let stat;
  try { stat = lstatSync(absolute); } catch (error) { throw new Error(`项目目录不可访问：${(error as Error).message}`); }
  if (stat.isSymbolicLink()) throw new Error('项目绑定不允许符号链接/重解析点根目录');
  const canonical = realpathSync.native(absolute);
  if (!lstatSync(canonical).isDirectory()) throw new Error('项目绑定必须指向目录');
  return canonical;
}

export function buildProjectManifest(sourcePath: string): {manifestHash: string; fileCount: number; bytes: number; files: ProjectManifestEntry[]} {
  // One shared algorithm: binding and execution must describe the same bytes.
  const scan = scanProjectFiles(canonicalProjectPath(sourcePath));
  return { manifestHash: scan.manifestHash, fileCount: scan.fileCount, bytes: scan.bytes, files: scan.files.map(file => ({ path: file.path, size: file.size, sha256: file.sha256 })) };
}

export function projectBaseCommit(sourcePath: string): string | undefined {
  const result = spawnSync('git', ['-C', sourcePath, 'rev-parse', 'HEAD'], {encoding: 'utf8', windowsHide: true, timeout: 15000});
  return result.status === 0 ? String(result.stdout ?? '').trim() || undefined : undefined;
}
