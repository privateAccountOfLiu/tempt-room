import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { VERSION, capabilitiesFor, executionSettingsSchema,eventSchema,eventMetadata,EventContractError,projectionTableNames,type ProjectionTable,type ExecutionSettings, type Actor, type AgentDescriptor, type Room, type RoomEvent, type RoomSnapshot, type Run, type Task, type Discussion,type ToolOperation } from '../../../packages/protocol/src/index.ts';
import { MemoryProjectionSink,SqlProjectionSink,projectEvent,projectionJson } from './event-projections.ts';
import type { EventStore } from './ports/event-store.ts';
export const DATABASE_VERSION=18;

export const uid = (prefix = 'id') => `${prefix}_${randomUUID().replaceAll('-', '')}`;
export const now = () => new Date().toISOString();
export const OWNER: Actor = { id: 'owner', kind: 'human' };
export const SYSTEM: Actor = { id: 'system', kind: 'system' };
type Table = 'agents' | 'messages' | 'tasks' | 'runs' | 'artifacts' | 'discussions' | 'decisions' | 'contexts' | 'operations' | 'agent_sessions' | 'subscriptions' | 'inbox_deliveries' | 'input_batches' | 'wake_intents' | 'capability_evidence' | 'discussion_rounds' | 'project_bindings' | 'integrations' | 'usage_samples' | 'budget_reservations' | 'resource_leases' | 'capability_evidence_history';
const tables = new Set(['agents', 'messages', 'tasks', 'runs', 'artifacts', 'discussions', 'decisions','contexts','operations','agent_sessions','subscriptions','inbox_deliveries','input_batches','wake_intents','capability_evidence','discussion_rounds','project_bindings','integrations','usage_samples','budget_reservations','resource_leases','capability_evidence_history']);
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as any)[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

export class Store implements EventStore {
  readonly db: DatabaseSync;
  private transactionEvents: RoomEvent[] | null = null;
  private rebuilding=false;
  readonly listeners = new Set<(event: RoomEvent) => void>();
  constructor(public path: string) {
    mkdirSync(dirname(path), { recursive: true });
    const existed=existsSync(path);
    this.db = new DatabaseSync(path);
    try {
    const version = Number((this.db.prepare('PRAGMA user_version').get() as any).user_version);
    if (version > DATABASE_VERSION) throw new Error('Database version is newer than this application');
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    if(existed&&version<DATABASE_VERSION){this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');copyFileSync(path,`${path}.v${version}.${Date.now()}.bak`);}
    // B02 tables exist before old migrations emit projection checkpoints,
    // even when the database version is still below 10.
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_sessions(id TEXT PRIMARY KEY, room_id TEXT NOT NULL, body TEXT NOT NULL, as_of_seq INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS agent_sessions_room ON agent_sessions(room_id);
CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY, room_id TEXT NOT NULL, body TEXT NOT NULL, as_of_seq INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS subscriptions_room ON subscriptions(room_id);
CREATE TABLE IF NOT EXISTS inbox_deliveries(id TEXT PRIMARY KEY, room_id TEXT NOT NULL, body TEXT NOT NULL, as_of_seq INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS inbox_deliveries_room ON inbox_deliveries(room_id);
CREATE TABLE IF NOT EXISTS input_batches(id TEXT PRIMARY KEY, room_id TEXT NOT NULL, body TEXT NOT NULL, as_of_seq INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS input_batches_room ON input_batches(room_id);
CREATE TABLE IF NOT EXISTS wake_intents(id TEXT PRIMARY KEY, room_id TEXT NOT NULL, body TEXT NOT NULL, as_of_seq INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS wake_intents_room ON wake_intents(room_id);
CREATE TABLE IF NOT EXISTS capability_evidence(id TEXT PRIMARY KEY, room_id TEXT NOT NULL, body TEXT NOT NULL, as_of_seq INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS capability_evidence_room ON capability_evidence(room_id);
CREATE TABLE IF NOT EXISTS discussion_rounds(id TEXT PRIMARY KEY, room_id TEXT NOT NULL, body TEXT NOT NULL, as_of_seq INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS discussion_rounds_room ON discussion_rounds(room_id);
CREATE TABLE IF NOT EXISTS project_bindings(id TEXT PRIMARY KEY, room_id TEXT NOT NULL, body TEXT NOT NULL, as_of_seq INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS project_bindings_room ON project_bindings(room_id);
CREATE TABLE IF NOT EXISTS integrations(id TEXT PRIMARY KEY, room_id TEXT NOT NULL, body TEXT NOT NULL, as_of_seq INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS integrations_room ON integrations(room_id);
CREATE TABLE IF NOT EXISTS usage_samples(id TEXT PRIMARY KEY, room_id TEXT NOT NULL, body TEXT NOT NULL, as_of_seq INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS usage_samples_room ON usage_samples(room_id);
CREATE TABLE IF NOT EXISTS budget_reservations(id TEXT PRIMARY KEY, room_id TEXT NOT NULL, body TEXT NOT NULL, as_of_seq INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS budget_reservations_room ON budget_reservations(room_id);
CREATE TABLE IF NOT EXISTS resource_leases(id TEXT PRIMARY KEY, room_id TEXT NOT NULL, body TEXT NOT NULL, as_of_seq INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS resource_leases_room ON resource_leases(room_id);
CREATE TABLE IF NOT EXISTS capability_evidence_history(id TEXT PRIMARY KEY, room_id TEXT NOT NULL, body TEXT NOT NULL, as_of_seq INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS capability_evidence_history_room ON capability_evidence_history(room_id);`);
    if (version < 1) {
      this.db.exec(`BEGIN;
        CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, seq INTEGER NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(event_id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), seq INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(room_id,seq));
        CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, hash TEXT NOT NULL, receipt TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        ${[...tables].map(t => `CREATE TABLE IF NOT EXISTS ${t}(id TEXT PRIMARY KEY, room_id TEXT, body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS ${t}_room ON ${t}(room_id);`).join('\n')}
        PRAGMA user_version=1; COMMIT;`);
    }
    if(version<2)this.db.exec('BEGIN; CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS contexts(id TEXT PRIMARY KEY,room_id TEXT,body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS contexts_room ON contexts(room_id); PRAGMA user_version=2; COMMIT;');
    if(version<4)this.atomic(()=>{
      this.db.exec('CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,room_id TEXT,body TEXT NOT NULL,as_of_seq INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS operations_room ON operations(room_id);');
      this.db.exec("CREATE INDEX IF NOT EXISTS operations_dedupe ON operations(json_extract(body,'$.runId'),json_extract(body,'$.agentId'),json_extract(body,'$.operationId'),json_extract(body,'$.generation'))");
      for(const table of ['rooms',...projectionTableNames]){
        const columns=this.db.prepare(`PRAGMA table_info(${table})`).all() as any[];
        if(columns.length&&!columns.some(column=>column.name==='as_of_seq'))this.db.exec(`ALTER TABLE ${table} ADD COLUMN as_of_seq INTEGER NOT NULL DEFAULT 0`);
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS projection_offsets(room_id TEXT PRIMARY KEY REFERENCES rooms(id),seq INTEGER NOT NULL,floor_seq INTEGER NOT NULL DEFAULT 0);
        CREATE VIEW IF NOT EXISTS proj_task AS SELECT id,room_id,body,as_of_seq FROM tasks;
        CREATE VIEW IF NOT EXISTS proj_run AS SELECT id,room_id,body,as_of_seq FROM runs;
        CREATE VIEW IF NOT EXISTS proj_artifact AS SELECT id,room_id,body,as_of_seq FROM artifacts;
        CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'event log is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'event log is immutable'); END;`);
      // Historic versions did not record every lease or context change. Seal
      // their current state as a new fact, without rewriting a single old event.
      if(existed&&version<3)for(const room of this.rooms()){
        const rows=Object.fromEntries(projectionTableNames.filter(table=>this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)).map(table=>[table,this.list(table,room.id)]));
        const event=this.event(room.id,'projection.checkpoint',SYSTEM,{room,rows,reason:'legacy-migration'});
        this.db.prepare('UPDATE projection_offsets SET floor_seq=? WHERE room_id=?').run(event.seq,room.id);
      }
      this.db.exec('PRAGMA user_version=4');
    });
    // v5 adds persistent partials and a terminal status older workers cannot
    // interpret. The version gate keeps those workers from reopening this DB.
    if(version<5)this.atomic(()=>this.db.exec('PRAGMA user_version=5'));
    if(version<6)this.atomic(()=>{
      // Room body.seq denotes the last metadata fact, not a mutable read head.
      // Older reducers could serialize either value depending on replay order.
      for(const room of this.rooms()){
        const last=this.db.prepare("SELECT seq FROM events WHERE room_id=? AND json_extract(body,'$.type') IN ('room.created','room.updated','room.members.updated','projection.checkpoint') ORDER BY seq DESC LIMIT 1").get(room.id) as {seq:number}|undefined;
        if(last){const row=this.db.prepare('SELECT body FROM rooms WHERE id=?').get(room.id) as {body:string};this.db.prepare('UPDATE rooms SET body=? WHERE id=?').run(projectionJson({...JSON.parse(row.body),seq:last.seq}),room.id);}
      }
      this.db.exec('PRAGMA user_version=6');
    });
    // v7 gates writers which do not enforce external task input receipts.
    // Existing leases keep their facts and must fetch task_context before completion.
    if(version<7)this.atomic(()=>this.db.exec('PRAGMA user_version=7'));
    // Native operation provenance and explicit receipt reconciliation require v8 writers.
    if(version<8)this.atomic(()=>this.db.exec('PRAGMA user_version=8'));
    // v9 writers understand convergence ballots and the separate summary lifecycle.
    if(version<9)this.atomic(()=>this.db.exec('PRAGMA user_version=9'));
    // v10 adds the B02 collaboration projections. Old databases receive the
    // tables and uniqueness indexes before any new event can be appended.
    if(version<10)this.atomic(()=>{
      for(const table of ['agent_sessions','subscriptions','inbox_deliveries','input_batches','wake_intents','capability_evidence','discussion_rounds','project_bindings','integrations','usage_samples','budget_reservations','resource_leases','capability_evidence_history'])
        this.db.exec(`CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY, room_id TEXT NOT NULL, body TEXT NOT NULL, as_of_seq INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS ${table}_room ON ${table}(room_id);`);
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS inbox_delivery_unique ON inbox_deliveries(json_extract(body,'$.agentSessionId'),json_extract(body,'$.sourceEventId'));
        CREATE UNIQUE INDEX IF NOT EXISTS wake_scope_unique ON wake_intents(json_extract(body,'$.scopeKey'),json_extract(body,'$.sourceEventId'));
        CREATE UNIQUE INDEX IF NOT EXISTS capability_evidence_unique ON capability_evidence(json_extract(body,'$.fingerprint'),json_extract(body,'$.capability'));
        CREATE UNIQUE INDEX IF NOT EXISTS runs_response_slot ON runs(json_extract(body,'$.responseSlotId')) WHERE json_extract(body,'$.responseSlotId') IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS runs_agent_session_active ON runs(json_extract(body,'$.agentSessionId')) WHERE json_extract(body,'$.agentSessionId') IS NOT NULL AND json_extract(body,'$.status') NOT IN ('completed','failed','canceled','superseded','interrupted','unknown');
        PRAGMA user_version=10;`);
    });
if(version<11)this.atomic(()=>{this.db.exec(`CREATE TABLE IF NOT EXISTS project_bindings(id TEXT PRIMARY KEY, room_id TEXT NOT NULL, body TEXT NOT NULL, as_of_seq INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS project_bindings_room ON project_bindings(room_id); CREATE UNIQUE INDEX IF NOT EXISTS project_binding_room_version ON project_bindings(room_id,json_extract(body,'$.version')); PRAGMA user_version=11;`);});
if(version<12)this.atomic(()=>{this.db.exec(`CREATE TABLE IF NOT EXISTS integrations(id TEXT PRIMARY KEY, room_id TEXT NOT NULL, body TEXT NOT NULL, as_of_seq INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS integrations_room ON integrations(room_id); PRAGMA user_version=12;`);});
if(version<13)this.atomic(()=>{this.db.exec(`CREATE TABLE IF NOT EXISTS usage_samples(id TEXT PRIMARY KEY, room_id TEXT NOT NULL, body TEXT NOT NULL, as_of_seq INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS usage_samples_room ON usage_samples(room_id); PRAGMA user_version=13;`);});
if(version<14)this.atomic(()=>{this.db.exec(`CREATE TABLE IF NOT EXISTS budget_reservations(id TEXT PRIMARY KEY, room_id TEXT NOT NULL, body TEXT NOT NULL, as_of_seq INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS budget_reservations_room ON budget_reservations(room_id); PRAGMA user_version=14;`);});
if(version<15)this.atomic(()=>{this.db.exec(`CREATE TABLE IF NOT EXISTS resource_leases(id TEXT PRIMARY KEY, room_id TEXT NOT NULL, body TEXT NOT NULL, as_of_seq INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS resource_leases_room ON resource_leases(room_id); PRAGMA user_version=15;`);});
if(version<16)this.atomic(()=>{this.db.exec(`CREATE TABLE IF NOT EXISTS capability_evidence_history(id TEXT PRIMARY KEY, room_id TEXT NOT NULL, body TEXT NOT NULL, as_of_seq INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS capability_evidence_history_room ON capability_evidence_history(room_id); PRAGMA user_version=16;`);});
    if(version<17)this.atomic(()=>this.db.exec('PRAGMA user_version=17'));
    if(version<18)this.atomic(()=>this.db.exec('PRAGMA user_version=18'));
    this.seed();
    this.atomic(() => {
      for (const run of this.list<Run>('runs')) if (['running', 'waiting_input', 'cancel_requested'].includes(run.status) || (run.status==='queued' && run.codex)) {
        run.generation=(run.generation??1)+1;delete run.executionId;delete run.leaseUntil;
        run.status = run.codex?'unknown':'interrupted'; run.error = run.codex?'服务重启：已有 Codex 后端可能仍在工作，请核对原生队列或轮次；未自动重试。':'服务重启：上次运行已中断，未自动重试。'; run.updatedAt = now();
         this.event(run.roomId, 'run.recovered', SYSTEM, { run });
        if(run.taskId){const task=this.get<Task>('tasks',run.taskId);if(task&&task.version===run.taskVersion){task.status=run.status;this.event(run.roomId,'task.updated',SYSTEM,{task});}}
      }
      for(const operation of this.list<ToolOperation>('operations'))if(operation.status==='started'){operation.status='unknown';operation.updatedAt=now();this.event(operation.roomId,'operation.unknown',SYSTEM,{operation});}
      for(const discussion of this.list<Discussion>('discussions'))if(discussion.status==='active'||discussion.summary?.status==='queued'){
        if(discussion.status==='active'){discussion.status='stopped';discussion.endReason='restart';discussion.endedAt=now();discussion.endedSeq=this.room(discussion.roomId)!.seq;}
        if(discussion.summary?.status==='queued')discussion.summary={...discussion.summary,status:'interrupted',error:'服务重启，总结已中断，未自动重试'};
        this.event(discussion.roomId,'discussion.stopped',SYSTEM,{discussion,reason:'服务重启，讨论需由用户重新开始'});
        for(const run of this.list<Run>('runs',discussion.roomId))if(run.discussionId===discussion.id&&run.status==='queued'){run.status='canceled';run.updatedAt=now();this.event(run.roomId,'run.updated',SYSTEM,{run});}
      }
    });
    } catch(error) {
      try { this.db.close(); } catch { /* Preserve the initialization error. */ }
      throw error;
    }
  }
  private afterCommitQueue: Array<() => void> | null = null;
  readonly afterCommitErrors: string[] = [];
  /** Run only after a successful commit; rollback discards the queue. */
  afterCommit(fn: () => void): void {
    if (this.afterCommitQueue) { this.afterCommitQueue.push(fn); return; }
    fn();
  }
  atomic<T>(fn: () => T): T {
    if(this.rebuilding)throw new Error('Projection rebuild is read-only');
    if (this.transactionEvents) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.transactionEvents = []; this.afterCommitQueue = [];
    let result: T; let events: RoomEvent[]; let afterCommit: Array<() => void>;
    try { result = fn(); this.db.exec('COMMIT'); events = this.transactionEvents; afterCommit = this.afterCommitQueue; }
    catch (error) { this.db.exec('ROLLBACK'); this.transactionEvents = null; this.afterCommitQueue = null; throw error; }
    this.transactionEvents = null; this.afterCommitQueue = null;
    for (const event of events) for (const listener of this.listeners) { try { listener(event); } catch { /* A subscriber cannot roll back committed state. */ } }
    for (const callback of afterCommit) { try { callback(); } catch (error) { this.afterCommitErrors.push((error as Error).message); } }
    return result;
  }
  list<T>(table: Table, roomId?: string): T[] {
    if (!tables.has(table)) throw new Error('Unknown table');
    const rows = roomId ? this.db.prepare(`SELECT body FROM ${table} WHERE room_id=? ORDER BY rowid`).all(roomId) : this.db.prepare(`SELECT body FROM ${table} ORDER BY rowid`).all();
    return rows.map((r: any) => JSON.parse(r.body));
  }
  get<T>(table: Table, id: string): T | undefined {
    if (!tables.has(table)) throw new Error('Unknown table');
    const row = this.db.prepare(`SELECT body FROM ${table} WHERE id=?`).get(id) as any;
    return row ? JSON.parse(row.body) : undefined;
  }
  put(table: Table, value: { id: string; roomId?: string }) {
    if (!tables.has(table)) throw new Error('Unknown table');
    if(this.rebuilding)throw new Error('Projection rebuild is read-only');
    if((projectionTableNames as readonly string[]).includes(table)){
      if(!value.roomId)throw new Error('Projected rows require a roomId');
      const field=({messages:'message',tasks:'task',runs:'run',artifacts:'artifact',discussions:'discussion',decisions:'decision',contexts:'context',operations:'operation',agent_sessions:'agentSession',subscriptions:'subscription',inbox_deliveries:'delivery',input_batches:'batch',wake_intents:'wakeIntent',capability_evidence:'capabilityEvidence',discussion_rounds:'round',project_bindings:'projectBinding',integrations:'integration',usage_samples:'sample',budget_reservations:'reservation',resource_leases:'lease'} as Record<string,string>)[table];
      const type=({messages:'chat.message.created',tasks:'task.updated',runs:'run.updated',artifacts:'artifact.created',discussions:'discussion.round',decisions:(value as any).accepted?'decision.accepted':'decision.proposed',contexts:'context.captured',operations:'operation.'+(value as any).status,agent_sessions:'agent_session.created',subscriptions:'subscription.updated',inbox_deliveries:'inbox.delivered',input_batches:'input.batch.created',wake_intents:'wake.requested',capability_evidence:'capability.verified',discussion_rounds:'discussion.round.opened',project_bindings:'project.bound',integrations:'integration.queued',usage_samples:'usage.recorded',budget_reservations:'budget.reserved',resource_leases:'resource.acquired'} as Record<string,string>)[table];
      this.event(value.roomId,type,SYSTEM,{[field]:value});return;
    }
    this.db.prepare(`INSERT INTO ${table}(id,room_id,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET room_id=excluded.room_id,body=excluded.body`).run(value.id, value.roomId ?? null, JSON.stringify(value));
  }
  rooms(): Room[] { return this.db.prepare('SELECT body,seq FROM rooms ORDER BY rowid').all().map((r: any) => ({ ...JSON.parse(r.body), seq: r.seq })); }
  room(id: string): Room | undefined { const row = this.db.prepare('SELECT body,seq FROM rooms WHERE id=?').get(id) as any; return row ? { ...JSON.parse(row.body), seq: row.seq } : undefined; }
  putRoom(room: Room,actor:Actor=SYSTEM) {
    return this.atomic(()=>{
      const exists=Boolean(this.room(room.id));
      if(!exists)this.db.prepare('INSERT INTO rooms(id,seq,body,as_of_seq) VALUES(?,?,?,0)').run(room.id,0,projectionJson({...room,seq:0}));
      return this.event(room.id,exists?'room.updated':'room.created',actor,{room:exists?room:{...room,seq:0}});
    });
  }
  event(roomId: string, type: string, actor: Actor, payload: Record<string, unknown>, causationId: string | null = null, correlationId: string | null = null): RoomEvent {
    if (!this.transactionEvents) return this.atomic(() => this.event(roomId, type, actor, payload, causationId, correlationId));
    const room = this.room(roomId); if (!room) throw new Error('Room does not exist');
    const metadata=eventMetadata(type,payload,roomId,correlationId);
    if(metadata.baseSeq>room.seq)throw new EventContractError('invalid_event_cursor','事件读取水位不能超出已提交的房间序号');
    const eventId=uid('evt'),createdAt=now();
    const event:RoomEvent=JSON.parse(projectionJson(eventSchema.parse({ version: VERSION, eventId, roomId, seq: room.seq + 1, type, actor:{...actor,type:actor.kind}, payload, causationId, correlationId, createdAt,...metadata,ts:createdAt,idempotencyKey:metadata.idempotencyKey??causationId,traceId:metadata.traceId??eventId })));
    this.db.prepare('UPDATE rooms SET seq=?,as_of_seq=? WHERE id=?').run(event.seq,event.seq, roomId);
    this.db.prepare('INSERT INTO events(event_id,room_id,seq,body) VALUES(?,?,?,?)').run(event.eventId, roomId, event.seq, JSON.stringify(event));
    projectEvent(new SqlProjectionSink(this.db,roomId),event);
    this.db.prepare('INSERT INTO projection_offsets(room_id,seq) VALUES(?,?) ON CONFLICT(room_id) DO UPDATE SET seq=excluded.seq').run(roomId,event.seq);
    const freeze=(value:any)=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}};freeze(event);
    this.transactionEvents.push(event); return event;
  }
  private decodeEvent(body:string):RoomEvent {
    const raw=JSON.parse(body);if(raw.schemaVersion!==undefined)return eventSchema.parse(raw);
    let metadata:any;try{metadata=eventMetadata(raw.type,raw.payload,raw.roomId,raw.correlationId);}catch{metadata={kind:'audit.recorded',aggregate:{type:'room',id:raw.roomId},baseSeq:0,generation:1,replyTo:null};}
    return {...raw,...metadata,schemaVersion:0,durability:'durable',ts:raw.createdAt,idempotencyKey:raw.causationId??null,traceId:raw.correlationId??raw.eventId};
  }
  events(roomId: string, after = 0, limit = 500): RoomEvent[] { return this.db.prepare('SELECT body FROM events WHERE room_id=? AND seq>? ORDER BY seq LIMIT ?').all(roomId, after, Math.min(limit, 2000)).map((r: any) => this.decodeEvent(r.body)); }
  /** Bounded, resumable event scan. Callers capture throughSeq first so new facts append after the snapshot. */
  *scanEvents(roomId: string, options: {afterSeq?: number; throughSeq?: number; pageSize?: number} = {}): Generator<RoomEvent> {
    const afterSeq = options.afterSeq ?? 0, pageSize = Math.max(1, Math.min(options.pageSize ?? 1000, 1000));
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error('Invalid event scan cursor');
    const throughSeq = options.throughSeq ?? this.room(roomId)?.seq ?? 0;
    if (!Number.isSafeInteger(throughSeq) || throughSeq < afterSeq) throw new Error('Invalid event scan watermark');
    let cursor = afterSeq;
    while (cursor < throughSeq) {
      const rows = this.db.prepare('SELECT body FROM events WHERE room_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?').all(roomId, cursor, throughSeq, pageSize) as Array<{body: string}>;
      if (!rows.length) break;
      let last = cursor;
      for (const row of rows) {
        const event = this.decodeEvent(row.body);
        if (event.seq <= last) throw new Error('Event scan cursor did not advance');
        if (event.seq !== last + 1) throw new Error(`Event scan detected a gap after seq ${last}`);
        last = event.seq;
        yield event;
      }
      if (last <= cursor) throw new Error('Event scan cursor did not advance');
      cursor = last;
    }
    if (cursor < throughSeq) throw new Error(`Event scan stopped before watermark ${throughSeq} (at ${cursor})`);
  }
  findPreviousOperation(runId: string, agentId: string, operationId: string): { body: string } | undefined {
    return this.db.prepare("SELECT body FROM operations WHERE json_extract(body,'$.runId')=? AND json_extract(body,'$.agentId')=? AND json_extract(body,'$.operationId')=? ORDER BY json_extract(body,'$.generation') DESC LIMIT 1").get(runId,agentId,operationId) as {body:string}|undefined;
  }
  receipt(id: string): { hash: string; receipt: any } | undefined { const r = this.db.prepare('SELECT hash,receipt FROM commands WHERE id=?').get(id) as any; return r ? { hash: r.hash, receipt: JSON.parse(r.receipt) } : undefined; }
  saveReceipt(id: string, hash: string, receipt: unknown) { this.db.prepare('INSERT INTO commands VALUES(?,?,?)').run(id, hash, JSON.stringify(receipt)); }
  session(key: string): string | undefined { return (this.db.prepare('SELECT value FROM sessions WHERE key=?').get(key) as any)?.value; }
  saveSession(key: string, value: string) { this.db.prepare('INSERT INTO sessions VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  settings():ExecutionSettings {const row=this.db.prepare('SELECT body FROM settings WHERE key=?').get('execution') as any;return executionSettingsSchema.parse(row?JSON.parse(row.body):{});}
  saveSettings(value:ExecutionSettings){const parsed=executionSettingsSchema.parse(value);this.db.prepare('INSERT INTO settings(key,body) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body').run('execution',JSON.stringify(parsed));}
  snapshot(id: string): RoomSnapshot {
    const room = this.room(id); if (!room) throw new Error('Room does not exist');
    return { room, agents: this.list<AgentDescriptor>('agents').filter(a => room.members.includes(a.id)), messages: this.list('messages', id), tasks: this.list('tasks', id), runs: this.list('runs', id), artifacts: this.list('artifacts', id), discussions: this.list('discussions', id), decisions: this.list('decisions', id) };
  }
  projectionStatus(roomId:string){
    const room=this.room(roomId);if(!room)throw new Error('Room does not exist');
    const offset=this.db.prepare('SELECT seq,floor_seq FROM projection_offsets WHERE room_id=?').get(roomId) as any;
    return {roomId,headSeq:room.seq,asOfSeq:Number(offset?.seq??0),historyFloor:Number(offset?.floor_seq??0),consistent:room.seq===Number(offset?.seq??0)};
  }
  /** Deterministic bytes cover both row data and each row's replay watermark. */
  projectionBytes(roomId:string){
    return projectionJson({room:this.db.prepare('SELECT id,seq,body,as_of_seq FROM rooms WHERE id=?').get(roomId),
      offset:this.db.prepare('SELECT seq,floor_seq FROM projection_offsets WHERE room_id=?').get(roomId),
      rows:Object.fromEntries(projectionTableNames.map(table=>[table,this.db.prepare(`SELECT id,body,as_of_seq FROM ${table} WHERE room_id=? ORDER BY id`).all(roomId)]))});
  }
  private checkpointBefore(roomId:string,cursor:number):number {
    const row=this.db.prepare("SELECT seq FROM events WHERE room_id=? AND seq<=? AND json_extract(body,'$.type')='projection.checkpoint' ORDER BY seq DESC LIMIT 1").get(roomId,cursor) as any;
    return Number(row?.seq??0);
  }
  private replay(roomId:string,through:number,start:number,sink:SqlProjectionSink|MemoryProjectionSink,onProgress?:(event:RoomEvent)=>void){
    let cursor=start?start-1:0,count=0;
    while(cursor<through){
      const page=this.events(roomId,cursor,1000).filter(event=>event.seq<=through);
      if(!page.length)throw new Error(`Event log gap after ${cursor}`);
      for(const event of page){
        if(event.seq!==cursor+1)throw new Error(`Event sequence gap: expected ${cursor+1}, received ${event.seq}`);
        projectEvent(sink,event);if(sink instanceof MemoryProjectionSink)sink.advance(event.seq);
        cursor=event.seq;count++;onProgress?.(event);
      }
    }
    return count;
  }
  snapshotAt(roomId:string,cursor:number):RoomSnapshot {
    const status=this.projectionStatus(roomId);
    if(!Number.isSafeInteger(cursor)||cursor<status.historyFloor||cursor>status.headSeq)throw new Error(`Snapshot cursor must be within ${status.historyFloor}..${status.headSeq}`);
    if(cursor===status.headSeq)return this.snapshot(roomId);
    const sink=new MemoryProjectionSink(),start=this.checkpointBefore(roomId,cursor);
    this.replay(roomId,cursor,start,sink);
    return sink.snapshot(this.list<AgentDescriptor>('agents'));
  }
  /** A read transaction pins snapshot, head and tail to the same SQLite view. */
  snapshotWithTail(roomId:string,cursor?:number,limit=1000){
    const ownTransaction=!this.transactionEvents;
    if(ownTransaction)this.db.exec('BEGIN');
    try{
      const status=this.projectionStatus(roomId);
      if(!status.consistent)throw new Error('Projection watermark does not match the room event log');
      const asOfSeq=cursor===undefined||cursor===0?status.headSeq:Math.max(cursor,status.historyFloor),snapshot=this.snapshotAt(roomId,asOfSeq);
      const tail=this.events(roomId,asOfSeq,limit).filter(event=>event.seq<=status.headSeq),nextCursor=tail.at(-1)?.seq??asOfSeq;
      const result={snapshot,asOfSeq,headSeq:status.headSeq,historyFloor:status.historyFloor,tail,nextCursor,hasMore:nextCursor<status.headSeq,reset:cursor!==undefined&&cursor<status.historyFloor};
      if(ownTransaction)this.db.exec('COMMIT');return result;
    }catch(error){if(ownTransaction)this.db.exec('ROLLBACK');throw error;}
  }
  /** Replay the real application projections; a failure rolls every row back. */
  rebuildProjections(roomId:string,fromSeq=0,onProgress?:(event:RoomEvent)=>void){
    if(this.transactionEvents||this.rebuilding)throw new Error('Cannot rebuild inside another write transaction');
    const status=this.projectionStatus(roomId);
    if(!Number.isSafeInteger(fromSeq)||fromSeq<0||fromSeq>status.headSeq)throw new Error('Invalid rebuild cursor');
    const start=this.checkpointBefore(roomId,Math.max(fromSeq,status.historyFloor));
    this.rebuilding=true;let began=false;
    try{
      this.db.exec('BEGIN IMMEDIATE');began=true;
      const sink=new SqlProjectionSink(this.db,roomId);
      for(const table of projectionTableNames)sink.clear(table);
      const events=this.replay(roomId,status.headSeq,start,sink,onProgress);
      this.db.prepare('UPDATE rooms SET seq=?,as_of_seq=? WHERE id=?').run(status.headSeq,status.headSeq,roomId);
      this.db.prepare('UPDATE projection_offsets SET seq=? WHERE room_id=?').run(status.headSeq,roomId);
      const hash=createHash('sha256').update(this.projectionBytes(roomId)).digest('hex');
      this.db.exec('COMMIT');began=false;return {roomId,asOfSeq:status.headSeq,replayedEvents:events,checkpointSeq:start,hash};
    }catch(error){if(began)this.db.exec('ROLLBACK');throw error;}finally{this.rebuilding=false;}
  }
  private seed() {
    if (this.list('agents').length === 0) {
      for (const agent of [
        { id: 'codex', name: 'ChatGPT', provider: 'codex', role: '开发实现与测试', color: 'green', executable: 'codex.exe' },
        { id: 'claude', name: 'Claude', provider: 'claude', role: '架构设计与代码审查', color: 'orange', executable: 'claude.exe' },
        { id: 'deepseek', name: 'DeepSeek', provider: 'deepseek', role: '分析问题并提出独立方案', color: 'blue', executable: '' },
        { id: 'api', name: '自建助手', provider: 'api', role: '自定义 API 助手', color: 'purple' },
        { id: 'remote', name: '远程 Agent', provider: 'a2a', role: 'A2A 远程协作', color: 'teal' },
        { id: 'demo-planner', name: '演示规划员', provider: 'demo', role: '将需求拆解为可验证的步骤（确定性演示）', color: 'purple', enabled: true },
        { id: 'demo-reviewer', name: '演示审阅员', provider: 'demo', role: '检查方案的边界和验证方式（确定性演示）', color: 'teal', enabled: true }
      ]) this.put('agents', { executable: '', endpoint: '', model: '', credentialEnv: '', version: '',runtimeDirectory:'',executionMode:'sandbox',responseFormat:'text',connectionMode:'managed', enabled: false, ...agent,capabilities:capabilitiesFor(agent.provider as AgentDescriptor['provider']) } as AgentDescriptor);
    }
    if (this.rooms().length === 0) this.atomic(() => {
      const room: Room = { id: uid('room'), name: '项目工作室', description: '把想法变成共同完成的工作', members: [...new Set(this.list<AgentDescriptor>('agents').map(a => a.id))], revision: 1, status: 'active', createdAt: now(), seq: 0 };
      this.putRoom(room,OWNER);
      const message = { id: uid('msg'), roomId: room.id, actor: SYSTEM, text: '欢迎来到工作室。使用 @ 点名成员，或开启一场有目标的讨论。演示成员无需模型额度；真实 Agent 需先配置并通过沙箱诊断。', mentions: [], attachments: [], createdAt: now() };
      this.event(room.id, 'chat.message.created', SYSTEM, { message });
    });
  }
  close() { this.db.close(); }
}
