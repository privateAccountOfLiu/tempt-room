// Deterministic local acceptance for the image message pipeline. It never calls
// a model, network, host pipe or external MCP; transport-specific evidence is
// recorded by the managed/external tool tests and browser E2E instead.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { Store } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { ImageUploads } from '../apps/server/src/image-uploads.ts';

const check = process.argv.includes('--check');
if (!check) { console.error('usage: tsx scripts/acceptance-room-images.ts --check'); process.exit(2); }
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const stateRoot = resolve('.state', 'acceptance-room-images');
mkdirSync(stateRoot, {recursive: true});
const root = mkdtempSync(join(stateRoot, 'run-'));
const store = new Store(join(root, 'room.sqlite'));
const service = new RoomService(store);
const uploads = new ImageUploads(store, root);
const roomId = store.rooms()[0].id, agentId = 'demo-planner';
let ok = false;
try {
  const bytes = await sharp({create: {width: 32, height: 18, channels: 3, background: '#3a78c2'}}).png().toBuffer();
  const upload = uploads.begin({roomId, agentId, rootOperationId: 'acceptance_root', name: 'acceptance.png', size: bytes.byteLength, sha256: sha(bytes), alt: 'acceptance fixture'});
  const chunk = await uploads.chunk(upload.uploadId, 0, bytes, sha(bytes), {roomId, agentId});
  const image = await uploads.finalize(upload.uploadId, {roomId, agentId});
  const artifact = store.get<any>('artifacts', image.artifactId);
  const preview = readFileSync(join(root, 'artifacts', `${image.artifactId}.preview.png`));
  const exported = JSON.stringify(store.events(roomId));
  const post = service.execute({version: '0.1', commandId: 'acceptance_post', roomId, type: 'message.send', payload: {text: '', attachments: [image.artifactId]}});
  const checks = {
    artifactCreated: Boolean(artifact),
    verifiedImage: artifact?.image?.verified === true && artifact.image.width === 32 && artifact.image.height === 18,
    chunkAccepted: chunk.acceptedBytes === bytes.byteLength,
    previewHash: sha(preview) === artifact?.image?.previewHash && preview.byteLength === artifact?.image?.previewSize,
    messageAttachment: store.snapshot(roomId).messages.some(message => message.id === post.result.messageId && message.attachments.includes(image.artifactId)),
    noBase64InEvents: !exported.includes('dataBase64'),
    noLocalRootInEvents: !exported.includes(root),
    imageSchemasPresent: ['image-metadata', 'image-upload-begin', 'image-upload-chunk', 'image-upload-complete', 'room-send-image-args'].every(name => existsSync(resolve('packages/protocol/schema', `${name}.schema.json`)))
  };
  ok = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({ok, mode: 'check', modelRequests: 0, checks, artifactId: image.artifactId, messageId: post.result.messageId}, null, 2));
} finally {
  try { store.close(); } catch { /* noop */ }
  rmSync(root, {recursive: true, force: true});
}
if (!ok) process.exitCode = 1;
