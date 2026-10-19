import { mkdir, writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { SandboxHost } from '../apps/server/src/sandbox.ts';
const root = resolve(process.env.ROOM_STATE_DIR??'.state'); await mkdir(root, { recursive: true });
const host = new SandboxHost(root, resolve('sandbox/RoomSandbox/bin/Release/net10.0-windows/RoomSandbox.exe'));
try { const report = await host.probe(true); await mkdir(join(root,'diagnostics'), { recursive: true }); await writeFile(join(root,'diagnostics','sandbox.json'), JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2)); if (!report.ready) process.exitCode=1; }
finally { host.close(); }
