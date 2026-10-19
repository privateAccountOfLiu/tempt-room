#!/usr/bin/env node
// Create a consistent local backup of the Tempt Room data directory before an
// upgrade. Uses SQLite `VACUUM INTO` so the running server's WAL is captured as
// one consistent snapshot, then copies the artifact blobs and writes a manifest.
// Keeps the five newest backups. The owner session token is intentionally not
// copied; browser sessions can be re-established from the startup URL.
import { DatabaseSync } from 'node:sqlite';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.env.ROOM_STATE_DIR ?? '.state');
const dbPath = join(root, 'room.sqlite');
if (!existsSync(dbPath)) { console.error(`找不到 ${dbPath}`); process.exit(1); }
const backups = join(root, 'backups');
mkdirSync(backups, { recursive: true });
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const target = join(backups, stamp);
mkdirSync(target, { recursive: true });
const snapshot = join(target, 'room.sqlite');
const db = new DatabaseSync(dbPath);
let manifest;
try {
  const escaped = snapshot.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  const version = Number((db.prepare('PRAGMA user_version').get()).user_version);
  const rooms = Number((db.prepare('SELECT COUNT(*) AS count FROM rooms').get()).count);
  const events = Number((db.prepare('SELECT COUNT(*) AS count FROM events').get()).count);
  const artifacts = Number((db.prepare('SELECT COUNT(*) AS count FROM artifacts').get()).count);
  manifest = { createdAt: new Date().toISOString(), source: root, userVersion: version, rooms, events, artifacts };
} catch (error) {
  console.error(`数据库快照失败：${error.message}`);
  process.exit(1);
} finally { db.close(); }
const artifactDir = join(root, 'artifacts');
if (existsSync(artifactDir)) cpSync(artifactDir, join(target, 'artifacts'), { recursive: true });
const snapshotBytes = statSync(snapshot).size;
writeFileSync(join(target, 'manifest.json'), JSON.stringify({ ...manifest, snapshotBytes }, null, 2));
console.log(`backup: ${target}`);
console.log(`user_version=${manifest.userVersion} rooms=${manifest.rooms} events=${manifest.events} artifactRows=${manifest.artifacts} snapshot=${(snapshotBytes / 1024).toFixed(1)} KiB`);
try {
  const entries = readdirSync(backups).filter(name => {
    try { return statSync(join(backups, name)).isDirectory(); } catch { return false; }
  }).sort().reverse();
  for (const old of entries.slice(5)) rmSync(join(backups, old), { recursive: true, force: true });
} catch { /* best effort retention */ }
