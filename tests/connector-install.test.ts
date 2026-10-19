import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planProjectMcp, removeCodexSection, removeDshProfile, removeProjectMcp, upsertCodexConfig, upsertDshProfile, upsertProjectMcp } from '../apps/server/src/connector-install.ts';

const roomBlock = ['[mcp_servers.room]', 'command = "node"', 'args = ["bridge.mjs"]', '', '[mcp_servers.room.env]', 'ROOM_ROOM_ID = "room_1"'].join('\n');

test('Codex config merge preserves other MCP servers and replaces the room section', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tempt-cfg-'));
  try {
    const file = join(dir, 'config.toml');
    writeFileSync(file, ['model = "x"', '', '[mcp_servers.other]', 'command = "other.exe"', ''].join('\n'));
    upsertCodexConfig(file, roomBlock);
    let text = readFileSync(file, 'utf8');
    assert.match(text, /model = "x"/);
    assert.match(text, /\[mcp_servers\.other\]/);
    assert.match(text, /\[mcp_servers\.room\]/);
    assert.match(text, /ROOM_ROOM_ID = "room_1"/);
    upsertCodexConfig(file, roomBlock.replace('room_1', 'room_2'));
    text = readFileSync(file, 'utf8');
    assert.equal((text.match(/\[mcp_servers\.room\]/g) ?? []).length, 1);
    assert.match(text, /room_2/);
    assert.doesNotMatch(text, /room_1/);
    const removed = removeCodexSection(file);
    assert.equal(removed.changed, true);
    text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /mcp_servers\.room/);
    assert.match(text, /\[mcp_servers\.other\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DSH acp patch is only overwritten when empty/comment-only or already managed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tempt-dsh-'));
  try {
    const file = join(dir, 'cordis.patch.yml');
    writeFileSync(file, '# comment layer\n[]\n');
    upsertDshProfile(file, '- insert: []');
    let text = readFileSync(file, 'utf8');
    assert.match(text, /tempt-room managed/);
    assert.match(text, /- insert: \[\]/);
    assert.equal(removeDshProfile(file).changed, true);
    assert.match(readFileSync(file, 'utf8'), /\[\]/);
    writeFileSync(file, '- insert:\n    - id: custom\n');
    assert.throws(() => upsertDshProfile(file, '- insert: []'), /已有自定义内容/);
    assert.match(readFileSync(file, 'utf8'), /custom/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('project .mcp.json merge preserves other servers and can be removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tempt-mcp-'));
  try {
    const file = join(dir, '.mcp.json');
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'other.exe' } }, custom: true }, null, 2));
    const plan = planProjectMcp(file, 'room', { command: 'node', args: ['bridge.mjs'] });
    assert.equal(plan.exists, true);
    const written = upsertProjectMcp(file, 'room', { command: 'node', args: ['bridge.mjs'] });
    assert.equal(written.changed, true);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(data.custom, true);
    assert.deepEqual(data.mcpServers.other, { command: 'other.exe' });
    assert.deepEqual(data.mcpServers.room, { command: 'node', args: ['bridge.mjs'] });
    assert.ok(written.backup);
    const removed = removeProjectMcp(file, 'room');
    assert.equal(removed.changed, true);
    const after = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(after.mcpServers.room, undefined);
    assert.deepEqual(after.mcpServers.other, { command: 'other.exe' });
    assert.equal(removeProjectMcp(file, 'room').changed, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('project .mcp.json invalid JSON is refused without writing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tempt-mcp-'));
  try {
    const file = join(dir, '.mcp.json');
    writeFileSync(file, '{ broken');
    assert.throws(() => upsertProjectMcp(file, 'room', { command: 'node' }), /不是合法 JSON/);
    assert.equal(readFileSync(file, 'utf8'), '{ broken');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});