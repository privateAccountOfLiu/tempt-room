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

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

/** Small synchronous SHA-256 so protocol operation IDs stay usable in browsers. */
function sha256Hex(message: string): string {
  const data = new TextEncoder().encode(message);
  const bytes: number[] = [...data, 0x80];
  while (bytes.length % 64 !== 56) bytes.push(0);
  const bitLength = data.byteLength * 8;
  for (let shift = 56; shift >= 0; shift -= 8) bytes.push((bitLength / 2 ** shift) & 0xff);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = ((bytes[offset + i * 4] << 24) | (bytes[offset + i * 4 + 1] << 16) | (bytes[offset + i * 4 + 2] << 8) | bytes[offset + i * 4 + 3]) >>> 0;
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  return [...h].map(value => value.toString(16).padStart(8, '0')).join('');
}
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
  const root = sha256Hex(rootOperationId);
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
