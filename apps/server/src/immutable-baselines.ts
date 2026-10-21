import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ProtocolError } from '../../../packages/protocol/src/index.ts';
import { now } from './store.ts';
import { assertPortablePath, type ProjectScan } from './project-files.ts';

/**
 * Managed immutable baselines.
 *
 * A baseline is a frozen copy of a project directory owned by Tempt Room.
 * Runs materialise their workspace from the baseline, never from the mutable
 * source, so two runs of the same binding share identical inputs.
 */
export interface BaselineRecord {
  baselineId: string;
  sourcePath: string;
  manifestAlgorithm: string;
  manifestHash: string;
  fileCount: number;
  bytes: number;
  files: { path: string; size: number; sha256: string }[];
  createdAt: string;
  complete: boolean;
}

export interface PreparedBaseline {
  baselineId: string;
  record: BaselineRecord;
  directory: string;
}

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export class ImmutableBaselines {
  readonly root: string;
  constructor(stateRoot: string) {
    this.root = join(stateRoot, 'baselines');
    mkdirSync(this.root, { recursive: true });
  }

  directory(baselineId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(baselineId)) throw new ProtocolError('invalid_baseline', '基线编号非法');
    return join(this.root, baselineId);
  }

  /**
   * Write a frozen copy of the scan into the managed baseline directory.
   * The directory only becomes visible to readers once the complete marker
   * exists, so a crashed preparation can never be read as a baseline.
   */
  prepare(scan: ProjectScan, sourcePath: string, baselineId: string): PreparedBaseline {
    const directory = this.directory(baselineId);
    const filesDirectory = join(directory, 'files');
    // A retry of the same binding reuses the frozen copy instead of rewriting
    // files that a running run may already be reading.
    if (existsSync(join(directory, 'complete'))) {
      try {
        const existing = this.record(baselineId);
        if (existing.manifestHash === scan.manifestHash) return { baselineId, record: existing, directory };
      } catch {
        /* An unreadable baseline is replaced below. */
      }
    }
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(filesDirectory, { recursive: true });
    for (const file of scan.files) {
      const content = scan.contents.get(file.path);
      if (!content) throw new ProtocolError('baseline_incomplete', `基线缺少文件内容：${file.path}`);
      assertPortablePath(file.path);
      const target = join(filesDirectory, ...file.path.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    const record: BaselineRecord = {
      baselineId,
      sourcePath,
      manifestAlgorithm: scan.manifestAlgorithm,
      manifestHash: scan.manifestHash,
      fileCount: scan.fileCount,
      bytes: scan.bytes,
      files: scan.files.map(file => ({ path: file.path, size: file.size, sha256: file.sha256 })),
      createdAt: now(),
      complete: true,
    };
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(record, null, 2));
    writeFileSync(join(directory, 'complete'), scan.manifestHash);
    return { baselineId, record, directory };
  }

  record(baselineId: string): BaselineRecord {
    const directory = this.directory(baselineId);
    const manifestPath = join(directory, 'manifest.json');
    if (!existsSync(manifestPath)) throw new ProtocolError('baseline_unavailable', `基线不存在：${baselineId}`);
    const record = JSON.parse(readFileSync(manifestPath, 'utf8')) as BaselineRecord;
    if (!existsSync(join(directory, 'complete'))) throw new ProtocolError('baseline_unavailable', `基线未完成：${baselineId}`);
    return record;
  }

  /** Verify the complete marker and every stored file digest. */
  verify(baselineId: string): { record: BaselineRecord; files: Map<string, Buffer> } {
    const record = this.record(baselineId);
    const directory = this.directory(baselineId);
    const marker = readFileSync(join(directory, 'complete'), 'utf8').trim();
    if (marker !== record.manifestHash) throw new ProtocolError('baseline_unavailable', `基线摘要不匹配：${baselineId}`);
    const filesDirectory = join(directory, 'files');
    const files = new Map<string, Buffer>();
    for (const file of record.files ?? []) {
      const target = join(filesDirectory, ...file.path.split('/'));
      if (!existsSync(target)) throw new ProtocolError('baseline_unavailable', `基线文件缺失：${file.path}`);
      const content = readFileSync(target);
      if (sha(content) !== file.sha256) throw new ProtocolError('baseline_unavailable', `基线文件已变化：${file.path}`);
      files.set(file.path, content);
    }
    return { record, files };
  }

  /** File list of a baseline without re-reading every byte. */
  list(baselineId: string): { path: string; size: number; sha256: string }[] {
    return this.record(baselineId).files;
  }

  /** Remove baselines that no run, binding or artifact references. */
  gc(referenced: ReadonlySet<string>): number {
    let removed = 0;
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (referenced.has(entry.name)) continue;
      try {
        rmSync(join(this.root, entry.name), { recursive: true, force: true });
        removed += 1;
      } catch {
        /* A baseline that cannot be removed stays until the next collection. */
      }
    }
    return removed;
  }

  /** Move a prepared directory into place; used when the commit succeeds. */
  promote(prepared: PreparedBaseline): void {
    const target = this.directory(prepared.baselineId);
    if (existsSync(target)) renameSync(target, `${target}.stale-${Date.now()}`);
  }
}
