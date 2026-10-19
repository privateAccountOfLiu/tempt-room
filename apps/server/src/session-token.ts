import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

/**
 * The local owner session token is persisted in the data directory so that:
 *  - browser cookies survive a service restart (no "session expired" screen), and
 *  - external Agent room tokens, derived from the same secret, do not rotate on
 *    every restart.
 * Delete the token file or start with ROOM_ROTATE_SESSION=1 to rotate it.
 */
export const OWNER_TOKEN_FILE = 'owner-session.token';
const TOKEN_RE = /^[0-9a-f]{64}$/;

function persist(file: string, token: string): void {
  const temp = `${file}.tmp`;
  writeFileSync(temp, token, { mode: 0o600 });
  try { renameSync(temp, file); } catch { writeFileSync(file, token, { mode: 0o600 }); }
  try { chmodSync(file, 0o600); } catch { /* Windows may ignore POSIX modes; the state directory is local-only. */ }
}

export function readOwnerToken(root: string): string | undefined {
  const file = join(root, OWNER_TOKEN_FILE);
  try {
    const token = readFileSync(file, 'utf8').trim();
    return TOKEN_RE.test(token) ? token : undefined;
  } catch { return undefined; }
}

export function loadOrCreateOwnerToken(root: string, options: { rotate?: boolean } = {}): { token: string; path: string; created: boolean; rotated: boolean } {
  const file = join(root, OWNER_TOKEN_FILE);
  if (options.rotate) {
    const token = randomBytes(32).toString('hex');
    persist(file, token);
    return { token, path: file, created: false, rotated: true };
  }
  if (existsSync(file)) {
    try {
      const token = readFileSync(file, 'utf8').trim();
      if (TOKEN_RE.test(token)) return { token, path: file, created: false, rotated: false };
    } catch { /* regenerate below */ }
  }
  const token = randomBytes(32).toString('hex');
  persist(file, token);
  return { token, path: file, created: true, rotated: false };
}
