import { spawn } from 'node:child_process';

/**
 * Build the platform command used to open the local UI in the default browser.
 * ROOM_OPEN_BROWSER_COMMAND overrides the executable (used by tests and for
 * locked-down environments); it receives the URL as its only argument.
 */
export function openCommand(url: string, platform: NodeJS.Platform = process.platform, override = process.env.ROOM_OPEN_BROWSER_COMMAND): { command: string; args: string[] } {
  if (override) return { command: override, args: [url] };
  if (platform === 'win32') return { command: 'cmd.exe', args: ['/c', 'start', '', url] };
  if (platform === 'darwin') return { command: 'open', args: [url] };
  return { command: 'xdg-open', args: [url] };
}

/** Open a URL in the default browser without blocking or tying it to the server. */
export function openBrowser(url: string): void {
  const { command, args } = openCommand(url);
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch { /* opening the browser is best-effort; the URL is still printed */ }
}
