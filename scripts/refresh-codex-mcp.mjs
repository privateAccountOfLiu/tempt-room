#!/usr/bin/env node
// Refresh the room Agent token inside the Codex MCP configuration after a Tempt
// Room restart. Codex CLI stores MCP servers in $CODEX_HOME/config.toml; the
// room token is derived from the Tempt Room startup secret and rotates with it.
//
// Usage:
//   node scripts/refresh-codex-mcp.mjs --session-url "http://127.0.0.1:4317/#session=<token>"
//   ROOM_OWNER_TOKEN=<token> node scripts/refresh-codex-mcp.mjs
// Options: --agent <id> (default codex) --room <roomId> --codex <codex.exe> --no-check
import {copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1] ?? (() => { throw new Error(`${name} 需要一个值`); })();
  return fallback;
};
const ownerToken = (() => {
  if (process.env.ROOM_OWNER_TOKEN) return process.env.ROOM_OWNER_TOKEN;
  const sessionUrl = flag('--session-url', process.env.ROOM_SESSION_URL ?? '');
  return String(sessionUrl).match(/#session=([0-9a-f]{64})/i)?.[1];
})();
if (!ownerToken) {
  console.error('缺少启动令牌：请传入 --session-url "<启动地址>"（含 #session=...）或设置 ROOM_OWNER_TOKEN。');
  process.exit(2);
}
const agentId = flag('--agent', process.env.ROOM_AGENT_ID ?? 'codex');
const home = process.env.CODEX_HOME ?? join(process.env.USERPROFILE ?? '', '.codex');
const configPath = join(home, 'config.toml');
if (!existsSync(configPath)) {
  console.error(`找不到 Codex 配置：${configPath}`);
  process.exit(2);
}
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let codex = flag('--codex', process.env.CODEX_CLI ?? '');
if (!codex) {
  const binRoot = join(process.env.USERPROFILE ?? '', 'AppData', 'Local', 'OpenAI', 'Codex', 'bin');
  if (existsSync(binRoot)) {
    for (const entry of readdirSync(binRoot)) {
      const candidate = join(binRoot, entry, 'codex.exe');
      if (existsSync(candidate)) { codex = candidate; break; }
    }
  }
}
if (!codex || !existsSync(codex)) {
  console.error('找不到 codex.exe：请用 --codex 指定 Codex CLI 绝对路径');
  process.exit(2);
}

const original = readFileSync(configPath, 'utf8');
const blockMatch = original.match(new RegExp(`\\[mcp_servers\\.room(?:\\.env)?\\][\\s\\S]*?(?=\\n\\[|$)`, 'g'));
const readValue = (key) => {
  for (const block of blockMatch ?? []) {
    const match = block.match(new RegExp(`^${escapeRegExp(key)}\\s*=\\s*"([^"]*)"`, 'm'));
    if (match) return match[1];
  }
  return undefined;
};
const roomUrl = readValue('ROOM_URL');
const roomId = flag('--room', readValue('ROOM_ROOM_ID'));
if (!roomUrl || !roomId) {
  console.error(`无法从 ${configPath} 读取 [mcp_servers.room.env] 的 ROOM_URL / ROOM_ROOM_ID；请先通过 Tempt Room UI 安装一次 Codex 配置`);
  process.exit(2);
}
const base = roomUrl.replace(/\/+$/, '');
const headers = {authorization: `Bearer ${ownerToken}`, 'room-protocol-version': '0.1', 'content-type': 'application/json'};
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
  console.error('服务返回的 Agent 令牌格式不正确，未修改配置');
  process.exit(1);
}
const backup = `${configPath}.tempt-room.bak.${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`;
copyFileSync(configPath, backup);
const run = (commandArgs) => spawnSync(codex, commandArgs, {encoding: 'utf8', windowsHide: true, timeout: 60_000});
const node = process.execPath;
const script = join(process.cwd(), 'scripts', 'room-agent-mcp.mjs');
let result = run(['mcp', 'remove', 'room']);
if (result.status !== 0) console.log('（原有 room 配置不存在或移除失败，继续添加）');
result = run(['mcp', 'add', 'room', '--env', `ROOM_URL=${base}`, '--env', `ROOM_AGENT_TOKEN=${issued.token}`, '--env', `ROOM_ROOM_ID=${roomId}`, '--', node, script]);
if (result.status !== 0) {
  copyFileSync(backup, configPath);
  console.error(`codex mcp add 失败，已恢复原配置：${(result.stderr || result.stdout || '').slice(-500)}`);
  process.exit(1);
}
console.log(`已更新 Codex 全局 room MCP（Agent ${agentId} / 房间 ${roomId}）；备份 ${backup}`);
if (!args.includes('--no-check')) {
  try {
    const response = await fetch(`${base}/api/agent/tool`, {method: 'POST', headers: {authorization: `Bearer ${issued.token}`, 'room-protocol-version': '0.1', 'content-type': 'application/json'}, body: JSON.stringify({commandId: `refresh_${Date.now()}`, roomId, name: 'room_status', arguments: {}})});
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 300)}`);
    const data = JSON.parse(text);
    console.log(`验证通过：Agent ${agentId} 可访问房间「${data?.result?.room?.name ?? roomId}」，当前事件序号 ${data?.result?.room?.seq ?? '?'}`);
  } catch (error) {
    console.error(`令牌写入后验证失败：${error.message}`);
    process.exit(1);
  }
}
console.log('完成。正在运行的 Codex 会话需要重新打开以加载新的 MCP 配置。');
