import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { detectLocalExecutables } from './detect.ts';

export type InstallTarget = 'claude' | 'codex' | 'dsh' | 'claude-project';
export interface InstallOptions { url: string; token: string; roomId: string; node: string; bridge: string; projectPath?: string }
export interface InstallResult { target: InstallTarget; path: string; backup?: string; action: 'installed' | 'removed'; detail?: string }
export interface PreviewResult { target: InstallTarget; path: string; exists: boolean; current: string; planned: string; changed: boolean; note?: string }

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const marker = 'tempt-room managed MCP server';

function backup(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const target = `${file}.tempt-room.bak.${stamp()}`;
  copyFileSync(file, target);
  return target;
}

/** Insert or replace a TOML section starting with `[mcp_servers.room]`. */
export function planCodexConfig(file: string, block: string): { path: string; current: string; planned: string; exists: boolean } {
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const kept: string[] = [];
  let skipping = false;
  for (const line of current.split(/\r?\n/)) {
    const heading = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (heading) skipping = heading[1].trim() === 'mcp_servers.room' || heading[1].trim().startsWith('mcp_servers.room.');
    if (!skipping) kept.push(line);
  }
  const trimmed = kept.join('\n').replace(/\s+$/, '');
  const planned = [trimmed, trimmed ? '' : '', `# ${marker}`, block, ''].join('\n');
  return { path: file, current, planned, exists: existsSync(file) };
}

export function upsertCodexConfig(file: string, block: string): { path: string; backup?: string } {
  const plan = planCodexConfig(file, block);
  if (plan.current === plan.planned) return { path: file };
  mkdirSync(dirname(file), { recursive: true });
  const saved = backup(file);
  writeFileSync(file, plan.planned);
  return { path: file, backup: saved };
}

export function removeCodexSection(file: string): { path: string; changed: boolean } {
  if (!existsSync(file)) return { path: file, changed: false };
  const kept: string[] = [];
  let skipping = false;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const heading = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (heading) skipping = heading[1].trim() === 'mcp_servers.room' || heading[1].trim().startsWith('mcp_servers.room.');
    if (!skipping) kept.push(line);
  }
  const content = kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
  if (content.trim() === readFileSync(file, 'utf8').trim()) return { path: file, changed: false };
  backup(file);
  writeFileSync(file, content);
  return { path: file, changed: true };
}

export function planDshProfile(file: string, block: string): { path: string; current: string; planned: string; exists: boolean } {
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const meaningful = current.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')).join('\n');
  const managed = current.includes(marker);
  if (meaningful && meaningful !== '[]' && !managed) throw new Error('该 DSH profile 的 cordis.patch.yml 已有自定义内容，请手动合并 mcp-room band（未修改文件）');
  return { path: file, current, planned: `# ${marker}\n${block}\n`, exists: existsSync(file) };
}

/** DSH acp profile patch: only take over an empty/comment-only or already-managed patch layer. */
export function upsertDshProfile(file: string, block: string): { path: string; backup?: string } {
  const plan = planDshProfile(file, block);
  mkdirSync(dirname(file), { recursive: true });
  const saved = backup(file);
  writeFileSync(file, plan.planned);
  return { path: file, backup: saved };
}

export function removeDshProfile(file: string): { path: string; changed: boolean } {
  if (!existsSync(file)) return { path: file, changed: false };
  const current = readFileSync(file, 'utf8');
  if (!current.includes(marker)) return { path: file, changed: false };
  backup(file);
  writeFileSync(file, '# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists; `!!js` expressions allowed).\n[]\n');
  return { path: file, changed: true };
}

