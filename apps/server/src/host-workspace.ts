import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from '../../../packages/protocol/src/index.ts';

/** New host chat runs get an isolated execution directory; the old room-shared
 * directory stays readable but is never reused as an implicit collaboration
 * workspace. */
export function prepareHostChatWorkspace(root: string, run: Run): string {
  const workspace = join(root, 'workspaces', 'host-chat', run.roomId, run.id);
  mkdirSync(workspace, {recursive: true});
  if (!existsSync(join(workspace, '.git'))) {
    try { spawnSync('git', ['init', '--quiet', '.'], {cwd: workspace, windowsHide: true, timeout: 15000, stdio: 'ignore'}); } catch { /* git is optional for an empty workspace */ }
  }
  return workspace;
}

function git(cwd: string, args: string[]) {
  return spawnSync('git', ['-C', cwd, ...args], {encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024});
}

function fileHash(projectPath: string, relative: string): string {
  try {
    const absolute = join(projectPath, relative);
    if (!lstatSync(absolute).isFile() && !lstatSync(absolute).isSymbolicLink()) return 'directory';
    return createHash('sha256').update(readFileSync(absolute)).digest('hex');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
  }
}

/**
 * Content-aware working-tree snapshot. The status code alone cannot detect a
 * file that was already M before the run and changed again, so each path also
 * carries a SHA256 of its current bytes. Never returns file contents.
 */
export function hostStatus(projectPath: string): Map<string, string> | undefined {
  const result = git(projectPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (result.status !== 0) return undefined;
  const tokens = String(result.stdout ?? '').split('\0'), status = new Map<string, string>();
  for (let index = 0; index < tokens.length; index++) {
    const entry = tokens[index];
    if (!entry) continue;
    const code = entry.slice(0, 2), path = entry.slice(3);
    if (!path) continue;
    if (code.includes('R') || code.includes('C')) {
      const original = tokens[++index];
      if (original) status.set(original, 'deleted:missing');
    }
    status.set(path, `${code}:${fileHash(projectPath, path)}`);
  }
  return status;
}

/**
 * Report observed changes, not attribution. Without proof of exclusive access
 * (thread lock + directory lock + no external process), the caller must not
 * claim this Agent alone produced a change.
 */
export function hostChangeReport(projectPath: string, baseline?: Map<string, string>): string {
  const current = hostStatus(projectPath);
  if (!current) return `本机直连模式已直接在真实目录中执行并可能修改文件；该目录不是 Git 仓库，无法生成内容清单。\n项目目录：${projectPath}`;
  const before = baseline ?? new Map<string, string>();
  const paths = [...new Set([...before.keys(), ...current.keys()])].sort();
  const changes = paths.filter(path => before.get(path) !== current.get(path)).map(path => ({
    path,
    before: before.get(path) ?? 'absent',
    after: current.get(path) ?? 'absent'
  }));
  if (!changes.length) return `本机直连模式执行完成；未观察到工作树内容变化。\n项目目录：${projectPath}`;
  return [
    '本机直连模式执行期间观察到以下工作树内容变化。未证明这些变化由该 Agent 独占产生，也未自动提交或撤销用户既有改动：',
    `项目目录：${projectPath}`,
    '',
    '路径 | 执行前 | 执行后',
    ...changes.map(change => `${change.path} | ${change.before} | ${change.after}`),
    '',
    '请用 Git 审查并决定是否提交；若同一目录可能被其他进程修改，请先核对再归因。'
  ].join('\n').slice(0, 2 ** 20 - 1000);
}
