import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { createApp } from '../apps/server/src/app.ts';
import { DATABASE_VERSION } from '../apps/server/src/store.ts';

test('backup command captures a consistent snapshot and restore command applies it', async t => {
  const base = resolve('.state/test-data'); mkdirSync(base, { recursive: true });
  const source = mkdtempSync(join(base, 'backup-source-'));
  const target = mkdtempSync(join(base, 'backup-target-'));
  t.after(() => {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });
  const project = resolve('.');
  const { app } = await createApp({ root: source, token: 'backup-test', startWorker: false });
  await app.close();
  const env = { ...process.env, ROOM_STATE_DIR: source };
  const backup = spawnSync(process.execPath, [join(project, 'scripts', 'backup-state.mjs')], { cwd: project, env, encoding: 'utf8' });
  assert.equal(backup.status, 0, backup.stderr);
  const backupsDir = join(source, 'backups');
  assert.equal(existsSync(backupsDir), true);
  const stamp = readdirSync(backupsDir).filter(name => existsSync(join(backupsDir, name, 'room.sqlite'))).sort().at(-1);
  assert.ok(stamp);
  assert.equal(existsSync(join(backupsDir, stamp!, 'manifest.json')), true);
  const snapshot = new DatabaseSync(join(backupsDir, stamp!, 'room.sqlite'), { readOnly: true });
  const snapshotRooms = Number((snapshot.prepare('SELECT COUNT(*) AS count FROM rooms').get() as any).count);
  snapshot.close();
  mkdirSync(join(target, 'backups'), { recursive: true });
  cpSync(join(backupsDir, stamp!), join(target, 'backups', stamp!), { recursive: true });
  const restore = spawnSync(process.execPath, [join(project, 'scripts', 'restore-state.mjs'), '--latest'], { cwd: project, env: { ...process.env, ROOM_STATE_DIR: target }, encoding: 'utf8' });
  assert.equal(restore.status, 0, restore.stderr);
  const restored = new DatabaseSync(join(target, 'room.sqlite'), { readOnly: true });
  try {
    assert.equal(Number((restored.prepare('PRAGMA user_version').get() as any).user_version), DATABASE_VERSION);
    assert.equal(Number((restored.prepare('SELECT COUNT(*) AS count FROM rooms').get() as any).count), snapshotRooms);
  } finally { restored.close(); }
});