/** Merge the room server into a project-level .mcp.json, preserving other servers. */
export function planProjectMcp(file: string, name: string, server: unknown): { path: string; current: string; planned: string; exists: boolean } {
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  let data: Record<string, unknown> = {};
  if (current.trim()) {
    try { data = JSON.parse(current) as Record<string, unknown>; }
    catch { throw new Error('.mcp.json 不是合法 JSON，未修改文件'); }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('.mcp.json 顶层必须是 JSON 对象，未修改文件');
  }
  const servers = (typeof data.mcpServers === 'object' && data.mcpServers !== null && !Array.isArray(data.mcpServers)) ? data.mcpServers as Record<string, unknown> : {};
  data.mcpServers = { ...servers, [name]: server };
  return { path: file, current, planned: JSON.stringify(data, null, 2) + '\n', exists: existsSync(file) };
}

export function upsertProjectMcp(file: string, name: string, server: unknown): { path: string; backup?: string; changed: boolean } {
  const plan = planProjectMcp(file, name, server);
  if (plan.current === plan.planned) return { path: file, changed: false };
  mkdirSync(dirname(file), { recursive: true });
  const saved = backup(file);
  writeFileSync(file, plan.planned);
  return { path: file, backup: saved, changed: true };
}

export function removeProjectMcp(file: string, name: string): { path: string; backup?: string; changed: boolean } {
  if (!existsSync(file)) return { path: file, changed: false };
  let data: Record<string, unknown>;
  try { data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; }
  catch { throw new Error('.mcp.json 不是合法 JSON，未修改文件'); }
  const servers = (typeof data.mcpServers === 'object' && data.mcpServers !== null && !Array.isArray(data.mcpServers)) ? data.mcpServers as Record<string, unknown> : {};
  if (!Object.prototype.hasOwnProperty.call(servers, name)) return { path: file, changed: false };
  delete servers[name];
  data.mcpServers = servers;
  const saved = backup(file);
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return { path: file, backup: saved, changed: true };
}

function claudeCli(): string {
  const claude = detectLocalExecutables().claude;
  if (!claude) throw new Error('未找到 Claude Code CLI，无法自动写入 Claude 配置');
  return claude;
}

