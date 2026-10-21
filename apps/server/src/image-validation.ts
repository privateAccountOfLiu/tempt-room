import sharp from 'sharp';
import type {Metadata} from 'sharp';
import { IMAGE_MAX_BYTES, ProtocolError, type ImageMediaType, type ImageMetadata } from '../../../packages/protocol/src/index.ts';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_DIMENSION = 8192;
const MAX_PIXELS = 16_777_216;
const PREVIEW_MAX_DIMENSION = 1920;
const PREVIEW_MAX_BYTES = 4 * 1024 * 1024;

export interface DecodedImage {
  mediaType: ImageMediaType;
  contentHash: string;
  width: number;
  height: number;
  preview: Buffer;
  previewMediaType: 'image/png';
  previewSize: number;
}

/** Bounded concurrency for the CPU-heavy decode step. */
class DecodeGate {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private maxActive = 2, private maxQueue = 16) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxActive) {
      if (this.queue.length >= this.maxQueue) throw new ProtocolError('image_busy', '图片解码队列已满，请稍后重试', 429);
      await new Promise<void>(resolve => this.queue.push(resolve));
    }
    this.active++;
    try { return await fn(); }
    finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}
const decodeGate = new DecodeGate();

function rejectContainer(): never {
  throw new ProtocolError('invalid_image', '只接受静态 PNG/JPEG/WebP 图片', 400);
}

/** Signature gate before any decoder sees the bytes. */
export function detectStaticImageType(bytes: Buffer): ImageMediaType {
  if (bytes.length < 12) rejectContainer();
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    // Walk PNG chunks and reject the APNG animation control chunk.
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
      if (type === 'acTL') rejectContainer();
      if (type === 'IEND') break;
      if (length > bytes.length) rejectContainer();
      offset += 12 + length;
    }
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    const chunkStart = 12;
    let offset = chunkStart;
    while (offset + 8 <= bytes.length) {
      const type = bytes.subarray(offset, offset + 4).toString('ascii');
      const length = bytes.readUInt32LE(offset + 4);
      if (type === 'VP8X' && bytes.length > offset + 8) {
        const flags = bytes[offset + 8];
        if (flags & 0x02) rejectContainer(); // animation flag
      }
      if (type === 'ANIM' || type === 'ANMF') rejectContainer();
      offset += 8 + length + (length % 2);
    }
    return 'image/webp';
  }
  return rejectContainer();
}

export function assertNotActiveWebp(bytes: Buffer): void {
  // Handled by detectStaticImageType; retained as a named checkpoint for tests.
  detectStaticImageType(bytes);
}

/** Verify a complete decoded image and build a bounded static PNG preview. */
export async function validateAndPreview(bytes: Buffer, alt?: string): Promise<DecodedImage> {
  if (bytes.length === 0 || bytes.length > IMAGE_MAX_BYTES) throw new ProtocolError('image_size', '图片字节数超出范围', 400);
  if (bytes[0] === 0x3c) rejectContainer(); // SVG/XML/HTML
  const expected = detectStaticImageType(bytes);
  return decodeGate.run(async () => {
    let metadata: Metadata;
    try {
      metadata = await sharp(bytes, {failOn: 'warning', limitInputPixels: MAX_PIXELS}).metadata();
    } catch {
      throw new ProtocolError('invalid_image', '图片无法解码', 400);
    }
    const format = metadata.format === 'jpeg' ? 'image/jpeg' : metadata.format === 'png' ? 'image/png' : metadata.format === 'webp' ? 'image/webp' : undefined;
    if (!format || format !== expected) throw new ProtocolError('image_mismatch', '图片签名与解码格式不一致', 400);
    if ((metadata.pages ?? 1) > 1) rejectContainer();
    const width = metadata.width, height = metadata.height;
    if (!width || !height || width < 1 || height < 1 || Math.max(width, height) > MAX_DIMENSION || width * height > MAX_PIXELS) throw new ProtocolError('image_dimensions', '图片尺寸超出限制', 400);
    let preview: Buffer;
    try {
      preview = await sharp(bytes, {failOn: 'warning', limitInputPixels: MAX_PIXELS})
        .rotate()
        .resize({width: PREVIEW_MAX_DIMENSION, height: PREVIEW_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true})
        .png({compressionLevel: 6, adaptiveFiltering: true})
        .toBuffer();
    } catch {
      throw new ProtocolError('invalid_image', '图片像素解码失败', 400);
    }
    if (preview.byteLength === 0 || preview.byteLength > PREVIEW_MAX_BYTES) throw new ProtocolError('preview_size', '安全预览超出上限', 400);
    const {createHash} = await import('node:crypto');
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const previewHash = createHash('sha256').update(preview).digest('hex');
    const image: ImageMetadata = {verified: true, width, height, ...(alt ? {alt} : {}), previewMediaType: 'image/png', previewHash, previewSize: preview.byteLength};
    return {mediaType: format, contentHash, width, height, preview, previewMediaType: 'image/png', previewSize: image.previewSize};
  });
}
