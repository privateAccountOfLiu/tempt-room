/**
 * Shared, dependency-free image transfer helper for the managed host bridge and
 * external room MCP connector. It reads a local image inside explicit roots and
 * performs the bounded begin -> chunks -> complete (+ optional post) sequence
 * over the caller's room RPC transport. It never sends local paths to the room
 * server and keeps every frame small.
 */
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const IMAGE_CHUNK_BYTES = 192 * 1024;
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Same stable id derivation as packages/protocol/src/images.ts. */
function operationIds(rootOperationId) {
  const root = createHash('sha256').update(rootOperationId).digest('hex');
  return {
    begin: `img_begin_${root.slice(0, 40)}`,
    part: index => `img_part_${root.slice(0, 32)}_${index}`,
    complete: `img_complete_${root.slice(0, 36)}`,
    post: `img_post_${root.slice(0, 44)}`
  };
}

export function imageRoots(env = process.env, cwd = process.cwd()) {
  const configured = String(env.ROOM_IMAGE_ROOTS ?? '').split(delimiter).map(part => part.trim()).filter(Boolean);
  return (configured.length ? configured : [cwd]).map(root => resolve(root));
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function inside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !isAbsolute(rel));
}

/**
 * Read one regular local image without following symlinks/junctions. Reads via
 * a handle and checks the size/hash twice so a file that changes mid-read is
 * rejected rather than uploaded as a mixed version.
 */
export function readLocalImage(file, roots, maxBytes = IMAGE_MAX_BYTES) {
  const raw = String(file ?? '');
  if (!raw || raw.length > 2000) fail('image_path_invalid', '图片路径缺失或过长');
  const windowsDrive = /^[a-zA-Z]:[\\/]/.test(raw);
  if ((!windowsDrive && /^[a-z][a-z0-9+.-]*:/i.test(raw)) || raw.startsWith('\\\\') || raw.startsWith('//') || raw.startsWith('\\?\\')) fail('image_path_invalid', '不接受 URL、UNC 或设备路径');
  if (!isAbsolute(raw)) fail('image_path_invalid', '图片路径必须是绝对路径');
  if (raw.includes('\0')) fail('image_path_invalid', '图片路径包含非法字符');
  if (raw.slice(2).includes(':')) fail('image_path_invalid', '不接受备用数据流路径');
  const target = resolve(raw);
  const rawRoot = roots.find(root => inside(root, target));
  if (rawRoot) {
    for (let probe = target; inside(rawRoot, probe); probe = dirname(probe)) {
      let info;
      try { info = lstatSync(probe); } catch { fail('image_not_found', '图片文件不存在'); }
      if (info.isSymbolicLink()) fail('image_path_denied', '图片路径包含符号链接');
      if (probe === rawRoot) break;
    }
  }
  const canonical = (() => { try { return realpathSync(target); } catch { fail('image_not_found', '图片文件不存在'); } })();
  const allowed = roots.some(root => inside(root, canonical));
  if (!allowed) fail('image_path_denied', '图片不在允许的本地根目录内');
  // Reject symlink/junction ancestors and require a regular target file.
  const targetInfo = lstatSync(canonical);
  if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) fail('image_path_denied', '图片路径必须是普通文件');
  for (let parent = dirname(canonical); ; parent = dirname(parent)) {
    if (lstatSync(parent).isSymbolicLink()) fail('image_path_denied', '图片路径包含符号链接');
    if (dirname(parent) === parent) break;
  }
  const fd = openSync(canonical, 'r');
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) fail('image_path_invalid', '图片路径必须是普通文件');
    if (before.size < 1 || before.size > maxBytes) fail('image_size', '图片字节数超出限制');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = readSync(fd, bytes, offset, bytes.byteLength - offset, offset);
      if (read <= 0) fail('image_read_failed', '图片读取未完成');
      offset += read;
    }
    const after = fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || sha(bytes) === '') fail('image_changed', '图片在读取期间发生变化');
    return {bytes, name: raw.split(/[\\/]/).at(-1), sha256: sha(bytes), size: bytes.byteLength};
  } finally { closeSync(fd); }
}

