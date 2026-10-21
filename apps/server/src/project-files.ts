import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ProtocolError } from '../../../packages/protocol/src/index.ts';

/**
 * One shared project scanner.
 *
 * The same algorithm, the same exclusion rules and the same limits are used
 * when a room binds a project and when a run materialises a workspace, so
 * "the same manifest" means the same bytes in both places.
 */
export const MANIFEST_ALGORITHM = 'tempt-room-manifest-v2';

export interface ScanLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
}

export const defaultScanLimits: ScanLimits = {
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  maxFiles: 20000,
};

export interface ScannedFile {
  path: string;
  size: number;
  sha256: string;
}

export interface ProjectScan {
  manifestAlgorithm: string;
  manifestHash: string;
  fileCount: number;
  bytes: number;
  files: ScannedFile[];
  contents: Map<string, Buffer>;
}

/** Directories that never belong to a project baseline. */
const excludedDirectories = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'out', 'bin', 'obj', '.next', '.nuxt',
  'coverage', '.venv', 'venv', '__pycache__', 'target', '.cache', '.state', '.idea', '.vscode',
  '.aws', '.ssh', '.gnupg', '.codex', '.claude', '.dsh', '.gradle', '.terraform', 'vendor',
]);

/** Files that may hold credentials or host-specific state. */
const excludedFiles = new Set([
  '.npmrc', '.pypirc', '.netrc', '.git-credentials', '.gitconfig', 'auth.json', '.htpasswd',
  'credentials.json', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'known_hosts', 'settings.local.json',
]);

const sensitiveFile = (name: string): boolean => {
  const lower = name.toLowerCase();
  if (excludedFiles.has(lower)) return true;
  if (/^\.env(?:\.|$)/i.test(name)) return true;
  if (/(?:^|[._-])(credentials?|secrets?|token)(?:[._-]|$)/i.test(name)) return true;
  if (/\.(pem|key|p12|pfx|keystore)$/i.test(name)) return true;
  return false;
};

const reservedDevice = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function assertPortablePath(relativePath: string): void {
  const parts = relativePath.split('/');
  for (const part of parts) {
    if (!part) throw new ProtocolError('unsafe_path', `文件路径为空：${relativePath}`);
    if (part === '.' || part === '..') throw new ProtocolError('unsafe_path', `文件路径越界：${relativePath}`);
    if (part.includes(':')) throw new ProtocolError('unsafe_path', `文件路径包含 ADS 或盘符：${relativePath}`);
    if (/[. ]$/.test(part)) throw new ProtocolError('unsafe_path', `文件路径以点或空格结尾：${relativePath}`);
    if (reservedDevice.test(part)) throw new ProtocolError('unsafe_path', `文件路径使用保留设备名：${relativePath}`);
    if (part.length > 255) throw new ProtocolError('unsafe_path', `文件路径过长：${relativePath}`);
  }
}

/**
 * Scan a project directory.
 *
 * The result is the single source of truth for "what is in this project":
 * stable ordering, versioned hash format, explicit errors for anything that
 * cannot be frozen safely.
 */
export function scanProjectFiles(root: string, options: { limits?: Partial<ScanLimits>; readContents?: boolean } = {}): ProjectScan {
  const limits = { ...defaultScanLimits, ...(options.limits ?? {}) };
  const readContents = options.readContents !== false;
  const base = resolve(root);
  const files: ScannedFile[] = [];
  const contents = new Map<string, Buffer>();
  const seenCase = new Map<string, string>();
  let bytes = 0;

  const walk = (directory: string) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (excludedDirectories.has(entry.name.toLowerCase())) continue;
      const absolute = join(directory, entry.name);
      const relativePath = relative(base, absolute).split('\\').join('/');
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new ProtocolError('reparse_point', `项目包含符号链接/重解析点：${relativePath}`);
      if (stat.isDirectory()) { walk(absolute); continue; }
      if (!stat.isFile()) continue;
      if (sensitiveFile(entry.name)) continue;
      assertPortablePath(relativePath);
      const folded = relativePath.toLowerCase();
      const previous = seenCase.get(folded);
      if (previous && previous !== relativePath) throw new ProtocolError('case_conflict', `项目包含仅大小写不同的同名文件：${previous} 与 ${relativePath}`);
      seenCase.set(folded, relativePath);
      if (stat.size > limits.maxFileBytes) throw new ProtocolError('file_too_large', `项目单文件超过 ${limits.maxFileBytes} 字节：${relativePath}`);
      const before = { size: stat.size, mtimeMs: stat.mtimeMs };
      const data = readFileSync(absolute);
      const after = lstatSync(absolute);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new ProtocolError('source_changed_during_snapshot', `扫描期间文件发生变化：${relativePath}`);
      bytes += data.byteLength;
      if (bytes > limits.maxTotalBytes) throw new ProtocolError('snapshot_limit', `项目超过 ${limits.maxTotalBytes} 字节上限`);
      if (files.length >= limits.maxFiles) throw new ProtocolError('snapshot_limit', `项目文件数超过 ${limits.maxFiles} 上限`);
      files.push({ path: relativePath, size: data.byteLength, sha256: createHash('sha256').update(data).digest('hex') });
      if (readContents) contents.set(relativePath, data);
    }
  };
  walk(base);

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifestHash = createHash('sha256')
    .update(`${MANIFEST_ALGORITHM}\n${files.map(file => `${file.path}\0${file.size}\0${file.sha256}`).join('\n')}`)
    .digest('hex');
  return { manifestAlgorithm: MANIFEST_ALGORITHM, manifestHash, fileCount: files.length, bytes, files, contents };
}

/** Hash of a manifest entry list without reading file contents. */
export function manifestHashOf(files: readonly ScannedFile[], algorithm = MANIFEST_ALGORITHM): string {
  return createHash('sha256')
    .update(`${algorithm}\n${files.map(file => `${file.path}\0${file.size}\0${file.sha256}`).join('\n')}`)
    .digest('hex');
}
