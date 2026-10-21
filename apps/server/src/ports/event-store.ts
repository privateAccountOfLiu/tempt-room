import type {
  Actor,
  ExecutionSettings,
  Room,
  RoomEvent,
  RoomSnapshot
} from '../../../../packages/protocol/src/index.ts';

/**
 * F01 event-store port. This is the exact subset the collaboration core needs:
 * atomic local append + command receipt, watermark-paged event reads, snapshots
 * and projection queries. SQLite provides the only transaction semantics here;
 * there is deliberately no distributed-transaction abstraction.
 */
export interface EventStore {
  /** Run one callback in the store's local write transaction. */
  atomic<T>(callback: () => T): T;
  /** Run a side effect only after the enclosing transaction commits. */
  afterCommit?(fn: () => void): void;
  /** Append one room event and return the durable event. */
  event(
    roomId: string,
    type: string,
    actor: Actor,
    payload: Record<string, unknown>,
    causationId?: string | null,
    correlationId?: string | null
  ): RoomEvent;
  /** Read events strictly after a watermark, bounded by the store page limit. */
  events(roomId: string, after?: number, limit?: number): RoomEvent[];
  scanEvents(roomId: string, options?: {afterSeq?: number; throughSeq?: number; pageSize?: number}): Generator<RoomEvent>;
  findPreviousOperation(runId: string, agentId: string, operationId: string): {body: string} | undefined;
  receipt(id: string): {hash: string; receipt: any} | undefined;
  saveReceipt(id: string, hash: string, receipt: unknown): void;
  session(key: string): string | undefined;
  saveSession(key: string, value: string): void;
  settings(): ExecutionSettings;
  saveSettings(value: ExecutionSettings): void;
  get<T>(table: string, id: string): T | undefined;
  put(table: string, value: {id: string; roomId?: string}): void;
  putRoom(room: Room, actor?: Actor): void;
  list<T>(table: string, roomId?: string): T[];
  room(id: string): Room | undefined;
  rooms(): Room[];
  snapshot(id: string): RoomSnapshot;
  snapshotAt(roomId: string, cursor: number): RoomSnapshot;
  snapshotWithTail(roomId: string, cursor?: number, limit?: number): unknown;
  projectionStatus(roomId: string): {historyFloor: number; [key: string]: unknown};
  projectionBytes(roomId: string): string;
  rebuildProjections(roomId: string, fromSeq?: number, onProgress?: (event: RoomEvent) => void): void;
  close(): void;
}
