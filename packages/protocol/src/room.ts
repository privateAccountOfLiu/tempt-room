import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const time = z.string().datetime();
const shortText = z.string().max(300);

/**
 * Room lifecycle stays JSON-body-only on purpose: old events have no new
 * fields, and normalizeRoom() supplies active/revision defaults at read time.
 * Commands that mutate lifecycle must compare expectedRevision and append a
 * dedicated event rather than rewriting an older room payload.
 */
export const roomStatusSchema = z.enum(['active', 'deleting', 'deleted']);
export type RoomStatus = z.infer<typeof roomStatusSchema>;

export const roomDeletionSchema = z.object({
  requestedAt: time,
  requestedBy: id,
  commandId: id,
  deletedAt: time.optional(),
  pendingReasons: z.array(z.string().min(1).max(200)).max(20).default([])
}).strict();
export type RoomDeletion = z.infer<typeof roomDeletionSchema>;

export const roomSchema = z.object({
  id,
  name: z.string().min(1).max(80),
  description: shortText,
  members: z.array(id).max(30),
  createdAt: time,
  seq: z.number().int().nonnegative(),
  revision: z.number().int().positive().optional(),
  status: roomStatusSchema.optional(),
  deletion: roomDeletionSchema.optional()
}).passthrough();
export type Room = z.infer<typeof roomSchema>;
export type NormalizedRoom = Room & {revision: number; status: RoomStatus};

/** Read-only defaults; never writes back into historic event bytes. */
export function normalizeRoom(room: Room): NormalizedRoom {
  return {...room, revision: room.revision ?? 1, status: room.status ?? 'active'};
}

/** One complete settings/members update, guarded by the room revision. */
export const roomConfigurePayloadSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(300).default(''),
  members: z.array(id).max(30),
  expectedRevision: z.number().int().positive()
}).strict();
export type RoomConfigurePayload = z.infer<typeof roomConfigurePayloadSchema>;

/** Request deletion; the actual deletion may still wait for pending reasons. */
export const roomDeletePayloadSchema = z.object({
  expectedRevision: z.number().int().positive()
}).strict();
export type RoomDeletePayload = z.infer<typeof roomDeletePayloadSchema>;

/** Optional revision guard for legacy room.update/room.members.set callers. */
export const roomLegacyMutationSchema = z.object({
  expectedRevision: z.number().int().positive().optional()
}).passthrough();
