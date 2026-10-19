import test from 'node:test';
import assert from 'node:assert/strict';
import { openCommand } from '../apps/server/src/open-browser.ts';

test('browser open command is platform-specific and supports an explicit override', () => {
  assert.deepEqual(openCommand('http://127.0.0.1:4317/#session=x', 'win32', ''), { command: 'cmd.exe', args: ['/c', 'start', '', 'http://127.0.0.1:4317/#session=x'] });
  assert.deepEqual(openCommand('http://127.0.0.1:4317/', 'darwin', ''), { command: 'open', args: ['http://127.0.0.1:4317/'] });
  assert.deepEqual(openCommand('http://127.0.0.1:4317/', 'linux', ''), { command: 'xdg-open', args: ['http://127.0.0.1:4317/'] });
  assert.deepEqual(openCommand('http://127.0.0.1:4317/', 'linux', '/tmp/fake-browser'), { command: '/tmp/fake-browser', args: ['http://127.0.0.1:4317/'] });
});
