import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readAsarVersion } from '../apps/server/src/runtime.ts';

function makeAsar(manifest: object): Buffer {
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const header = Buffer.from(JSON.stringify({ files: { 'package.json': { size: manifestBytes.length, offset: '0' } } }));
  const meta = Buffer.alloc(16);
  meta.writeUInt32LE(4, 0);
  meta.writeUInt32LE(header.length + 8, 4);
  meta.writeUInt32LE(header.length + 4, 8);
  meta.writeUInt32LE(header.length, 12);
  return Buffer.concat([meta, header, manifestBytes]);
}

test('readAsarVersion reads the packaged package.json without extracting', async t => {
  const base = resolve('.state/test-data'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'asar-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'app.asar');
  writeFileSync(file, makeAsar({ name: '@deepseek-ai/dsh-desktop', version: '1.2.3' }));
  assert.equal(await readAsarVersion(file), '1.2.3');
  writeFileSync(file, Buffer.concat([Buffer.alloc(16), Buffer.from('not-json')]));
  assert.equal(await readAsarVersion(file), undefined);
  assert.equal(await readAsarVersion(join(root, 'missing.asar')), undefined);
});
