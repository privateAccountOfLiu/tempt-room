#!/usr/bin/env node
// No-model integration check for the optional external-Agent duty runner:
// start the runner against the current room with a fake CLI, @mention the
// external Agent, and verify the runner launches the CLI and posts its output
// back into the room. No model request is made.
import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {join, resolve} from 'node:path';

const project = resolve('.');
const state = resolve(process.env.ROOM_STATE_DIR ?? '.state');
const mcpPath = join(project, '.mcp.json');
if (!existsSync(mcpPath)) { console.error('缺少项目 .mcp.json（需先安装 Claude Code 外部 MCP 配置）'); process.exit(2); }
const room = JSON.parse(readFileSync(mcpPath, 'utf8'))?.mcpServers?.room?.env;
if (!room?.ROOM_URL || !room?.ROOM_AGENT_TOKEN || !room?.ROOM_ROOM_ID) { console.error('.mcp.json 的 room.env 不完整'); process.exit(2); }
const ownerToken = (() => { try { return readFileSync(join(state, 'owner-session.token'), 'utf8').trim(); } catch { return undefined; } })();
if (!ownerToken || !/^[0-9a-f]{64}$/.test(ownerToken)) { console.error('缺少可用 owner-session.token；请先从启动地址打开一次'); process.exit(2); }

const parent = join(state, 'runner-smoke');
mkdirSync(parent, {recursive: true});
const runDir = mkdtempSync(join(parent, 'run-'));
const fakeCli = join(runDir, 'fake-agent.mjs');
writeFileSync(fakeCli, "process.stdout.write('RUNNER_SMOKE_OK');\n");
const startedAt = new Date().toISOString();
const runner = spawn(process.execPath, [join(project, 'scripts', 'room-agent-runner.mjs'), '--once'], {
  cwd: project,
  env: {...process.env, ROOM_URL: room.ROOM_URL, ROOM_AGENT_TOKEN: room.ROOM_AGENT_TOKEN, ROOM_ROOM_ID: room.ROOM_ROOM_ID,
    ROOM_AGENT_COMMAND: process.execPath, ROOM_AGENT_ARGS: JSON.stringify([fakeCli, '{prompt}']), ROOM_AGENT_CWD: project, ROOM_POST_RESULT: '1'},
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
});
let stderr = '';
runner.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
let stdout = '';
runner.stdout.on('data', chunk => { stdout += chunk; });
const base = String(room.ROOM_URL).replace(/\/+$/, '');
const headers = {authorization: `Bearer ${ownerToken}`, 'room-protocol-version': '0.1', 'content-type': 'application/json'};
const sleep = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
await sleep(2500);
const marker = `RUNNER_SMOKE_${Date.now() % 100000}`;
const sent = await fetch(`${base}/api/commands`, {method: 'POST', headers, body: JSON.stringify({version: '0.1', commandId: `runner_smoke_${Date.now()}`, roomId: room.ROOM_ROOM_ID, type: 'message.send', payload: {text: `${marker}：请回复 RUNNER_SMOKE_OK。`, mentions: ['claude-code']}})});
if (!sent.ok) { console.error(`发送提及消息失败：${sent.status} ${await sent.text()}`); runner.kill(); process.exit(1); }
const exited = await Promise.race([new Promise(resolveExit => runner.once('exit', code => resolveExit({code}))), sleep(90_000).then(() => ({timeout: true}))]);
if (exited.timeout) { runner.kill(); }
await sleep(500);
const snapshot = await (await fetch(`${base}/api/rooms/${room.ROOM_ROOM_ID}`, {headers})).json();
const posted = (snapshot.messages ?? []).filter(message => message.actor?.id === 'claude-code' && String(message.text).includes('RUNNER_SMOKE_OK')).slice(-1)[0];
const report = {startedAt, finishedAt: new Date().toISOString(), marker, ok: Boolean(posted), runnerExit: exited, posted: posted ? {actor: posted.actor.id, text: String(posted.text).slice(0, 200), createdAt: posted.createdAt} : undefined, stderrTail: stderr.split('\n').slice(-8)};
const reportPath = join(runDir, 'report.json');
writeFileSync(reportPath, JSON.stringify(report, null, 2));
writeFileSync(join(parent, 'latest.json'), JSON.stringify({run: runDir, report: reportPath, ok: report.ok, finishedAt: report.finishedAt}, null, 2));
if (report.ok) { console.log('runner-smoke: PASS'); console.log(`runner-smoke report: ${reportPath}`); }
else { console.error('runner-smoke: FAIL'); console.error(stderr.split('\n').slice(-8).join('\n')); console.error(`runner-smoke report: ${reportPath}`); process.exitCode = 1; }
