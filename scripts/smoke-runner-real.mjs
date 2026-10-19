#!/usr/bin/env node
// Real-model auto-duty runner check: start the external duty runner with the
// local Claude Code CLI, @mention the external claude-code Agent, and verify the
// runner starts the CLI and posts the model reply back into the room.
//
//   $env:DEEPSEEK_API_KEY = '<Claude compatible endpoint token>'
//   npm run test:runner-real -- --allow-paid
import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {join, resolve} from 'node:path';

if (!process.argv.includes('--allow-paid')) {
  console.error('用法：npm run test:runner-real -- --allow-paid（一次真实模型轮次，会产生费用；需 DEEPSEEK_API_KEY）');
  process.exit(2);
}
const project = resolve('.');
const state = resolve(process.env.ROOM_STATE_DIR ?? '.state');
const key = process.env.DEEPSEEK_API_KEY;
if (!key) { console.error('缺少 DEEPSEEK_API_KEY（Claude 兼容端点需要）'); process.exit(2); }
const mcpPath = join(project, '.mcp.json');
if (!existsSync(mcpPath)) { console.error('缺少项目 .mcp.json'); process.exit(2); }
const room = JSON.parse(readFileSync(mcpPath, 'utf8'))?.mcpServers?.room?.env;
if (!room?.ROOM_URL || !room?.ROOM_AGENT_TOKEN || !room?.ROOM_ROOM_ID) { console.error('.mcp.json 的 room.env 不完整'); process.exit(2); }
const ownerToken = (() => { try { return readFileSync(join(state, 'owner-session.token'), 'utf8').trim(); } catch { return undefined; } })();
if (!ownerToken || !/^[0-9a-f]{64}$/.test(ownerToken)) { console.error('缺少可用 owner-session.token'); process.exit(2); }

function findClaude() {
  const explicit = process.env.ROOM_CLAUDE_COMMAND;
  if (explicit && existsSync(explicit)) return explicit;
  const roots = [process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local')];
  for (const root of roots) {
    const base = join(root, 'Claude-3p', 'claude-code');
    if (!existsSync(base)) continue;
    for (const version of readdirSync(base).sort().reverse()) {
      for (const candidate of [join(base, version, 'claude.exe'), join(base, version, 'claude')]) {
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  const fallback = join(process.env.USERPROFILE ?? '', 'AppData', 'Local', 'Claude-3p', 'claude-code', '2.1.271', 'claude.exe');
  return existsSync(fallback) ? fallback : undefined;
}
const claude = findClaude();
if (!claude) { console.error('找不到 Claude Code CLI；可用 ROOM_CLAUDE_COMMAND 显式指定'); process.exit(2); }

const parent = join(state, 'runner-real-smoke');
mkdirSync(parent, {recursive: true});
const runDir = mkdtempSync(join(parent, 'run-'));
const startedAt = new Date().toISOString();
const env = {...process.env,
  ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
  ANTHROPIC_AUTH_TOKEN: key,
  CLAUDE_CODE_HOST_AUTH_ENV_VAR: 'ANTHROPIC_AUTH_TOKEN',
  ROOM_URL: room.ROOM_URL, ROOM_AGENT_TOKEN: room.ROOM_AGENT_TOKEN, ROOM_ROOM_ID: room.ROOM_ROOM_ID,
  ROOM_AGENT_COMMAND: claude,
  ROOM_AGENT_ARGS: JSON.stringify(['-p', '{prompt}', '--output-format', 'text', '--permission-mode', 'bypassPermissions', '--setting-sources=project,local']),
  ROOM_AGENT_CWD: project, ROOM_POST_RESULT: '1'
};
delete env.ANTHROPIC_API_KEY;
const runner = spawn(process.execPath, [join(project, 'scripts', 'room-agent-runner.mjs'), '--once'], {cwd: project, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
let stderr = '';
runner.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
const base = String(room.ROOM_URL).replace(/\/+$/, '');
const headers = {authorization: `Bearer ${ownerToken}`, 'room-protocol-version': '0.1', 'content-type': 'application/json'};
const sleep = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
await sleep(3000);
const marker = `RUNNER_REAL_${Date.now() % 100000}`;
const sent = await fetch(`${base}/api/commands`, {method: 'POST', headers, body: JSON.stringify({version: '0.1', commandId: `runner_real_${Date.now()}`, roomId: room.ROOM_ROOM_ID, type: 'message.send', payload: {text: `${marker}：请只回复 RUNNER_REAL_OK，不要调用工具。`, mentions: ['claude-code']}})});
if (!sent.ok) { console.error(`发送提及消息失败：${sent.status} ${await sent.text()}`); runner.kill(); process.exit(1); }
const exited = await Promise.race([new Promise(resolveExit => runner.once('exit', code => resolveExit({code}))), sleep(240_000).then(() => ({timeout: true}))]);
if (exited.timeout) runner.kill();
await sleep(800);
const snapshot = await (await fetch(`${base}/api/rooms/${room.ROOM_ROOM_ID}`, {headers})).json();
const posted = (snapshot.messages ?? []).filter(message => message.actor?.id === 'claude-code' && String(message.text).includes('RUNNER_REAL_OK')).slice(-1)[0];
const report = {startedAt, finishedAt: new Date().toISOString(), ok: Boolean(posted), marker, claude, runnerExit: exited, posted: posted ? {actor: posted.actor.id, text: String(posted.text).slice(0, 300), createdAt: posted.createdAt} : undefined, stderrTail: stderr.split('\n').slice(-10)};
const reportPath = join(runDir, 'report.json');
writeFileSync(reportPath, JSON.stringify(report, null, 2));
writeFileSync(join(parent, 'latest.json'), JSON.stringify({run: runDir, report: reportPath, ok: report.ok, finishedAt: report.finishedAt}, null, 2));
if (report.ok) { console.log('runner-real-smoke: PASS'); console.log(`runner-real-smoke report: ${reportPath}`); }
else { console.error('runner-real-smoke: FAIL'); console.error(stderr.split('\n').slice(-10).join('\n')); console.error(`runner-real-smoke report: ${reportPath}`); process.exitCode = 1; }
