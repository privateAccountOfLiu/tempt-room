import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { IMAGE_CHUNK_BYTES, IMAGE_MAX_BYTES, ProtocolError, normalizeRoom, type Artifact, type ImageMediaType } from '../../../packages/protocol/src/index.ts';
import { installArtifactFiles } from './artifact-files.ts';
import { validateAndPreview } from './image-validation.ts';
import type { Store } from './store.ts';

export interface ImageUploadFence {
  runId: string;
  generation: number;
  executionId: string;
  taskId?: string;
  taskVersion?: number;
}

export interface BeginUploadInput {
  roomId: string;
  agentId: string;
  rootOperationId: string;
  name: string;
  size: number;
  sha256: string;
  mediaType?: string;
  alt?: string;
  fence?: ImageUploadFence;
}

export interface UploadView {
  uploadId: string;
  state: 'uploading' | 'completed' | 'aborted' | 'expired' | 'failed';
  chunkBytes: number;
  completedParts: number[];
  expiresAt: string;
  size: number;
  sha256: string;
  artifactId?: string;
  reused: boolean;
}

interface UploadBody {
  name: string;
  size: number;
  sha256: string;
  mediaType?: string;
  alt?: string;
  rootOperationId: string;
  expectedParts: number;
  agentId: string;
  roomId: string;
  fence?: ImageUploadFence;
  createdAt: string;
  updatedAt: string;
  state: string;
  completedBytes?: number;
  completedHash?: string;
  artifactId?: string;
}

const id = () => `upload_${createHash('sha256').update(`${Date.now()}\0${Math.random()}\0${process.hrtime.bigint()}`).digest('hex').slice(0, 32)}`;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const TTL_MS = 30 * 60 * 1000;
const MAX_PENDING_PER_AGENT = 2;
const MAX_PENDING_PER_ROOM = 4;
const MAX_PENDING_BYTES_PER_ROOM = 32 * 1024 * 1024;
const MAX_PENDING_BYTES_GLOBAL = 128 * 1024 * 1024;

export class ImageUploads {
  readonly root: string;
  private locks = new Map<string, Promise<unknown>>();

  readonly stateRoot: string;
  constructor(private store: Store, stateRoot: string) {
    this.stateRoot = stateRoot;
    this.root = join(stateRoot, 'uploads');
    mkdirSync(this.root, { recursive: true });
  }

  private roomActive(roomId: string): boolean {
    const room = this.store.room(roomId);
    return Boolean(room && normalizeRoom(room).status === 'active');
  }

  private body(uploadId: string): {body: UploadBody; row: any} {
    const row = this.store.db.prepare('SELECT * FROM image_uploads WHERE id=?').get(uploadId) as any;
    if (!row) throw new ProtocolError('upload_not_found', '上传不存在', 404);
    return {row, body: JSON.parse(row.body) as UploadBody};
  }

  private assertUsable(row: any, body: UploadBody, input: {roomId?: string; agentId?: string; fence?: ImageUploadFence}): void {
    if (input.roomId && row.room_id !== input.roomId) throw new ProtocolError('upload_room_mismatch', '上传不属于此房间', 409);
    if (input.agentId && row.agent_id !== input.agentId) throw new ProtocolError('upload_agent_mismatch', '上传不属于此 Agent', 403);
    if (!this.roomActive(row.room_id)) throw new ProtocolError('room_inactive', '房间正在删除或已删除', 409);
    if (body.state !== 'uploading') throw new ProtocolError('upload_not_pending', `上传状态为 ${body.state}`, 409);
    if (Date.parse(row.expires_at) <= Date.now()) {
      this.transition(row.id, 'expired');
      throw new ProtocolError('upload_expired', '上传已过期', 410);
    }
    if (body.fence && input.fence) {
      const f = body.fence;
      if (f.runId !== input.fence.runId || f.generation !== input.fence.generation || f.executionId !== input.fence.executionId) throw new ProtocolError('upload_fence_mismatch', '上传绑定的执行已变化', 409);
    } else if (body.fence && !input.fence) throw new ProtocolError('upload_fence_required', '上传需要原始执行身份', 409);
  }

