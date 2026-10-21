import { digest } from './store.ts';
import { commandSchema, payloadSchemas, ProtocolError, type Actor, type Receipt } from '../../../packages/protocol/src/index.ts';
import { canonicalProjectPath } from './project-manifest.ts';
import { scanProjectFiles } from './project-files.ts';
import { ImmutableBaselines } from './immutable-baselines.ts';
import type { RoomService } from './service.ts';

/**
 * A project binding that was prepared outside the command transaction.
 *
 * The baseline copy is expensive and must not run inside the SQLite write
 * transaction. The prepared object is passed to the service as an internal
 * argument; it never travels through the client payload, so a client cannot
 * forge a baseline id or a snapshot path.
 */
export interface PreparedProjectBinding {
  baselineId: string;
  sourcePath: string;
  manifestHash: string;
  manifestAlgorithm: string;
  fileCount: number;
  bytes: number;
}

/**
 * The single entry point for commands.
 *
 * Ordinary commands are executed synchronously. `project.bind` prepares its
 * immutable baseline first and only then opens the command transaction, so the
 * command id keeps its original idempotency semantics.
 */
export class CommandExecutor {
  constructor(private service: RoomService, private baselines: ImmutableBaselines) {}

  async execute(raw: unknown, actor: Actor): Promise<Receipt> {
    const parsed = commandSchema.safeParse(raw);
    if (!parsed.success) throw new ProtocolError('invalid_command', parsed.error.message);
    const command = parsed.data;
    if (command.type !== 'project.bind') return this.service.execute(raw, actor);

    if (actor.kind !== 'human') throw new ProtocolError('forbidden', '只有 owner 可以绑定项目', 403);
    const payload = payloadSchemas['project.bind'].parse(command.payload);
    const sourcePath = canonicalProjectPath(payload.sourcePath);
    const scan = scanProjectFiles(sourcePath);
    const baselineId = `baseline_${digest({ sourcePath, manifestHash: scan.manifestHash, algorithm: scan.manifestAlgorithm }).slice(0, 32)}`;
    const prepared = this.baselines.prepare(scan, sourcePath, baselineId);
    return this.service.execute(raw, actor, undefined, {
      baselineId: prepared.baselineId,
      sourcePath,
      manifestHash: prepared.record.manifestHash,
      manifestAlgorithm: prepared.record.manifestAlgorithm,
      fileCount: prepared.record.fileCount,
      bytes: prepared.record.bytes,
    });
  }
}
