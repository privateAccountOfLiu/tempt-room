#!/usr/bin/env node
// Start Tempt Room in development mode and open the app in the default browser.
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const child = spawn(npm, ['run', 'dev'], {
  cwd: process.cwd(),
  env: { ...process.env, ROOM_OPEN_BROWSER: '1' },
  stdio: 'inherit',
  shell: process.platform === 'win32',
  windowsHide: false
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
