#!/usr/bin/env node
// Local release secret scan: walk source/documentation files (never .state,
// node_modules, dist, .git or client configs) and fail on credential-looking
// strings. The room token in .mcp.json is intentionally excluded because it is
// local-only and gitignored.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const project = resolve('.');
const skipDirs = new Set(['.git', '.state', '.cache', '.claude', 'node_modules', 'dist', 'obj', 'bin', 'TestResults', 'artifacts']);
const textExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.toml', '.ps1', '.css', '.html', '.sql', '.cs', '.example', '.txt']);
const rules = [
  {name: 'api-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g},
  {name: 'room-agent-token', pattern: /\b[a-zA-Z0-9_-]+\.v1\.room_[a-f0-9]{32}\.[a-f0-9]{64}\b/g},
  {name: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g},
  {name: 'anthropic-token', pattern: /\bANTHROPIC_AUTH_TOKEN\s*[:=]\s*['"]?[A-Za-z0-9_-]{24,}/g}
];
const findings = [];
function scan(file) {
  let text;
  try {
    if (statSync(file).size > 2 * 1024 * 1024) return;
    text = readFileSync(file, 'utf8');
  } catch { return; }
  for (const rule of rules) {
    for (const match of text.matchAll(rule.pattern)) {
      findings.push({file: relative(project, file).replaceAll('\\', '/'), rule: rule.name, match: `${match[0].slice(0, 8)}…(${match[0].length})`});
    }
  }
}
function walk(directory) {
  let entries;
  try { entries = readdirSync(directory, {withFileTypes: true}); } catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory()) { if (!skipDirs.has(entry.name)) walk(join(directory, entry.name)); continue; }
    if (!entry.isFile() || entry.name === '.mcp.json') continue;
    if (textExtensions.has((entry.name.match(/\.[^.]+$/) ?? [''])[0].toLowerCase())) scan(join(directory, entry.name));
  }
}
walk(project);
const parent = join(project, '.state', 'secret-scan');
mkdirSync(parent, {recursive: true});
const report = {checkedAt: new Date().toISOString(), ok: findings.length === 0, scannedRoot: project, findings};
const reportPath = join(parent, 'latest.json');
writeFileSync(reportPath, JSON.stringify(report, null, 2));
for (const finding of findings) console.error(`secret-scan: ${finding.file} [${finding.rule}] ${finding.match}`);
console.log(`secret-scan: ${findings.length === 0 ? 'PASS' : 'FAIL'} (${findings.length} finding(s))`);
console.log(`secret-scan report: ${reportPath}`);
if (findings.length) process.exitCode = 1;
