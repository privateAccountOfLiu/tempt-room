import test from 'node:test';
import assert from 'node:assert/strict';
import { redactExport } from '../apps/server/src/export-redaction.ts';

test('export redaction removes secret values from text and sensitive keys', () => {
  const result = redactExport({room: {name: 'safe'}, events: [{payload: {message: {text: 'use ' + ['s','k-','abcdefghijklmnopqrstuvwx'].join('') + ' now'}}}, {payload: {authorization: 'Bearer abcdefghijklmnopqrstuvwxyz'}}]});
  assert.equal(result.redactions, 2);
  assert.match((result.value.events[0] as any).payload.message.text, /\[REDACTED\]/);
  assert.equal((result.value.events[1] as any).payload.authorization, '[REDACTED]');
  assert.equal(result.value.room.name, 'safe');
});

test('export redaction preserves artifacts and non-secret fields', () => {
  const result = redactExport({artifacts: [{artifact: {name: 'report.md'}, contentBase64: 'aGVsbG8='}], exportHash: 'a'.repeat(64)});
  assert.equal(result.redactions, 0);
  assert.equal(result.value.artifacts[0].contentBase64, 'aGVsbG8=');
});
