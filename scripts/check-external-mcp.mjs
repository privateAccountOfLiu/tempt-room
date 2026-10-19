#!/usr/bin/env node
// Verify the room Agent tokens used by the two external client integrations:
//   - Claude Code: project .mcp.json
//   - Codex:       $CODEX_HOME/config.toml [mcp_servers.room]
// Calls only room_status over HTTP (no model request), writes a small report for
// the release-readiness summary and never prints token values.
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

const project = resolve('.');
const parent = join(project, '.state', 'external-mcp');
mkdirSync(parent, {recursive: true});
const checkedAt = new Date().toISOString();
const checks = [];

async function probe(name, base, token, roomId) {
  const started = Date.now();
  try {
    const response = await fetch(String(base).replace(/\/+$/, '') + '/api/agent/tool', {
      method: 'POST',
      headers: {authorization: `Bearer ${token}`, 'room-protocol-version': '0.1', 'content-type': 'application/json'},
      body: JSON.stringify({commandId: `external_${name.replace(/[^a-zA-Z0-9_-]+/g, '_')}_${Date.now()}`, roomId, name: 'room_status', arguments: {}})
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = undefined; }
    checks.push({name, ok: response.ok && Boolean(body?.result?.room), status: response.status, room: body?.result?.room?.name, seq: body?.result?.room?.seq, durationMs: Date.now() - started, error: response.ok ? undefined : text.slice(0, 200)});
  } catch (error) {
    checks.push({name, ok: false, error: String(error?.message ?? error), durationMs: Date.now() - started});
  }
}

const claudeFile = join(project, '.mcp.json');
if (!existsSync(claudeFile)) checks.push({name: 'Claude Code (.mcp.json)', ok: false, error: '缺少项目 .mcp.json'});
else {
  const room = JSON.parse(readFileSync(claudeFile, 'utf8'))?.mcpServers?.room?.env;
  if (!room?.ROOM_URL || !room?.ROOM_AGENT_TOKEN || !room?.ROOM_ROOM_ID) checks.push({name: 'Claude Code (.mcp.json)', ok: false, error: 'mcpServers.room.env 不完整'});
  else await probe('Claude Code (.mcp.json)', room.ROOM_URL, room.ROOM_AGENT_TOKEN, room.ROOM_ROOM_ID);
}

const codexHome = process.env.CODEX_HOME ?? join(process.env.USERPROFILE ?? '', '.codex');
const codexFile = join(codexHome, 'config.toml');
if (!existsSync(codexFile)) checks.push({name: 'Codex (config.toml)', ok: false, error: `缺少 ${codexFile}`});
else {
  const text = readFileSync(codexFile, 'utf8');
  const block = text.match(/\[mcp_servers\.room\.env\][\s\S]*?(?=\n\[|$)/)?.[0];
  const get = (key) => block?.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'))?.[1];
  if (!get('ROOM_URL') || !get('ROOM_AGENT_TOKEN') || !get('ROOM_ROOM_ID')) checks.push({name: 'Codex (config.toml)', ok: false, error: '[mcp_servers.room.env] 不完整'});
  else await probe('Codex (config.toml)', get('ROOM_URL'), get('ROOM_AGENT_TOKEN'), get('ROOM_ROOM_ID'));
}

const report = {checkedAt, ok: checks.every(check => check.ok), checks};
const reportPath = join(parent, `${checkedAt.replaceAll(':', '-').replaceAll('.', '-')}.json`);
writeFileSync(reportPath, JSON.stringify(report, null, 2));
writeFileSync(join(parent, 'latest.json'), JSON.stringify({report: reportPath, ok: report.ok, checkedAt}, null, 2));
for (const check of checks) console.log(`${check.name}: ${check.ok ? 'PASS' : 'FAIL'}${check.room ? ` - room ${check.room} seq ${check.seq}` : ''}${check.error ? ' - ' + check.error : ''}`);
console.log(`external-mcp report: ${reportPath}`);
process.exitCode = report.ok ? 0 : 1;
