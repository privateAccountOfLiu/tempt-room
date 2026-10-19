import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ProtocolError } from '../../../packages/protocol/src/index.ts';
import { uid } from './store.ts';

const excluded = new Set(['.git', '.state', '.cache', 'node_modules', 'dist', 'build', 'bin', 'obj', '.aws', '.ssh', '.codex', '.claude', '.dsh','.npmrc','.pypirc','.netrc','.git-credentials','.gitconfig','auth.json']);
const sensitive = (name: string) => excluded.has(name.toLowerCase()) || /^\.env(?:\.|$)/i.test(name) || /(?:credentials|id_rsa|id_ed25519|\.pem$|\.key$)/i.test(name);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export interface FileChange { path: string; before: string | null; after: string | null; beforeText: string; afterText: string; binary: boolean }
interface Manifest { id: string; source: string; workspace: string; files: Record<string, { hash: string; content: string }>; sourceCommit?: string }
export function safePath(root: string, name: string): string {
  if (!name || isAbsolute(name) || name.includes(':') || name.includes('\0')) throw new ProtocolError('unsafe_path', '无效文件路径');
  const parts = name.replaceAll('\\', '/').split('/');
  if (parts.some(p => p === '..' || p === '.' || !p || sensitive(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new ProtocolError('unsafe_path', '受保护或越界的文件路径');
  const target = resolve(root, ...parts), base = resolve(root);
  if (!target.toLowerCase().startsWith(base.toLowerCase() + sep)) throw new ProtocolError('unsafe_path', '文件路径越界');
  let current = base;
  if (lstatSync(current).isSymbolicLink()) throw new ProtocolError('unsafe_path', '工作区不能是重解析链接');
  for (const part of parts) { current = join(current, part); if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new ProtocolError('unsafe_path', '不允许重解析链接'); }
  return target;
}
function scan(root: string): Record<string, { hash: string; content: string }> {
  const result: Record<string, { hash: string; content: string }> = {}; let bytes = 0, count = 0;
  function walk(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (sensitive(entry.name)) continue;
      const full = join(path, entry.name); if (lstatSync(full).isSymbolicLink()) throw new ProtocolError('reparse_point', '工作区包含不支持的重解析链接');
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const data = readFileSync(full); bytes += data.length; count++;
        if (bytes > 200 * 1024 * 1024 || count > 20000) throw new ProtocolError('snapshot_limit', '项目快照超过 200 MiB 或 20,000 个文件');
        result[relative(root, full).split(sep).join('/')] = { hash: sha(data), content: data.toString('base64') };
      }
    }
  } walk(root); return result;
}
export class Workspaces {
  constructor(public root: string) { mkdirSync(root, { recursive: true }); }
  snapshot(project: string, runId: string): Manifest {
    if (!isAbsolute(project) || !existsSync(project) || !lstatSync(project).isDirectory()) throw new ProtocolError('invalid_project', '请选择存在的绝对项目目录');
    if (lstatSync(project).isSymbolicLink()) throw new ProtocolError('invalid_project', '项目根目录不能是重解析链接');
    const source = realpathSync(project), files = scan(source), workspace = join(this.root, 'sandboxes', runId, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const git = spawnSync('git', ['-C', source, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', windowsHide: true });
    let sourceCommit: string | undefined;
    if (git.status === 0) {
      sourceCommit = git.stdout.trim();
      // Rebuild repository metadata from the selected file snapshot. Copying
      // historical objects would also copy deleted credentials and host paths.
      const clone = spawnSync('git', ['-c', 'init.templateDir=', 'init', '--ref-format=reftable', '--quiet', '--', workspace], { encoding: 'utf8', windowsHide: true });
      if (clone.status !== 0) throw new Error('无法建立独立 Git 快照：' + clone.stderr.slice(-1000));
      mkdirSync(join(workspace,'.git','room-empty-hooks'),{recursive:true});
      const hooks=spawnSync('git', ['-C', workspace, 'config', 'core.hooksPath', '.git/room-empty-hooks'], { windowsHide: true });
      if(hooks.status!==0)throw new Error('无法配置独立 Git hooks 目录');
    }
    for (const [path, file] of Object.entries(files)) { const dest = safePath(workspace, path); mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, Buffer.from(file.content, 'base64')); }
    if(sourceCommit){
      const env={...process.env,GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_ATTR_NOSYSTEM:'1'};
      for(const args of [['add','--all'],['-c','user.name=Tempt Room','-c','user.email=snapshot@temptroom.local','-c','commit.gpgsign=false','commit','--quiet','--allow-empty','-m',`Snapshot of ${sourceCommit}`]]){
        const result=spawnSync('git',['-C',workspace,...args],{encoding:'utf8',windowsHide:true,env});if(result.status!==0)throw new Error('Git 快照基线创建失败：'+result.stderr.slice(-1000));
      }
    }
    const manifest: Manifest = { id: runId, source, workspace, files, sourceCommit };
    mkdirSync(join(this.root, 'manifests'), { recursive: true }); writeFileSync(join(this.root, 'manifests', `${runId}.json`), JSON.stringify(manifest)); return manifest;
  }
  changes(runId: string): { manifest: Manifest; changes: FileChange[]; patch: string } {
    const manifest: Manifest = JSON.parse(readFileSync(join(this.root, 'manifests', `${runId}.json`), 'utf8'));
    const current = scan(manifest.workspace), changes: FileChange[] = [];
    for (const path of new Set([...Object.keys(manifest.files), ...Object.keys(current)])) {
      const a = manifest.files[path], b = current[path]; if (a?.hash === b?.hash) continue;
      const before = a ? Buffer.from(a.content, 'base64') : Buffer.alloc(0), after = b ? Buffer.from(b.content, 'base64') : Buffer.alloc(0);
      changes.push({ path, before: a?.hash ?? null, after: b?.content ?? null, beforeText: before.toString('utf8'), afterText: after.toString('utf8'), binary: before.includes(0) || after.includes(0) });
    }
    const patch = changes.map(c => {
      if(c.binary)return `Binary file changed: ${c.path}\n`;
      const lines=(text:string)=>text===''?[]:(text.endsWith('\n')?text.slice(0,-1):text).split('\n');
      const a=lines(c.beforeText),b=lines(c.afterText),body=(items:string[],prefix:string,text:string)=>items.map((line,i)=>prefix+line+'\n'+(i===items.length-1&&!text.endsWith('\n')?'\\ No newline at end of file\n':'')).join('');
      return `diff --git ${JSON.stringify('a/'+c.path)} ${JSON.stringify('b/'+c.path)}\n--- ${c.before===null?'/dev/null':JSON.stringify('a/'+c.path)}\n+++ ${c.after===null?'/dev/null':JSON.stringify('b/'+c.path)}\n@@ -${a.length?1:0},${a.length} +${b.length?1:0},${b.length} @@\n${body(a,'-',c.beforeText)}${body(b,'+',c.afterText)}`;
    }).join('\n');
    return { manifest, changes, patch };
  }
  apply(manifest: Manifest, changes: FileChange[]) {
    const applyRoot=join(this.root,'apply');
    if(existsSync(applyRoot))for(const entry of readdirSync(applyRoot,{withFileTypes:true}))if(entry.isDirectory()){
      const journal=join(applyRoot,entry.name);if(!existsSync(join(journal,'complete'))&&existsSync(join(journal,'journal.json'))){const pending=JSON.parse(readFileSync(join(journal,'journal.json'),'utf8'));if(pending.source.toLowerCase()===manifest.source.toLowerCase())throw new ProtocolError('recovery_required',`发现未完成的应用日志 ${entry.name}。请先审查 journal.json 和备份，确认恢复后再应用。`,409);}
    }
    if (lstatSync(manifest.source).isSymbolicLink() || realpathSync(manifest.source) !== manifest.source) throw new ProtocolError('source_changed', '原项目路径已变化', 409);
    const backups: { path: string; data: Buffer | null }[] = [];
    for (const change of changes) {
      const path = safePath(manifest.source, change.path), data = existsSync(path) ? readFileSync(path) : null;
      if ((data ? sha(data) : null) !== change.before) throw new ProtocolError('apply_conflict', `文件已变化：${change.path}，请重新审查`, 409);
      backups.push({ path, data });
    }
    const journalId = uid('apply'), journal = join(this.root, 'apply', journalId); mkdirSync(journal, { recursive: true });
    writeFileSync(join(journal, 'journal.json'), JSON.stringify({ state: 'prepared', source: manifest.source, changes, backups: backups.map(b => ({ path: b.path, data: b.data?.toString('base64') ?? null })) }));
    const attempted: number[] = [];
    try {
      changes.forEach((change, index) => {
        const path = safePath(manifest.source, change.path); attempted.push(index);
        if (change.after === null) { if (existsSync(path)) unlinkSync(path); }
        else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, Buffer.from(change.after, 'base64')); }
      });
      writeFileSync(join(journal, 'complete'), 'applied');
    } catch (error) {
      for (const index of attempted.reverse()) { const b = backups[index]; try { if (b.data === null) { if (existsSync(b.path)) unlinkSync(b.path); } else { mkdirSync(dirname(b.path), { recursive: true }); writeFileSync(b.path, b.data); } } catch { throw new ProtocolError('rollback_incomplete', `应用失败，需检查恢复日志 ${journalId}`, 500); } }
      writeFileSync(join(journal, 'complete'), 'rolled-back'); throw error;
    }
    return { changedFiles: changes.length, journalId };
  }
}
