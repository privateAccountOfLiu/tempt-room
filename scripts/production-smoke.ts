// Production-build local startup smoke test.
// Verifies that the built server (dist/server/main.js + dist/web) starts with an
// isolated state directory, serves the SPA and CSP, authenticates owner/API,
// streams WebSocket events, persists a message, shuts down gracefully and leaves
// a usable SQLite database with the expected schema version.
//
// Run: npm run build && npm run test:production
import {spawn, type ChildProcess} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import WebSocket from 'ws';

interface StepReport { name: string; at: string; detail?: Record<string, unknown> }
const project = resolve('.');
const parent = join(project, '.state', 'production-smoke');
mkdirSync(parent, {recursive: true});
const runDir = mkdtempSync(join(parent, 'run-'));
const stateRoot = join(runDir, 'state');
const report: {startedAt: string; finishedAt?: string; ok: boolean; skipped?: boolean; error?: string; steps: StepReport[]; stdoutPath?: string; stderrPath?: string} = {startedAt: new Date().toISOString(), ok: false, steps: []};
const reportPath = join(runDir, 'report.json');
const step = (name: string, detail?: Record<string, unknown>) => { report.steps.push({name, at: new Date().toISOString(), ...(detail ? {detail} : {})}); console.log(`${name}: PASS`); };
const sleep = (ms: number) => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
function fail(message: string): never { throw new Error(message); }
async function waitFor<T>(label: string, action: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 30000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try { const value = await action(); if (value) return value; }
    catch (error) { last = error; }
    await sleep(200);
  }
  throw new Error(`等待超时：${label}${last instanceof Error ? `（最后错误：${last.message}）` : ''}`);
}
async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('无法分配端口'));
      server.close(() => resolvePort(address.port));
    });
  });
}