  private transition(uploadId: string, state: UploadBody['state'], extra: Partial<UploadBody> = {}): void {
    const {row, body} = (() => { try { return this.body(uploadId); } catch { return {row: {body: '{}', state: 'uploading'}, body: {} as UploadBody}; } })();
    const next = {...body, ...extra, state, updatedAt: new Date().toISOString()};
    this.store.db.prepare('UPDATE image_uploads SET state=?,body=? WHERE id=? AND state=?').run(state, JSON.stringify(next), uploadId, row.state ?? body.state ?? 'uploading');
  }

  private async exclusive<T>(uploadId: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = this.locks.get(uploadId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(fn);
    this.locks.set(uploadId, current as Promise<unknown>);
    try { return await current; } finally { if (this.locks.get(uploadId) === current) this.locks.delete(uploadId); }
  }

  private directory(uploadId: string): string {
    if (!/^upload_[a-f0-9]{32}$/.test(uploadId)) throw new ProtocolError('invalid_upload', '上传编号非法', 400);
    return join(this.root, uploadId);
  }

  pendingStats(filter: {roomId?: string; agentId?: string} = {}): {count: number; bytes: number} {
    const clause = filter.roomId ? 'room_id=?' : filter.agentId ? 'agent_id=?' : '1=1';
    const value = filter.roomId ?? filter.agentId ?? '';
    const statement = this.store.db.prepare(`SELECT body FROM image_uploads WHERE state='uploading' AND ${clause}`);
    const rows = (filter.roomId || filter.agentId ? statement.all(value) : statement.all()) as {body: string}[];
    let bytes = 0;
    for (const row of rows) bytes += JSON.parse(row.body).size ?? 0;
    return {count: rows.length, bytes};
  }

  begin(input: BeginUploadInput): UploadView {
    if (!this.roomActive(input.roomId)) throw new ProtocolError('room_inactive', '房间正在删除或已删除', 409);
    const agent = this.store.get<any>('agents', input.agentId);
    if (!agent || agent.enabled === false) throw new ProtocolError('agent_unavailable', 'Agent 未启用', 403);
    const expectedParts = Math.max(1, Math.ceil(input.size / IMAGE_CHUNK_BYTES));
    const operationKey = `${input.roomId}\0${input.agentId}\0${input.rootOperationId}`;
    const metadataHash = sha(Buffer.from(JSON.stringify({name: input.name, size: input.size, sha256: input.sha256, mediaType: input.mediaType ?? null, alt: input.alt ?? null, fence: input.fence ?? null})));
    const existing = this.store.db.prepare('SELECT * FROM image_uploads WHERE operation_key=?').get(operationKey) as any;
    if (existing) {
      const body = JSON.parse(existing.body) as UploadBody;
      if (existing.metadata_hash !== metadataHash) throw new ProtocolError('upload_conflict', '同一 operationId 不能用于不同文件或说明', 409);
      return {...this.view(existing.id, body, existing.expires_at), reused: true};
    }
    const agentPending = this.pendingStats({agentId: input.agentId});
    const roomPending = this.pendingStats({roomId: input.roomId});
    if (agentPending.count >= MAX_PENDING_PER_AGENT) throw new ProtocolError('upload_quota', '该 Agent 的待上传数量已达上限', 429);
    if (roomPending.count >= MAX_PENDING_PER_ROOM) throw new ProtocolError('upload_quota', '房间待上传数量已达上限', 429);
    if (roomPending.bytes + input.size > MAX_PENDING_BYTES_PER_ROOM) throw new ProtocolError('upload_quota', '房间待上传字节已达上限', 429);
    if (this.pendingStats().bytes + input.size > MAX_PENDING_BYTES_GLOBAL) throw new ProtocolError('upload_quota', '全局待上传字节已达上限', 429);
    const uploadId = id(), now = new Date(), expiresAt = new Date(now.getTime() + TTL_MS).toISOString();
    const body: UploadBody = {name: input.name, size: input.size, sha256: input.sha256, ...(input.mediaType ? {mediaType: input.mediaType} : {}), ...(input.alt ? {alt: input.alt} : {}), rootOperationId: input.rootOperationId, expectedParts, agentId: input.agentId, roomId: input.roomId, ...(input.fence ? {fence: input.fence} : {}), createdAt: now.toISOString(), updatedAt: now.toISOString(), state: 'uploading'};
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.db.prepare('INSERT INTO image_uploads(id,room_id,agent_id,operation_key,metadata_hash,state,body,expires_at) VALUES(?,?,?,?,?,?,?,?)').run(uploadId, input.roomId, input.agentId, operationKey, metadataHash, 'uploading', JSON.stringify(body), expiresAt);
      mkdirSync(join(this.directory(uploadId), 'parts'), {recursive: true});
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    return {...this.view(uploadId, body, expiresAt), reused: false};
  }

  private view(uploadId: string, body: UploadBody, expiresAt: string): UploadView {
    const parts = this.store.db.prepare('SELECT part_index FROM image_upload_parts WHERE upload_id=? ORDER BY part_index').all(uploadId) as {part_index: number}[];
    return {uploadId, state: body.state as UploadView['state'], chunkBytes: IMAGE_CHUNK_BYTES, completedParts: parts.map(part => part.part_index), expiresAt, size: body.size, sha256: body.sha256, ...(body.artifactId ? {artifactId: body.artifactId} : {}), reused: false};
  }

  async chunk(uploadId: string, index: number, data: Buffer, declaredHash: string, identity: {roomId: string; agentId: string; fence?: ImageUploadFence}): Promise<{uploadId: string; index: number; acceptedBytes: number; duplicate: boolean}> {
    return this.exclusive(uploadId, async () => {
      const {body, row} = this.body(uploadId);
      this.assertUsable(row, body, identity);
      if (index < 0 || index >= body.expectedParts) throw new ProtocolError('chunk_index', '分块序号越界', 400);
      const expectedLength = index === body.expectedParts - 1 ? body.size - index * IMAGE_CHUNK_BYTES : IMAGE_CHUNK_BYTES;
      if (data.byteLength !== expectedLength) throw new ProtocolError('chunk_size', '分块字节数与声明文件大小不一致', 400);
      if (sha(data) !== declaredHash) throw new ProtocolError('chunk_hash', '分块摘要不匹配', 400);
      const directory = this.directory(uploadId), target = join(directory, 'parts', `${index}.part`);
      const existing = this.store.db.prepare('SELECT * FROM image_upload_parts WHERE upload_id=? AND part_index=?').get(uploadId, index) as any;
      if (existing) {
        if (existing.sha256 !== declaredHash || existing.byte_length !== data.byteLength) throw new ProtocolError('chunk_conflict', '同一分块序号已有不同内容', 409);
        if (!existsSync(target)) throw new ProtocolError('chunk_missing', '分块记录存在但文件缺失', 409);
        if (sha(readFileSync(target)) !== declaredHash) throw new ProtocolError('chunk_corrupt', '分块文件摘要不匹配', 409);
        return {uploadId, index, acceptedBytes: data.byteLength, duplicate: true};
      }
      if (existsSync(target)) {
        if (sha(readFileSync(target)) !== declaredHash) throw new ProtocolError('chunk_conflict', '分块文件已有不同内容', 409);
      } else {
        const temp = join(directory, 'parts', `${index}.tmp-${createHash('sha256').update(`${Date.now()}\0${Math.random()}`).digest('hex').slice(0, 12)}`);
        writeFileSync(temp, data);
        renameSync(temp, target);
      }
      this.store.db.prepare('INSERT INTO image_upload_parts(upload_id,part_index,byte_length,sha256) VALUES(?,?,?,?)').run(uploadId, index, data.byteLength, declaredHash);
      return {uploadId, index, acceptedBytes: data.byteLength, duplicate: false};
    });
  }

  async complete(uploadId: string, identity: {roomId: string; agentId: string; fence?: ImageUploadFence}): Promise<{uploadId: string; state: 'completed'; size: number; sha256: string; artifactId?: string}> {
    return this.exclusive(uploadId, async () => {
      const {body, row} = this.body(uploadId);
      if (row.room_id !== identity.roomId || row.agent_id !== identity.agentId) throw new ProtocolError('upload_owner_mismatch', '上传不属于此 Agent', 403);
      if (body.state === 'completed' && body.completedHash && body.completedBytes !== undefined) return {uploadId, state: 'completed' as const, size: body.completedBytes, sha256: body.completedHash, ...(body.artifactId ? {artifactId: body.artifactId} : {})};
      this.assertUsable(row, body, identity);
      const parts = this.store.db.prepare('SELECT part_index,byte_length,sha256 FROM image_upload_parts WHERE upload_id=? ORDER BY part_index').all(uploadId) as {part_index: number; byte_length: number; sha256: string}[];
      if (parts.length !== body.expectedParts) throw new ProtocolError('upload_incomplete', `缺少分块（${parts.length}/${body.expectedParts}）`, 409);
      const directory = this.directory(uploadId);
      let total = 0;
      const chunks: Buffer[] = [];
      for (const part of parts) {
        const file = join(directory, 'parts', `${part.part_index}.part`);
        if (!existsSync(file)) throw new ProtocolError('chunk_missing', `分块文件缺失：${part.part_index}`, 409);
        const bytes = readFileSync(file);
        if (bytes.byteLength !== part.byte_length || sha(bytes) !== part.sha256) throw new ProtocolError('chunk_corrupt', `分块文件损坏：${part.part_index}`, 409);
        total += bytes.byteLength;
        if (total > body.size || total > IMAGE_MAX_BYTES) throw new ProtocolError('upload_overflow', '上传总字节超出声明值', 409);
        chunks.push(bytes);
      }
      if (total !== body.size) throw new ProtocolError('upload_size_mismatch', '上传总字节与声明值不一致', 409);
      const contentHash = sha(Buffer.concat(chunks));
      if (contentHash !== body.sha256) throw new ProtocolError('upload_hash_mismatch', '整图摘要与 begin 声明不一致', 409);
      writeFileSync(join(directory, 'complete.bin'), Buffer.concat(chunks));
      this.transition(uploadId, 'completed', {completedBytes: total, completedHash: contentHash});
      return {uploadId, state: 'completed', size: total, sha256: contentHash};
    });
  }

  /** Decode/verify the completed image and install original + preview files, then persist one artifact. */
  async finalize(uploadId: string, identity: {roomId: string; agentId: string; fence?: ImageUploadFence}): Promise<{artifactId: string; uploadId: string; mediaType: ImageMediaType; width: number; height: number; size: number; contentHash: string; reused: boolean}> {
    const completed = await this.complete(uploadId, identity);
    const {body, row} = this.body(uploadId);
    if (row.room_id !== identity.roomId || row.agent_id !== identity.agentId) throw new ProtocolError('upload_owner_mismatch', '上传不属于此 Agent', 403);
    const artifactId = body.artifactId ?? `artifact_${sha(Buffer.from(`${uploadId}\0${completed.sha256}`)).slice(0, 32)}`;
    if (body.artifactId && body.completedHash) {
      const artifact = this.store.get<Artifact>('artifacts', body.artifactId);
      if (artifact) return {artifactId: artifact.id, uploadId, mediaType: artifact.mediaType as ImageMediaType, width: artifact.image?.width ?? 1, height: artifact.image?.height ?? 1, size: artifact.size, contentHash: body.completedHash, reused: true};
    }
    const completeFile = join(this.directory(uploadId), 'complete.bin');
    if (!existsSync(completeFile)) throw new ProtocolError('upload_incomplete', '完成的上传文件缺失', 409);
    const bytes = readFileSync(completeFile);
    if (bytes.byteLength !== completed.size || sha(bytes) !== completed.sha256) throw new ProtocolError('upload_hash_mismatch', '完成文件摘要不一致', 409);
    const decoded = await validateAndPreview(bytes, body.alt);
    // Re-check authority after the awaited decode: a room/member change must win.
    if (!this.roomActive(identity.roomId)) throw new ProtocolError('room_inactive', '房间正在删除或已删除', 409);
    const agent = this.store.get<any>('agents', identity.agentId);
    if (!agent || agent.enabled === false) throw new ProtocolError('agent_unavailable', 'Agent 已停用', 403);
    if (!this.store.room(identity.roomId)?.members.includes(identity.agentId)) throw new ProtocolError('forbidden', 'Agent 已不在房间内', 403);
    const files = installArtifactFiles(this.stateRoot, artifactId, bytes, decoded.preview);
    const artifact: Artifact = {id: artifactId, roomId: identity.roomId, name: body.name, kind: 'file', mediaType: decoded.mediaType, size: bytes.byteLength, createdAt: new Date().toISOString(), contentHash: decoded.contentHash, image: {verified: true, width: decoded.width, height: decoded.height, ...(body.alt ? {alt: body.alt} : {}), previewMediaType: 'image/png', previewHash: files.previewHash, previewSize: decoded.previewSize}};
    const nextBody: UploadBody = {...body, artifactId, state: 'completed'};
    this.store.atomic(() => {
      this.store.event(identity.roomId, 'artifact.created', {id: identity.agentId, kind: 'agent'}, {artifact});
      this.store.db.prepare('UPDATE image_uploads SET state=?,body=? WHERE id=?').run('completed', JSON.stringify(nextBody), uploadId);
    });
    return {artifactId, uploadId, mediaType: decoded.mediaType, width: decoded.width, height: decoded.height, size: bytes.byteLength, contentHash: decoded.contentHash, reused: false};
  }

  abort(uploadId: string, identity: {roomId: string; agentId: string; fence?: ImageUploadFence}): void {
    const {body, row} = this.body(uploadId);
    if (row.room_id !== identity.roomId || row.agent_id !== identity.agentId) throw new ProtocolError('upload_owner_mismatch', '上传不属于此 Agent', 403);
    if (body.state === 'uploading') this.transition(uploadId, 'aborted');
    this.removeParts(uploadId);
  }

  expire(uploadId: string): void {
    const {body} = this.body(uploadId);
    if (body.state === 'uploading') this.transition(uploadId, 'expired');
    this.removeParts(uploadId);
  }

  private removeParts(uploadId: string): void {
    const directory = this.directory(uploadId), parts = join(directory, 'parts');
    const root = join(this.root, uploadId);
    if (!root.startsWith(this.root + sep)) return;
    try { if (existsSync(parts)) rmSync(parts, {recursive: true, force: true}); } catch { /* retry next GC */ }
  }

  /** Remove expired/pending uploads older than the retention while preserving completed receipts. */
  gc(retentionMs = 24 * 60 * 60 * 1000): number {
    const cutoff = new Date(Date.now() - retentionMs).toISOString();
    const rows = this.store.db.prepare("SELECT id,state,expires_at,body FROM image_uploads WHERE (state='uploading' AND expires_at<=?) OR (state IN ('aborted','expired','failed') AND expires_at<=?)").all(new Date().toISOString(), cutoff) as any[];
    let removed = 0;
    for (const row of rows) {
      const body = JSON.parse(row.body) as UploadBody;
      if (body.state === 'uploading') this.transition(row.id, 'expired');
      const root = this.directory(row.id);
      try { rmSync(root, {recursive: true, force: true}); removed += 1; } catch { /* retry */ }
    }
    return removed;
  }
}
