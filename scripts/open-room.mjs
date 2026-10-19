#!/usr/bin/env node
// Open the running Tempt Room in the default browser without restarting it.
//   npm run open            # open the current startup URL
//   npm run open -- --print # print the URL only (no browser launch)
import {existsSync, readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';

const args = process.argv.slice(2);
const root = resolve(process.env.ROOM_STATE_DIR ?? '.state');
const port = Number(process.env.ROOM_PORT ?? 4317);
const lockPath = resolve(root, 'server.lock');
const tokenPath = resolve(root, 'owner-session.token');
const fail = message => { console.error(message); process.exit(1); };

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== 'ESRCH'; }
}
let pid;
try { pid = JSON.parse(readFileSync(lockPath, 'utf8')).pid; } catch { fail(`Tempt Room 未在运行：找不到 ${lockPath}；请先执行 npm run dev`); }
if (!alive(pid)) fail(`Tempt Room 未在运行：锁文件中的进程 ${pid} 已退出；请重新执行 npm run dev`);
let token;
try { token = readFileSync(tokenPath, 'utf8').trim(); } catch { fail(`找不到持久化会话令牌 ${tokenPath}；请从终端启动地址打开`); }
if (!/^[0-9a-f]{64}$/.test(token)) fail('持久化会话令牌格式不正确；请从终端启动地址打开');
const url = `http://127.0.0.1:${port}/#session=${token}`;
if (args.includes('--print')) { console.log(url); process.exit(0); }
try {
  if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '', url], {detached: true, stdio: 'ignore', windowsHide: true}).unref();
  else if (process.platform === 'darwin') spawn('open', [url], {detached: true, stdio: 'ignore'}).unref();
  else spawn('xdg-open', [url], {detached: true, stdio: 'ignore'}).unref();
  console.log(`已在默认浏览器打开 Tempt Room（PID ${pid}，端口 ${port}）。`);
} catch (error) { fail(`打开浏览器失败：${error.message}`); }
