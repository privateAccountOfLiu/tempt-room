import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Agent image messages are uploaded in bounded chunks, verified server-side,
 * then published as an ordinary artifact plus an ordinary chat message. The
 * connector may expose a single room_send_image convenience tool, but the
 * server accepts only these low-level operations.
 */
export const IMAGE_CHUNK_BYTES = 192 * 1024;
export const IMAGE_BASE64_MAX_CHARS = 262_144;
export const IMAGE_MIN_BYTES = 1;
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_ALT_MAX_CHARS = 1_000;
export const IMAGE_MAX_PARTS = Math.ceil(IMAGE_MAX_BYTES / IMAGE_CHUNK_BYTES);

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/i);
const time = z.string().datetime();

export const imageMediaTypeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp']);
export type ImageMediaType = z.infer<typeof imageMediaTypeSchema>;

export const imagePreviewMediaTypeSchema = z.literal('image/png');

/** Stable, verifiable metadata stored on the artifact after decoding. */
export const imageMetadataSchema = z.object({
  verified: z.literal(true),
  width: z.number().int().positive().max(100_000),
  height: z.number().int().positive().max(100_000),
  alt: z.string().max(IMAGE_ALT_MAX_CHARS).optional(),
  previewMediaType: imagePreviewMediaTypeSchema,
  previewHash: hash,
  previewSize: z.number().int().positive().max(IMAGE_MAX_BYTES)
}).strict();
export type ImageMetadata = z.infer<typeof imageMetadataSchema>;

const safeDisplayName = z.string().trim().min(1).max(200).refine(
  name => !/[\u0000-\u001f\\/:*?"<>|]/.test(name) && !name.includes('..') && !/[. ]$/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name),
  '文件名包含不安全字符'
);

export const imageUploadBeginSchema = z.object({
  name: safeDisplayName,
  size: z.number().int().min(IMAGE_MIN_BYTES).max(IMAGE_MAX_BYTES),
  sha256: hash,
  mediaType: imageMediaTypeSchema.optional(),
  alt: z.string().max(IMAGE_ALT_MAX_CHARS).optional()
}).strict();
export type ImageUploadBegin = z.infer<typeof imageUploadBeginSchema>;

/** Canonical strict base64: only the exact alphabet/padding, no whitespace. */
const canonicalBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const imageUploadChunkSchema = z.object({
  uploadId: id,
  index: z.number().int().min(0).max(IMAGE_MAX_PARTS - 1),
  dataBase64: z.string().min(4).max(IMAGE_BASE64_MAX_CHARS).regex(canonicalBase64, 'base64 不是规范编码'),
  sha256: hash
}).strict().superRefine((value, context) => {
  let decoded: Buffer;
  try { decoded = Buffer.from(value.dataBase64, 'base64'); }
  catch { context.addIssue({code: 'custom', path: ['dataBase64'], message: 'base64 无法解码'}); return; }
  if (decoded.byteLength === 0 || decoded.byteLength > IMAGE_CHUNK_BYTES) {
    context.addIssue({code: 'custom', path: ['dataBase64'], message: '分块字节数超出限制'});
    return;
  }
  if (decoded.toString('base64') !== value.dataBase64) context.addIssue({code: 'custom', path: ['dataBase64'], message: 'base64 不是规范编码'});
});
export type ImageUploadChunk = z.infer<typeof imageUploadChunkSchema>;

export const imageUploadCompleteSchema = z.object({uploadId: id}).strict();
export type ImageUploadComplete = z.infer<typeof imageUploadCompleteSchema>;

/** Connector-local convenience arguments; the server never receives `path`. */
export const roomSendImageArgsSchema = z.object({
  path: z.string().min(1).max(2_000),
  text: z.string().max(32_000).default(''),
  alt: z.string().max(IMAGE_ALT_MAX_CHARS).optional(),
  mentions: z.array(id).max(20).default([]),
  replyTo: id.optional(),
  operationId: id
}).strict();
export type RoomSendImageArgs = z.infer<typeof roomSendImageArgsSchema>;

export interface RoomSendImageResult {
  artifactId: string;
  messageId?: string;
  stage: 'uploaded' | 'posted';
  mediaType: ImageMediaType;
  width: number;
  height: number;
}

/**
 * One stable root operation maps to four phase ids. Each id is derived from
 * the root hash and stays well below the 128-character id limit.
 */
export function imageOperationIds(rootOperationId: string): {begin: string; part: (index: number) => string; complete: string; post: string} {
  const root = createHash('sha256').update(rootOperationId).digest('hex');
  return {
    begin: `img_begin_${root.slice(0, 40)}`,
    part: (index: number) => `img_part_${root.slice(0, 32)}_${index}`,
    complete: `img_complete_${root.slice(0, 36)}`,
    post: `img_post_${root.slice(0, 44)}`
  };
}

/** The upload response is intentionally free of client-supplied paths. */
export const imageUploadBeginResultSchema = z.object({
  uploadId: id,
  chunkBytes: z.number().int().positive(),
  completedParts: z.array(z.number().int().nonnegative()).max(IMAGE_MAX_PARTS),
  artifactId: id.optional(),
  expiresAt: time
}).strict();
export type ImageUploadBeginResult = z.infer<typeof imageUploadBeginResultSchema>;

export const imageUploadCompleteResultSchema = z.object({
  artifactId: id,
  name: z.string().min(1).max(200),
  mediaType: imageMediaTypeSchema,
  size: z.number().int().positive().max(IMAGE_MAX_BYTES),
  contentHash: hash,
  image: imageMetadataSchema
}).strict();
export type ImageUploadCompleteResult = z.infer<typeof imageUploadCompleteResultSchema>;
