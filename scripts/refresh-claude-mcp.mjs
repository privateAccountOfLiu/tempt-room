#!/usr/bin/env node
// Refresh the room Agent token inside .mcp.json after a Tempt Room restart.
// Agent tokens derive from the startup secret, so the previous token becomes
// invalid when the service restarts. This script asks the running service for a
// fresh token (using the one-time owner startup token), updates only the project
// .mcp.json entry, writes a timestamped backup and verifies the token.
//
// Usage:
//   node scripts/refresh-claude-mcp.mjs --session-url "http://127.0.0.1:4317/#session=<token>"
//   ROOM_OWNER_TOKEN=<token> node scripts/refresh-claude-mcp.mjs
// Options: --agent <id> (default claude-code) --file <.mcp.json> --no-check
import {copyFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1] ?? (() => { throw new Error(`${name} 需要一个值`); })();
  return fallback;
};
const sessionUrl = flag('--session-url', process.env.ROOM_SESSION_URL ?? '');
const ownerToken = (() => {
  if (process.env.ROOM_OWNER_TOKEN) return process.env.ROOM_OWNER_TOKEN;
  const match = String(sessionUrl).match(/#session=([0-9a-f]{64})/i);
  return match?.[1];
})();
if (!ownerToken) {
  console.error('缺少启动令牌：请传入 --session-url "<启动地址>"（含 #session=...）或设置 ROOM_OWNER_TOKEN。令牌只在本机使用。');
  process.exit(2);
}
const agentId = flag('--agent', process.env.ROOM_AGENT_ID ?? 'claude-code');
const configPath = resolve(flag('--file', process.env.ROOM_MCP_FILE ?? '.mcp.json'));
if (!existsSync(configPath)) {
  console.error(`找不到 ${configPath}`);
  process.exit(2);
}
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const room = config?.mcpServers?.room;
if (!room?.env?.ROOM_URL || !room?.env?.ROOM_ROOM_ID) {
  console.error(`${configPath} 中没有 mcpServers.room.env.ROOM_URL / ROOM_ROOM_ID`);
  process.exit(2);
}
const base = room.env.ROOM_URL.replace(/\/+$/, '');
const roomId = room.env.ROOM_ROOM_ID;
const headers = {authorization: `Bearer ${ownerToken}`, 'room-protocol-version': '0.1', 'content-type': 'application/json'};
const check = !args.includes('--no-check');
let issued;
try {
  const response = await fetch(`${base}/api/agents/${encodeURIComponent(agentId)}/connect?roomId=${encodeURIComponent(roomId)}`, {headers});
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 300)}`);
  issued = JSON.parse(text);
} catch (error) {
  console.error(`读取 Agent 令牌失败：${error.message}`);
  process.exit(1);
}
if (!issued?.token || !/^[a-zA-Z0-9_-]+\.v1\.[a-zA-Z0-9_-]+\.[0-9a-f]{64}$/.test(issued.token)) {
  console.error('服务返回的 Agent 令牌格式不正确，未修改文件');
  process.exit(1);
}
if (issued.token === room.env.ROOM_AGENT_TOKEN) {
  console.log(`令牌未变化（Agent ${agentId} / 房间 ${roomId}），仍验证连接…`);
} else {
  const backup = `${configPath}.bak-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`;
  copyFileSync(configPath, backup);
  room.env.ROOM_AGENT_TOKEN = issued.token;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log(`已更新 ${configPath} 中 Agent ${agentId} 的房间令牌；备份 ${backup}`);
}
if (check) {
  try {
    const response = await fetch(`${base}/api/agent/tool`, {
      method: 'POST',
      headers: {authorization: `Bearer ${room.env.ROOM_AGENT_TOKEN}`, 'room-protocol-version': '0.1', 'content-type': 'application/json'},
      body: JSON.stringify({commandId: `refresh_${Date.now()}`, roomId, name: 'room_status', arguments: {}})
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 300)}`);
    const data = JSON.parse(text);
    console.log(`验证通过：Agent ${agentId} 可访问房间「${data?.result?.room?.name ?? roomId}」，当前事件序号 ${data?.result?.room?.seq ?? '?'}`);
  } catch (error) {
    console.error(`令牌写入后验证失败：${error.message}`);
    process.exit(1);
  }
}
console.log('完成。若 Claude Code 会话正在运行，请重新打开会话以加载新的 .mcp.json 环境。');
