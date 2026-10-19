import { spawn } from 'node:child_process';

/** Parse the version printed by `codex --version` (e.g. "codex-cli 0.163.0-alpha.10.2"). */
export function parseCodexVersion(output: string): string | undefined {
  const match = String(output).match(/\bcodex(?:-cli| cli)?\s+v?([0-9][0-9A-Za-z.+\-]*)/i);
  return match?.[1];
}

/** Parse the version printed by `claude --version` (e.g. "2.1.271 (Claude Code)"). */
export function parseClaudeVersion(output: string): string | undefined {
  const match = String(output).match(/([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.\-]+)?)/);
  return match?.[1];
}

function probe(executable: string, parse: (output: string) => string | undefined, timeoutMs: number): Promise<string | undefined> {
  return new Promise(resolve => {
    let output = '';
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (value?: string) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { try { child?.kill(); } catch { /* best effort */ } finish(undefined); }, timeoutMs);
    try {
      child = spawn(executable, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.on('data', chunk => { output = (output + String(chunk)).slice(-4096); });
      child.stderr?.on('data', chunk => { output = (output + String(chunk)).slice(-4096); });
      child.on('error', () => finish(undefined));
      child.on('close', () => finish(parse(output)));
    } catch { finish(undefined); }
  });
}

/** Best-effort Codex CLI version probe used by diagnostics and launch checks; never throws. */
export function probeCodexVersion(executable: string, timeoutMs = 5000): Promise<string | undefined> {
  return probe(executable, parseCodexVersion, timeoutMs);
}

/** Best-effort Claude Code CLI version probe; never throws. */
export function probeClaudeVersion(executable: string, timeoutMs = 5000): Promise<string | undefined> {
  return probe(executable, parseClaudeVersion, timeoutMs);
}