let child: ChildProcess | undefined;
let replacement: ChildProcess | undefined;
let socket: WebSocket | undefined;
try {
  const distServer = join(project, 'dist', 'server', 'main.js');
  const distWeb = join(project, 'dist', 'web', 'index.html');
  if (!existsSync(distServer) || !existsSync(distWeb)) fail('缺少生产构建产物，请先运行 npm run build');
  const port = await freePort();
  mkdirSync(stateRoot, {recursive: true});
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA,
    ROOM_STATE_DIR: stateRoot, ROOM_PORT: String(port)
  };
  child = spawn(process.execPath, [distServer], {cwd: project, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  report.stdoutPath = join(runDir, 'stdout.log');
  report.stderrPath = join(runDir, 'stderr.log');
  const token = await waitFor('生产服务启动令牌', () => { const match = stdout.match(/#session=([0-9a-f]{64})/); return match?.[1]; }, 30000)
    .catch(error => { throw new Error(`${error.message}；stderr=${stderr.slice(-1500)}`); });
  writeFileSync(report.stdoutPath, stdout); writeFileSync(report.stderrPath, stderr);
  step('server-started-with-build', {port, stateRoot});

  const base = `http://127.0.0.1:${port}`;
  const headers = {authorization: `Bearer ${token}`, 'room-protocol-version': '0.1', 'content-type': 'application/json'};
  const rooms = await waitFor('GET /api/rooms', async () => {
    const response = await fetch(`${base}/api/rooms`, {headers});
    if (!response.ok) return false;
    const value = await response.json() as Array<{id: string; name: string}>;
    return value.length ? value : false;
  });
  const roomId = rooms[0].id;
  step('api-authenticated', {roomId, rooms: rooms.length});

  const unauthorized = await fetch(`${base}/api/rooms`);
  if (unauthorized.status !== 401) fail(`未认证访问 /api/rooms 应返回 401，实际 ${unauthorized.status}`);
  step('api-rejects-unauthenticated');

  const home = await fetch(`${base}/`, {headers});
  const html = await home.text();
  if (!home.ok || !html.includes('id="root"')) fail('生产静态页面未正常返回 index.html');
  const csp = home.headers.get('content-security-policy') ?? '';
  if (!csp.includes("script-src 'self'")) fail('生产模式缺少 CSP 响应头');
  step('static-spa-and-csp', {htmlBytes: html.length, csp: csp.slice(0, 120)});

  socket = new WebSocket(`ws://127.0.0.1:${port}/api/events`, ['room.v0.1', `room-token.${token}`]);
  await new Promise<void>((resolveOpen, reject) => { socket!.once('open', () => resolveOpen()); socket!.once('error', reject); });
  const received: any[] = [];
  socket.on('message', raw => { try { received.push(JSON.parse(raw.toString())); } catch { /* ignore malformed */ } });
  socket.send(JSON.stringify({version: '0.1', roomId, after: 0, clientType: 'sdk'}));
  await waitFor('WebSocket 订阅确认', () => received.some(frame => frame.type === 'subscribed'), 10000);
  const text = `生产冒烟消息 ${Date.now()}`;
  const command = await fetch(`${base}/api/commands`, {method: 'POST', headers, body: JSON.stringify({version: '0.1', commandId: randomUUID(), roomId, type: 'message.send', payload: {text}})});
  if (!command.ok) fail(`消息命令失败：${command.status} ${await command.text()}`);
  await waitFor('WebSocket 收到消息事件', () => received.some(frame => frame.type === 'chat.message.created' && frame.payload?.message?.text === text), 10000);
  const snapshot = await (await fetch(`${base}/api/rooms/${roomId}`, {headers})).json() as {messages: Array<{text: string}>};
  if (!snapshot.messages.some(message => message.text === text)) fail('消息没有持久化到房间快照');
  step('websocket-event-and-persistence', {text});

  // The browser session must survive a service restart: owner token is persisted
  // in the state directory and the cookie is long-lived.
  const login = await fetch(`${base}/api/session`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({token})});
  if (!login.ok) fail(`创建本地会话失败：${login.status}`);
  const sessionCookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  if (!sessionCookie.startsWith('room_session_')) fail('本地会话响应缺少 room_session Cookie');
  step('session-cookie-issued', {httpOnly: /HttpOnly/i.test(login.headers.get('set-cookie') ?? ''), maxAge: /Max-Age=2592000/.test(login.headers.get('set-cookie') ?? '')});

  const exited = new Promise<{code: number | null; signal: NodeJS.Signals | null}>(resolveExit => child!.once('exit', (code, signal) => resolveExit({code, signal})));
  child.kill('SIGTERM');
  const exit = await Promise.race([exited, sleep(15000).then(() => fail('生产服务未在 15 秒内退出'))]) as {code: number | null; signal: NodeJS.Signals | null};
  child = undefined;
  const lockPath = join(stateRoot, 'server.lock');
  if (process.platform === 'win32') {
    // Windows external SIGTERM terminates the process without running Node signal handlers.
    if (exit.code !== null && exit.code !== 0) fail(`生产服务退出码异常：${JSON.stringify(exit)}`);
    await waitFor('终止后端口释放', async () => {
      try { await fetch(`${base}/api/rooms`, {headers, signal: AbortSignal.timeout(800)}); return false; }
      catch { return true; }
    }, 10000);
    step('forced-termination-on-windows', {exitCode: exit.code, signal: exit.signal});
    // Restart against the same state directory to prove stale-lock recovery works.
    const secondPort = await freePort();
    let secondStdout = '';
    replacement = spawn(process.execPath, [distServer], {cwd: project, env: {...env, ROOM_PORT: String(secondPort)}, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    replacement.stdout?.on('data', chunk => { secondStdout += chunk.toString(); });
    const secondToken = await waitFor('重启后启动令牌', () => secondStdout.match(/#session=([0-9a-f]{64})/)?.[1], 30000);
    if (secondToken !== token) fail('重启后启动令牌应保持不变（本地会话持久化），否则浏览器会提示会话过期');
    const secondBase = `http://127.0.0.1:${secondPort}`;
    const cookieRooms = await fetch(`${secondBase}/api/rooms`, {headers: {cookie: sessionCookie, 'room-protocol-version': '0.1'}});
    if (cookieRooms.status !== 200) fail(`重启后旧浏览器 Cookie 应保持有效，实际 ${cookieRooms.status}`);
    step('persisted-session-after-restart', {tokenStable: true, cookieStatus: cookieRooms.status});
    const secondRooms = await waitFor('重启后 API', async () => {
      const response = await fetch(`${secondBase}/api/rooms`, {headers: {authorization: `Bearer ${secondToken}`, 'room-protocol-version': '0.1'}});
      if (!response.ok) return false;
      const value = await response.json() as unknown[];
      return value.length ? value : false;
    }, 15000);
    step('stale-lock-recovery-after-restart', {port: secondPort, rooms: secondRooms.length});
    const secondExited = new Promise<void>(resolveSecond => replacement!.once('exit', () => resolveSecond()));
    replacement.kill('SIGTERM');
    await secondExited;
    replacement = undefined;
  } else {
    if (exit.code !== 0) fail(`生产服务退出码异常：${JSON.stringify(exit)}`);
    if (existsSync(lockPath)) fail('优雅退出后仍残留 server.lock');
    step('graceful-shutdown', {exitCode: exit.code});
  }

  const dbPath = join(stateRoot, 'room.sqlite');
  if (!existsSync(dbPath)) fail('没有生成 room.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    const versionRow = db.prepare('PRAGMA user_version').get() as {user_version?: number};
    const countRow = db.prepare('SELECT COUNT(*) AS count FROM rooms').get() as {count?: number};
    if (versionRow.user_version !== 7) fail(`数据库 user_version 应为 7，实际 ${versionRow.user_version}`);
    if ((countRow.count ?? 0) < 1) fail('数据库中没有房间记录');
    step('database-schema-and-data', {userVersion: versionRow.user_version, rooms: countRow.count});
  } finally { db.close(); }
  report.ok = true;
  console.log('production-smoke: PASS');
} catch (error) {
  report.ok = false;
  report.error = (error as Error).message;
  console.error(`production-smoke: FAIL - ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  writeFileSync(join(parent, 'latest.json'), JSON.stringify({run: runDir, report: reportPath, ok: report.ok, finishedAt: report.finishedAt}, null, 2));
  console.log(`production-smoke report: ${reportPath}`);
  try { socket?.close(); } catch { /* already closed */ }
  try { if (child && child.exitCode === null) { child.kill('SIGTERM'); } } catch { /* already exited */ }
  try { if (replacement && replacement.exitCode === null) { replacement.kill('SIGTERM'); } } catch { /* already exited */ }
  try {
    const runs = readdirSync(parent).filter(name => name.startsWith('run-')).map(name => ({name, path: join(parent, name), mtime: statSync(join(parent, name)).mtimeMs}));
    for (const old of runs.sort((a, b) => b.mtime - a.mtime).slice(5)) {
      try { rmSync(old.path, {recursive: true, force: true}); } catch { /* best effort */ }
    }
  } catch { /* best effort cleanup only */ }
}
