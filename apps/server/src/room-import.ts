import { createHash } from 'node:crypto';

export interface ImportedEvent {
  eventId?: string;
  seq?: number;
  type: string;
  actor?: unknown;
  payload: unknown;
  [key: string]: unknown;
}

export interface RoomExportLike {
  version?: string;
  room: Record<string, any>;
  events: ImportedEvent[];
}

export interface RoomImportPlan {
  room: Record<string, any>;
  events: ImportedEvent[];
  remappedIds: number;
  idMap: Record<string,string>;
  seqMap: Record<number,number>;
}

const idPattern = /^[a-z][a-z0-9]*_[a-z0-9]{6,}$/i;

/** Plan a room import by remapping every globally unique projection id and the
 * old room id. Agent ids and actor identities are preserved. */
export function planRoomImport(source: RoomExportLike, options: {newRoomId: string; name?: string; salt: string; now?: string}): RoomImportPlan {
  if (!source || typeof source !== 'object' || !source.room || !Array.isArray(source.events)) throw new Error('invalid room export');
  if (source.events.length > 100_000) throw new Error('room export is too large');
  const oldRoomId = String(source.room.id);
  if (!oldRoomId) throw new Error('room export has no room id');
  const agentIds = new Set<string>((source.room.members ?? []).map(String));
  for (const event of source.events) {
    const actor = event.actor as any;
    if (actor?.kind === 'agent' && typeof actor.id === 'string') agentIds.add(actor.id);
  }
  const ids = new Map<string, string>();
  const collect = (value: any) => {
    if (typeof value === 'string') {
      if (value !== oldRoomId && !agentIds.has(value) && idPattern.test(value) && ids.size < 100_000) {
        const prefix = value.slice(0, value.indexOf('_'));
        const digest = createHash('sha256').update(`${options.salt}\0${value}`).digest('hex').slice(0, 24);
        ids.set(value, `${prefix}_${digest}`);
      }
      return;
    }
    if (Array.isArray(value)) { for (const item of value) collect(item); return; }
    if (value && typeof value === 'object') for (const item of Object.values(value)) collect(item);
  };
  for (const event of source.events) collect(event.payload);
  const seqKeys = new Set(['basedOnSeq','throughSeq','fromSeq','headSeq','contextSeq','scanSeq','fromScanSeq','throughScanSeq','sourceSeq','seq','nextSeq']);
  const seqMap = new Map<number,number>();
  const replace = (value: any, key?: string): any => {
    if (typeof value === 'number' && key && seqKeys.has(key) && seqMap.has(value)) return seqMap.get(value);
    if (typeof value === 'string') return value === oldRoomId ? options.newRoomId : ids.get(value) ?? value;
    if (Array.isArray(value)) return value.map(item => replace(item, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, replace(item, childKey)]));
    return value;
  };
  const createdAt = options.now ?? new Date().toISOString();
  const room = {
    ...replace(source.room),
    id: options.newRoomId,
    name: String(options.name ?? source.room.name ?? '导入房间').slice(0, 80),
    seq: 0,
    createdAt
  };
  const events: ImportedEvent[] = [];
  let inserted = 0;
  for (const event of source.events) {
    if (!event || typeof event.type !== 'string') continue;
    const skipped = ['room.created', 'room.updated', 'projection.checkpoint'].includes(event.type);
    if (!skipped) inserted++;
    if (typeof event.seq === 'number') seqMap.set(event.seq, inserted);
    if (!skipped) events.push({...event, payload: replace(event.payload ?? {})});
  }
  return {room, events, remappedIds: ids.size, idMap: Object.fromEntries(ids), seqMap: Object.fromEntries(seqMap)};
}
