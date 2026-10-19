import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadOrCreateOwnerToken, readOwnerToken, OWNER_TOKEN_FILE } from '../apps/server/src/session-token.ts';

test('owner session token persists across restarts and can be rotated explicitly', () => {
  const base = resolve('.state/test-data'); mkdirSync(base, {recursive: true});
  const root = mkdtempSync(join(base, 'session-token-'));
  try {
    const first = loadOrCreateOwnerToken(root);
    assert.equal(first.created, true);
    assert.equal(first.rotated, false);
    assert.match(first.token, /^[0-9a-f]{64}$/);
    assert.equal(readFileSync(join(root, OWNER_TOKEN_FILE), 'utf8').trim(), first.token);

    assert.equal(readOwnerToken(root), first.token);
    const restarted = loadOrCreateOwnerToken(root);
    assert.equal(restarted.token, first.token);
    assert.equal(restarted.created, false);
    assert.equal(restarted.rotated, false);

    const rotated = loadOrCreateOwnerToken(root, { rotate: true });
    assert.equal(rotated.rotated, true);
    assert.notEqual(rotated.token, first.token);
    assert.equal(loadOrCreateOwnerToken(root).token, rotated.token);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('invalid token files are regenerated instead of trusted', () => {
  const base = resolve('.state/test-data'); mkdirSync(base, {recursive: true});
  const root = mkdtempSync(join(base, 'session-token-invalid-'));
  try {
    writeFileSync(join(root, OWNER_TOKEN_FILE), 'not-a-valid-token');
    assert.equal(readOwnerToken(root), undefined);
    const loaded = loadOrCreateOwnerToken(root);
    assert.match(loaded.token, /^[0-9a-f]{64}$/);
    assert.notEqual(loaded.token, 'not-a-valid-token');
    assert.equal(readFileSync(join(root, OWNER_TOKEN_FILE), 'utf8').trim(), loaded.token);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