function runClaude(args: string[]): void {
  const result = spawnSync(claudeCli(), args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (result.status !== 0) throw new Error(`claude ${args[0]} 失败：${(result.stderr || result.stdout || '').slice(-500)}`);
}

function roomEnv(options: InstallOptions) {
  return { ROOM_URL: options.url, ROOM_AGENT_TOKEN: options.token, ROOM_ROOM_ID: options.roomId };
}

function codexBlock(options: InstallOptions): string {
  return [`[mcp_servers.room]`, `command = ${JSON.stringify(options.node)}`, `args = [${JSON.stringify(options.bridge)}]`, ``, `[mcp_servers.room.env]`, ...Object.entries(roomEnv(options)).map(([key, value]) => `${key} = ${JSON.stringify(value)}`)].join('\n');
}

function dshBlock(options: InstallOptions): string {
  return ['- insert:', '    - id: mcp-room', "      name: '@deepseek-ai/dsh-mcp-client'", '      config:', '        serverName: room', '        transport: stdio', `        command: ${JSON.stringify(options.node)}`, '        args:', `          - ${JSON.stringify(options.bridge)}`, '        env:', ...Object.entries(roomEnv(options)).map(([key, value]) => `          ${key}: ${JSON.stringify(value)}`)].join('\n');
}

function projectServer(options: InstallOptions) {
  return { command: options.node, args: [options.bridge], env: roomEnv(options) };
}

function projectFile(options: InstallOptions): string {
  if (!options.projectPath) throw new Error('项目级安装需要填写项目目录');
  return join(options.projectPath, '.mcp.json');
}

/** Show what the installer would write without touching files or the Claude CLI. */
export function previewConnector(target: InstallTarget, options: InstallOptions): PreviewResult {
  const home = process.env.USERPROFILE ?? 'C:\\Users\\Default';
  if (target === 'claude') {
    const command = `claude mcp add room --scope user -e ROOM_URL=${options.url} -e ROOM_AGENT_TOKEN=<该 Agent 的独立令牌> -e ROOM_ROOM_ID=${options.roomId} -- "${options.node}" "${options.bridge}"`;
    return { target, path: 'Claude Code 用户配置（由 claude mcp add 管理）', exists: false, current: '', planned: command, changed: true, note: 'Claude 用户配置由官方 CLI 管理，无法安全回读；令牌不会出现在预览中' };
  }
  if (target === 'codex') {
    const plan = planCodexConfig(join(home, '.codex', 'config.toml'), codexBlock(options));
    return { target, path: plan.path, exists: plan.exists, current: plan.current, planned: plan.planned, changed: plan.current !== plan.planned };
  }
  if (target === 'dsh') {
    const plan = planDshProfile(join(home, '.dsh', 'profiles', 'acp', 'cordis.patch.yml'), dshBlock(options));
    return { target, path: plan.path, exists: plan.exists, current: plan.current, planned: plan.planned, changed: plan.current !== plan.planned };
  }
  const plan = planProjectMcp(projectFile(options), 'room', projectServer(options));
  return { target, path: plan.path, exists: plan.exists, current: plan.current, planned: plan.planned, changed: plan.current !== plan.planned };
}

/** Install the room MCP server into the client's own user config (with backup where we edit files). */
export function installConnector(target: InstallTarget, options: InstallOptions): InstallResult {
  const home = process.env.USERPROFILE ?? 'C:\\Users\\Default';
  if (target === 'claude') {
    const env = roomEnv(options);
    try { runClaude(['mcp', 'remove', 'room', '--scope', 'user']); } catch { /* not installed yet */ }
    runClaude(['mcp', 'add', 'room', '--scope', 'user', '-e', `ROOM_URL=${env.ROOM_URL}`, '-e', `ROOM_AGENT_TOKEN=${env.ROOM_AGENT_TOKEN}`, '-e', `ROOM_ROOM_ID=${env.ROOM_ROOM_ID}`, '--', options.node, options.bridge]);
    return { target, path: 'Claude Code user scope (claude mcp add room --scope user)', action: 'installed' };
  }
  if (target === 'codex') {
    const written = upsertCodexConfig(join(home, '.codex', 'config.toml'), codexBlock(options));
    return { target, path: written.path, backup: written.backup, action: 'installed' };
  }
  if (target === 'dsh') {
    const written = upsertDshProfile(join(home, '.dsh', 'profiles', 'acp', 'cordis.patch.yml'), dshBlock(options));
    return { target, path: written.path, backup: written.backup, action: 'installed' };
  }
  const file = projectFile(options);
  const written = upsertProjectMcp(file, 'room', projectServer(options));
  return { target, path: file, backup: written.backup, action: 'installed' };
}

export function uninstallConnector(target: InstallTarget, options?: { projectPath?: string }): InstallResult {
  if (target === 'claude') {
    try { runClaude(['mcp', 'remove', 'room', '--scope', 'user']); return { target, path: 'Claude Code user scope', action: 'removed' }; }
    catch { return { target, path: 'Claude Code user scope', action: 'removed', detail: '未找到本工具写入的配置' }; }
  }
  const home = process.env.USERPROFILE ?? 'C:\\Users\\Default';
  if (target === 'codex') {
    const result = removeCodexSection(join(home, '.codex', 'config.toml'));
    return { target, path: result.path, action: 'removed', detail: result.changed ? '已移除' : '未找到本工具写入的配置' };
  }
  if (target === 'dsh') {
    const dsh = removeDshProfile(join(home, '.dsh', 'profiles', 'acp', 'cordis.patch.yml'));
    return { target, path: dsh.path, action: 'removed', detail: dsh.changed ? '已移除' : '未找到本工具写入的配置' };
  }
  if (!options?.projectPath) throw new Error('项目级卸载需要填写项目目录');
  const file = join(options.projectPath, '.mcp.json');
  const result = removeProjectMcp(file, 'room');
  return { target, path: file, action: 'removed', detail: result.changed ? '已移除' : '未找到本工具写入的配置' };
}
