import { existsSync, readdirSync,statSync } from 'node:fs';
import { join,delimiter } from 'node:path';

export interface DetectedExecutables {
  claude?: string;
  deepseek?: string;
  codex?: string;
  node: string;
}

const firstExisting = (paths: (string | undefined)[]) => paths.find(path => path && existsSync(path));
const pathExecutable=(name:string)=>firstExisting((process.env.PATH??'').split(delimiter).filter(Boolean).map(root=>join(root.replaceAll('"',''),name)));

/** Program-directory candidates across every drive, because apps may live on D: or elsewhere. */
function programRoots(): string[] {
  const roots = new Set<string>();
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432'] as const) { const value = process.env[key]; if (value) roots.add(value); }
  for (let code = 65; code <= 90; code++) {
    const drive = String.fromCharCode(code) + ':';
    for (const dir of ['Program Files', 'Program Files (x86)']) roots.add(join(drive + '\\', dir));
  }
  return [...roots];
}

/**
 * Best-effort discovery of locally installed Agent programs so a user does not
 * have to hand-type executable paths. Read-only: nothing is executed here.
 */
export function detectLocalExecutables(): DetectedExecutables {
  const home = process.env.USERPROFILE ?? 'C:\\Users\\Default';
  const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
  const programDirs = programRoots();

  let claude: string | undefined;
  const claudeRoot = join(local, 'Claude-3p', 'claude-code');
  try {
    const versions = readdirSync(claudeRoot).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) { const candidate = join(claudeRoot, version, 'claude.exe'); if (existsSync(candidate)) { claude = candidate; break; } }
  } catch { /* Claude Code CLI not installed this way */ }

  const deepseek = firstExisting([
    ...programDirs.map(root => join(root, 'Deepseek Harness', 'DeepSeek Harness.exe')),
    join(local, 'Programs', 'Deepseek Harness', 'DeepSeek Harness.exe'),
    join(local, 'Deepseek Harness', 'DeepSeek Harness.exe')
  ]);
  // Desktop CLI versions live in content-named bin subdirectories. Hash names
  // are not versions; prefer PATH, otherwise the newest installed file.
  let desktopCodex:string|undefined;
  try{desktopCodex=readdirSync(join(local,'OpenAI','Codex','bin')).map(entry=>join(local,'OpenAI','Codex','bin',entry,'codex.exe')).filter(path=>existsSync(path)&&statSync(path).isFile()).sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs)[0];}catch{}
  const codex = pathExecutable('codex.exe')??firstExisting([
    desktopCodex,
    join(local, 'Programs', 'OpenAI', 'Codex', 'codex.exe'),
    ...programDirs.map(root => join(root, 'OpenAI', 'Codex', 'codex.exe'))
  ]);
  return { claude, deepseek, codex, node: process.execPath };
}
