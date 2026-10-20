import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { ProjectManifestEntry } from '../../../packages/protocol/src/index.ts';

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
  const root = canonicalProjectPath(sourcePath), files: ProjectManifestEntry[] = [];
  let bytes = 0;
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      if (excludedDirectories.has(name)) continue;
      const absolute = join(directory, name), stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`项目基线包含符号链接/重解析点：${relative(root, absolute)}`);
      if (stat.isDirectory()) { visit(absolute); continue; }
      if (!stat.isFile()) continue;
      if (stat.size > maxFileBytes) throw new Error(`项目基线单文件超过 ${maxFileBytes} 字节：${relative(root, absolute)}`);
      const contents = readFileSync(absolute);
      files.push({path: relative(root, absolute).replaceAll('\\', '/'), size: contents.byteLength, sha256: createHash('sha256').update(contents).digest('hex')});
      bytes += contents.byteLength;
    }
  };
  visit(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifestHash = createHash('sha256').update(files.map(file => `${file.path}\0${file.size}\0${file.sha256}`).join('\n')).digest('hex');
  return {manifestHash, fileCount: files.length, bytes, files};
}

export function projectBaseCommit(sourcePath: string): string | undefined {
  const result = spawnSync('git', ['-C', sourcePath, 'rev-parse', 'HEAD'], {encoding: 'utf8', windowsHide: true, timeout: 15000});
  return result.status === 0 ? String(result.stdout ?? '').trim() || undefined : undefined;
}
