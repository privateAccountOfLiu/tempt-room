import { IMAGE_CHUNK_BYTES, imageOperationIds, type ImageMediaType, type RoomSendImageResult } from '../../protocol/src/index.ts';

/** Minimal command transport used by both the browser SDK and external connectors. */
export type ImageCommandSender = (commandId: string, name: string, args: Record<string, unknown>) => Promise<any>;

export interface UploadedImage {
  artifactId: string;
  uploadId: string;
  mediaType: ImageMediaType;
  width: number;
  height: number;
  size: number;
  contentHash: string;
}

export interface ImageUploadOptions {
  name: string;
  operationId: string;
  alt?: string;
  signal?: AbortSignal;
}

export interface SendImageOptions extends ImageUploadOptions {
  text?: string;
  mentions?: string[];
  replyTo?: string;
}

export class ImageUploadError extends Error {
  constructor(message: string, public stage: 'begin' | 'chunk' | 'complete' | 'post', public commandId: string, public artifactId?: string) {
    super(message);
    this.name = 'ImageUploadError';
  }
}

const CHECK_ABORT = (signal?: AbortSignal) => { if (signal?.aborted) throw new ImageUploadError('上传已取消', 'chunk', 'aborted'); };

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.byteLength; index++) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

/** Browser-safe three-phase image upload: begin -> chunks -> complete. */
export async function uploadImage(send: ImageCommandSender, bytes: Uint8Array, options: ImageUploadOptions): Promise<UploadedImage> {
  if (!bytes.byteLength) throw new ImageUploadError('图片为空', 'begin', 'empty');
  const ids = imageOperationIds(options.operationId);
  const sha256 = await sha256Hex(bytes);
  let uploadId = '';
  let stage: 'begin' | 'chunk' | 'complete' = 'begin';
  try {
    const begun = await send(ids.begin, 'image_upload_begin', {name: options.name, size: bytes.byteLength, sha256, ...(options.alt ? {alt: options.alt} : {})});
    uploadId = begun.uploadId;
    const chunkBytes = begun.chunkBytes ?? IMAGE_CHUNK_BYTES;
    const indexes: number[] = begun.completedParts ?? [];
    for (let index = 0, offset = 0; offset < bytes.byteLength; index++, offset += chunkBytes) {
      CHECK_ABORT(options.signal);
      if (indexes.includes(index)) continue;
      const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkBytes));
      await send(ids.part(index), 'image_upload_chunk', {uploadId, index, dataBase64: base64(chunk), sha256: await sha256Hex(chunk)});
    }
    CHECK_ABORT(options.signal);
    stage = 'complete';
    const completed = await send(ids.complete, 'image_upload_complete', {uploadId});
    return {artifactId: completed.artifactId, uploadId, mediaType: completed.mediaType, width: completed.width, height: completed.height, size: completed.size, contentHash: completed.contentHash};
  } catch (error) {
    if (error instanceof ImageUploadError) throw error;
    const stageCommand = stage === 'begin' ? ids.begin : stage === 'complete' ? ids.complete : ids.part(0);
    throw new ImageUploadError((error as Error).message, stage, stageCommand, undefined);
  }
}

/** Upload bytes and publish them as one room message with optional caption. */
export async function sendImage(send: ImageCommandSender, bytes: Uint8Array, options: SendImageOptions): Promise<RoomSendImageResult & {artifactId: string}> {
  const uploaded = await uploadImage(send, bytes, options);
  const ids = imageOperationIds(options.operationId);
  try {
    const posted = await send(ids.post, 'room_post', {text: options.text ?? '', attachments: [uploaded.artifactId], ...(options.mentions?.length ? {mentions: options.mentions} : {}), ...(options.replyTo ? {replyTo: options.replyTo} : {})});
    return {artifactId: uploaded.artifactId, messageId: posted.messageId, stage: 'posted', mediaType: uploaded.mediaType, width: uploaded.width, height: uploaded.height};
  } catch (error) {
    throw new ImageUploadError((error as Error).message, 'post', ids.post, uploaded.artifactId);
  }
}

export type { ImageMediaType, RoomSendImageResult };