function base64(bytes) {
  return bytes.toString('base64');
}

/** Upload bytes through the room's low-level image tools. */
export async function uploadImage(call, bytes, options) {
  if (!bytes?.byteLength) fail('image_empty', '图片为空');
  const ids = operationIds(options.operationId);
  const hash = sha(bytes);
  let uploadId = '';
  let stage = 'begin';
  try {
    const begun = await call('image_upload_begin', {name: options.name, size: bytes.byteLength, sha256: hash, ...(options.alt ? {alt: options.alt} : {})}, ids.begin);
    uploadId = begun.uploadId;
    const chunkBytes = begun.chunkBytes ?? IMAGE_CHUNK_BYTES;
    const existing = new Set(begun.completedParts ?? []);
    for (let index = 0, offset = 0; offset < bytes.byteLength; index++, offset += chunkBytes) {
      stage = 'chunk';
      const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkBytes));
      if (existing.has(index)) continue;
      await call('image_upload_chunk', {uploadId, index, dataBase64: base64(chunk), sha256: sha(chunk)}, ids.part(index));
    }
    stage = 'complete';
    const completed = await call('image_upload_complete', {uploadId}, ids.complete);
    return {artifactId: completed.artifactId, uploadId, mediaType: completed.mediaType, width: completed.width, height: completed.height, size: completed.size, contentHash: completed.contentHash};
  } catch (error) {
    if (error?.stage) throw error;
    const wrapped = new Error(error?.message ?? String(error));
    wrapped.code = error?.code ?? 'image_upload_failed';
    wrapped.stage = stage;
    wrapped.commandId = stage === 'begin' ? ids.begin : stage === 'complete' ? ids.complete : ids.part(0);
    if (uploadId) wrapped.uploadId = uploadId;
    throw wrapped;
  }
}

/** Upload an image and publish it as a public room message. */
export async function sendImage(call, bytes, options) {
  const image = await uploadImage(call, bytes, options);
  const ids = operationIds(options.operationId);
  try {
    const posted = await call('room_post', {text: options.text ?? '', attachments: [image.artifactId], ...(options.mentions?.length ? {mentions: options.mentions} : {}), ...(options.replyTo ? {replyTo: options.replyTo} : {})}, ids.post);
    return {...image, messageId: posted?.result?.messageId ?? posted?.messageId, stage: 'posted'};
  } catch (error) {
    const wrapped = new Error(error?.message ?? String(error));
    wrapped.code = error?.code ?? 'image_post_failed';
    wrapped.stage = 'post';
    wrapped.commandId = ids.post;
    wrapped.artifactId = image.artifactId;
    throw wrapped;
  }
}

/** MCP-facing convenience: read inside configured roots then send. */
export async function roomSendImage(call, args, roots) {
  if (typeof args?.path !== 'string') fail('image_path_invalid', 'path 必须是本地绝对文件路径');
  if (typeof args?.operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(args.operationId)) fail('operation_id_invalid', 'operationId 必须是 1-128 字符的稳定标识');
  const file = readLocalImage(args.path, roots);
  return sendImage(call, file.bytes, {name: file.name, operationId: args.operationId, text: args.text, alt: args.alt, mentions: args.mentions, replyTo: args.replyTo});
}

export const roomSendImageTool = {
  name: 'room_send_image',
  description: 'Upload a local PNG/JPEG/WebP image and post it to the room. path is read only by this connector inside ROOM_IMAGE_ROOTS (or its working directory); the room server never receives the path. Reuse the same operationId when retrying.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {type: 'string', description: 'Absolute local image path; read only by this connector.'},
      text: {type: 'string', description: 'Optional caption; empty means a pure image message.'},
      alt: {type: 'string', maxLength: 1000},
      mentions: {type: 'array', items: {type: 'string'}},
      replyTo: {type: 'string'},
      operationId: {type: 'string', pattern: '^[a-zA-Z0-9_-]{1,128}$', description: 'Stable root operation ID. Reuse it for retries of the same image/message.'}
    },
    required: ['path', 'operationId'],
    additionalProperties: false
  }
};
