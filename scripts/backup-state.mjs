#!/usr/bin/env node
// Create a consistent local backup of the Tempt Room data directory before an
// upgrade. SQLite `VACUUM INTO` captures one consistent DB snapshot; artifact
// originals/previews, immutable baselines and apply journals are copied with a
// file hash manifest. Pending uploads are intentionally not restored. The owner
// session token is intentionally not copied; browser sessions can be
// re-established from the startup URL.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(process.env.ROOM_STATE_DIR ?? '.state');
const dbPath = join(root, 'room.sqlite');
if (!existsSync(dbPath)) { console.error(`找不到 ${dbPath}`); process.exit(1); }
const backups = join(root, 'backups');
mkdirSync(backups, { recursive: true });
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const target = join(backups, `${stamp}-${randomUUID().slice(0, 6)}`);
const temporary = target;
const snapshot = join(temporary, 'room.sqlite');
const dataDirs = ['artifacts', 'baselines', 'apply'];
mkdirSync(temporary, { recursive: true });

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
async function fileManifest(directory) {
  const files = [];
  const walk = async current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) { await walk(absolute); continue; }
      if (!entry.isFile()) continue;
      const stat = statSync(absolute);
      files.push({ path: relative(temporary, absolute).replaceAll('\\', '/'), size: stat.size, sha256: sha256File(absolute) });
    }
  };
  if (existsSync(directory)) await walk(directory);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}
function eventSeq(db) { const row = db.prepare('SELECT MAX(seq) AS seq FROM events').get(); return Number(row?.seq ?? 0); }

let manifest;
try {
  const db = new DatabaseSync(dbPath);
  try {
    let consistent = false, beforeSeq = 0, afterSeq = 0;
    for (let attempt = 1; attempt <= 3 && !consistent; attempt++) {
      for (const dir of dataDirs) {
        const from = join(root, dir);
        if (existsSync(from)) { rmSync(join(temporary, dir), { recursive: true, force: true }); cpSync(from, join(temporary, dir), { recursive: true }); }
      }
      beforeSeq = eventSeq(db);
      const escaped = snapshot.replaceAll("'", "''");
      db.exec(`VACUUM INTO '${escaped}'`);
      afterSeq = eventSeq(db);
      consistent = beforeSeq === afterSeq;
      if (!consistent) console.error(`backup attempt ${attempt}: events changed while copying files (${beforeSeq} -> ${afterSeq}); retrying`);
    }
    if (!consistent) throw new Error(`无法获得一致快照：复制文件期间事件序列从 ${beforeSeq} 变为 ${afterSeq}`);
    const version = Number(db.prepare('PRAGMA user_version').get().user_version);
    const rooms = Number(db.prepare('SELECT COUNT(*) AS count FROM rooms').get().count);
    const events = Number(db.prepare('SELECT COUNT(*) AS count FROM events').get().count);
    const artifacts = Number(db.prepare('SELECT COUNT(*) AS count FROM artifacts').get().count);
    const pendingUploads = Number(db.prepare("SELECT COUNT(*) AS count FROM image_uploads WHERE state='uploading'").get().count);
    const files = [];
    for (const dir of dataDirs) files.push(...await fileManifest(join(temporary, dir)));
    const snapshotBytes = statSync(snapshot).size;
    manifest = {
      createdAt: new Date().toISOString(),
      source: root,
      userVersion: version,
      rooms,
      events,
      artifacts,
      snapshot: {eventSeq: afterSeq, snapshotBytes},
      consistency: {watermarkEventSeq: afterSeq, filesCopiedEventsThrough: beforeSeq, consistent},
      files,
      fileCount: files.length,
      fileBytes: files.reduce((sum, file) => sum + file.size, 0),
      omittedPendingUploads: pendingUploads,
      restoredDataDirs: dataDirs.filter(dir => existsSync(join(temporary, dir))),
      note: 'pending image uploads are not restored; completed artifact files are copied and hashed'
    };
    writeFileSync(join(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2));
  } finally { db.close(); }
} catch (error) {
  try { rmSync(temporary, { recursive: true, force: true }); } catch { /* best effort */ }
  console.error(`备份失败：${error.message}`);
  process.exit(1);
}
console.log(`backup: ${target}`);
console.log(`user_version=${manifest.userVersion} rooms=${manifest.rooms} events=${manifest.events} artifactRows=${manifest.artifacts} files=${manifest.fileCount} snapshot=${(manifest.snapshot.snapshotBytes / 1024).toFixed(1)} KiB`);
console.log(`watermark=${manifest.consistency.watermarkEventSeq} omittedPendingUploads=${manifest.omittedPendingUploads}`);
try {
  const entries = readdirSync(backups).filter(name => {
    try { return statSync(join(backups, name)).isDirectory() && existsSync(join(backups, name, 'manifest.json')); } catch { return false; }
  }).sort().reverse();
  for (const old of entries.slice(5)) rmSync(join(backups, old), { recursive: true, force: true });
} catch { /* best effort retention */ }
