#!/usr/bin/env node
// Restore a Tempt Room data directory from a `npm run backup` snapshot.
// Refuses to run while a live service holds the state directory lock.
//
//   npm run restore -- --latest
//   npm run restore -- --backup .state/backups/<timestamp>
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const root = resolve(process.env.ROOM_STATE_DIR ?? '.state');
const lockPath = join(root, 'server.lock');
if (existsSync(lockPath)) {
  let alive = true;
  try { JSON.parse(readFileSync(lockPath, 'utf8')); } catch { alive = false; }
  if (alive) {
    try { process.kill(JSON.parse(readFileSync(lockPath, 'utf8')).pid, 0); } catch (error) { if (error?.code === 'ESRCH') alive = false; }
  }
  if (alive) { console.error('Tempt Room 正在运行；请先停止服务再恢复数据。'); process.exit(1); }
}
const backups = join(root, 'backups');
let backup = flag('--backup');
if (!backup || args.includes('--latest')) {
  if (!existsSync(backups)) { console.error('没有找到 .state/backups；请先运行 npm run backup'); process.exit(1); }
  const latest = readdirSync(backups).filter(name => { try { return statSync(join(backups, name)).isDirectory() && existsSync(join(backups, name, 'room.sqlite')); } catch { return false; } }).sort().reverse()[0];
  if (!latest) { console.error('备份目录中没有可用快照'); process.exit(1); }
  backup = join(backups, latest);
}
backup = resolve(backup);
const snapshotPath = join(backup, 'room.sqlite');
if (!existsSync(snapshotPath)) { console.error(`备份缺少 room.sqlite：${backup}`); process.exit(1); }
const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
let info;
try { info = { userVersion: Number(snapshot.prepare('PRAGMA user_version').get().user_version), rooms: Number(snapshot.prepare('SELECT COUNT(*) AS count FROM rooms').get().count) }; }
catch (error) { console.error(`备份数据库不可读：${error.message}`); process.exit(1); }
finally { snapshot.close(); }

mkdirSync(root, { recursive: true });
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const dbPath = join(root, 'room.sqlite');
if (existsSync(dbPath)) {
  const previous = join(root, `room.sqlite.pre-restore.${stamp}`);
  renameSync(dbPath, previous);
  console.log(`已把当前数据库移到：${previous}`);
}
for (const suffix of ['-wal', '-shm']) { try { rmSync(dbPath + suffix, { force: true }); } catch { /* best effort */ } }
copyFileSync(snapshotPath, dbPath);
if (existsSync(join(backup, 'artifacts'))) {
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  cpSync(join(backup, 'artifacts'), join(root, 'artifacts'), { recursive: true });
}
const restored = new DatabaseSync(dbPath, { readOnly: true });
try { console.log(`restore: ${backup}`); console.log(`restored user_version=${restored.prepare('PRAGMA user_version').get().user_version} rooms=${restored.prepare('SELECT COUNT(*) AS count FROM rooms').get().count} (backup had user_version=${info.userVersion} rooms=${info.rooms})`); }
finally { restored.close(); }
