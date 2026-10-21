#!/usr/bin/env node
// Optional Windows Job Object launcher build. The Tempt Room host path uses
// .state/tools/job-launcher.exe when present and otherwise falls back to
// taskkill + CIM process-tree scanning. Dotnet is therefore an optional build
// dependency, not a runtime dependency.
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const checkOnly = process.argv.includes('--check');
const required = process.env.ROOM_JOB_LAUNCHER_REQUIRED === '1';
const executable = resolve('.state/tools/job-launcher.exe');
const dotnet = process.env.ROOM_DOTNET || 'dotnet';

function reportBuilt() {
  const size = statSync(executable).size;
  console.log(`job-launcher: built (${executable}, ${size} bytes)`);
}
function fallback(message) {
  console.warn(`job-launcher: fallback to taskkill+CIM (${message})`);
  if (required) process.exit(1);
}

if (existsSync(executable)) { reportBuilt(); if (checkOnly) process.exit(0); }
else if (checkOnly) { fallback('not built'); process.exit(0); }

const version = spawnSync(dotnet, ['--version'], {encoding: 'utf8', windowsHide: true});
if (version.error || version.status !== 0) {
  fallback(`dotnet SDK unavailable: ${version.error?.message ?? `exit ${version.status}`}`);
  process.exit(0);
}

console.log(`job-launcher: building with dotnet ${version.stdout.trim()}`);
const build = spawnSync(dotnet, ['publish', 'tools/job-launcher', '-c', 'Release', '-o', '.state/tools', '--nologo'], {stdio: 'inherit', windowsHide: true});
if (build.error || build.status !== 0) {
  fallback(`dotnet publish failed: ${build.error?.message ?? `exit ${build.status}`}`);
  process.exit(0);
}
if (!existsSync(executable)) {
  fallback('publish reported success but executable is missing');
  process.exit(0);
}
reportBuilt();
