#!/usr/bin/env node
// Register this Tempt Room agent as a stdio MCP server in MiniMax Code's own
// mcp.json. MiniMax Code reads "<dataDir>/mcp.json"; this script merges one
// "room" entry, keeps a timestamped backup and never prints the agent token.
//
// Usage:
//   node scripts/install-minimax-mcp.mjs --agent minimax-code --room <roomId>
//   node scripts/install-minimax-mcp.mjs --print   # preview, do not write
//
// The default server name is "temptroom" so a project-scoped "room" MCP in
// .mcp.json cannot shadow this user-level minimax connector.
//
// The agent must already be a member of the room and MiniMax Code must be
// restarted (or a new chat started) before it loads the new MCP server.
import {copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const printOnly = args.includes('--print');
const ownerToken = process.env.ROOM_OWNER_TOKEN ?? (() => {
  try { return readFileSync(resolve('.state/owner-session.token'), 'utf8').trim(); } catch { return ''; }
})();
if (!ownerToken) {
  console.error('缺少 owner token：设置 ROOM_OWNER_TOKEN 或在仓库根目录保留 .state/owner-session.token');
  process.exit(2);
}
const baseUrl = (process.env.ROOM_URL ?? 'http://127.0.0.1:4317').replace(/\/+$/, '');
const agentId = flag('--agent', process.env.ROOM_AGENT_ID ?? 'minimax-code');
const serverName = flag('--name', 'temptroom');
const roomId = flag('--room', process.env.ROOM_ROOM_ID ?? '');
if (!roomId) {
  console.error('缺少 --room <roomId> 或 ROOM_ROOM_ID');
  process.exit(2);
}
const response = await fetch(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/connect?roomId=${encodeURIComponent(roomId)}`, {
  headers: {authorization: `Bearer ${ownerToken}`, 'room-protocol-version': '0.1'}
});
if (!response.ok) {
  console.error(`无法获取连接配置：HTTP ${response.status} ${await response.text()}`);
  process.exit(1);
}
const data = await response.json();
const server = data.mcpServers.room;
const stored = {
  type: 'stdio',
  enabled: true,
  configured: true,
  builtin: false,
  command: server.command,
  args: [...server.args],
  env: {...server.env},
  description: `Tempt Room external Agent MCP (${agentId} @ ${roomId})`,
  timeout: 40000
};
const home = process.env.MINIMAX_DATA_DIR ?? join(homedir(), '.minimax');
const target = join(home, 'mcp.json');
let document = {mcpServers: {}};
if (existsSync(target)) {
  try { document = JSON.parse(readFileSync(target, 'utf8')); } catch { document = {mcpServers: {}}; }
  if (!printOnly) {
    const backup = `${target}.tempt-room-backup-${Date.now()}`;
    copyFileSync(target, backup);
    console.log(`已备份原配置：${backup}`);
  }
}
delete document.mcpServers?.room;
document.mcpServers = {...(document.mcpServers ?? {}), [serverName]: stored};
const preview = JSON.stringify(document, null, 2);
if (printOnly) {
  console.log(preview);
  process.exit(0);
}
mkdirSync(home, {recursive: true});
writeFileSync(target, preview + '\n', 'utf8');
console.log(`已写入 MiniMax Code MCP 配置：${target}（server: ${serverName}）`);
console.log('请重启 MiniMax Code 或新建会话，然后在对话中让 Agent 使用 room 工具。');
