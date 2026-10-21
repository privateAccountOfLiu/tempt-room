#!/usr/bin/env node
/**
 * Keep the Claude Code plugin copy of the room MCP connector byte-identical
 * to the workspace source of truth.
 *
 * The plugin is installed outside this repository, so it may not import
 * workspace-relative paths. It therefore ships a self-contained copy, and this
 * script is the only thing allowed to produce that copy.
 *
 *   node scripts/sync-room-agent-plugin.mjs          # write plugin copy
 *   node scripts/sync-room-agent-plugin.mjs --check  # verify only, non-zero on drift
 *
 * The manifest below is a fixed list of file names. No path is ever taken
 * from an argument, an environment variable or user input.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Fixed manifest: workspace source -> shipped plugin path. */
const MANIFEST = [
  { from: 'scripts/room-agent-mcp.mjs', to: 'plugins/tempt-room-claude/server/room-agent-mcp.mjs' },
];

const check = process.argv.slice(2).includes('--check');
const unknown = process.argv.slice(2).filter(arg => arg !== '--check');
if (unknown.length) {
  console.error(`sync-room-agent-plugin: unknown argument ${unknown[0]}`);
  process.exit(2);
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const report = [];
let drift = 0;

for (const entry of MANIFEST) {
  const source = join(ROOT, entry.from);
  const target = join(ROOT, entry.to);
  const sourceBytes = readFileSync(source);
  const sourceHash = sha256(sourceBytes);

  let targetHash = null;
  let targetBytes = null;
  try {
    if (!statSync(target).isFile()) throw new Error('not a regular file');
    targetBytes = readFileSync(target);
    targetHash = sha256(targetBytes);
  } catch {
    targetHash = null;
  }

  if (targetHash === sourceHash) {
    report.push({ file: entry.to, status: 'in-sync', sha256: sourceHash });
    continue;
  }

  drift += 1;
  if (check) {
    report.push({
      file: entry.to,
      status: targetHash ? 'drift' : 'missing',
      sourceSha256: sourceHash,
      targetSha256: targetHash,
    });
    continue;
  }

  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  const written = readFileSync(target);
  if (sha256(written) !== sourceHash) {
    console.error(`sync-room-agent-plugin: write verification failed for ${entry.to}`);
    process.exit(1);
  }
  report.push({ file: entry.to, status: 'updated', sha256: sourceHash });
}

for (const item of report) {
  console.log(`${item.status.padEnd(8)} ${item.file}${item.sha256 ? ` sha256=${item.sha256.slice(0, 16)}` : ''}`);
}

if (check && drift > 0) {
  console.error(`sync-room-agent-plugin: ${drift} file(s) differ from the workspace source. Run: node scripts/sync-room-agent-plugin.mjs`);
  process.exit(1);
}
console.log(check ? 'sync-room-agent-plugin: check passed' : 'sync-room-agent-plugin: plugin copy is up to date');
