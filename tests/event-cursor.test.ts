import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomEventCursor} from '../packages/client/src/event-cursor.ts';
import type {RoomEvent} from '../packages/protocol/src/index.ts';

const event=(seq:number):RoomEvent=>({version:'0.1',eventId:`event_${seq}`,roomId:'room_test',seq,type:'audit.recorded',kind:'audit.recorded',schemaVersion:1,durability:'durable',actor:{id:'system',kind:'system'},aggregate:{type:'room',id:'room_test'},createdAt:'2026-10-18T00:00:00.000Z',ts:'2026-10-18T00:00:00.000Z',causationId:null,correlationId:null,baseSeq:0,generation:1,replyTo:null,idempotencyKey:null,traceId:'trace_test',payload:{action:'cursor-test'}});
test('out-of-order live events are REST-repaired, then duplicate frames are ignored',async()=>{
  const delivered:number[]=[],loads:number[]=[],cursor=new RoomEventCursor('room_test',0,async after=>{loads.push(after);return Array.from({length:5},(_,i)=>event(i+1)).filter(frame=>frame.seq>after);},frame=>delivered.push(frame.seq));
  await cursor.accept(event(5));await cursor.accept(event(2));await cursor.accept(event(5));await cursor.accept(event(6));
  assert.deepEqual(delivered,[1,2,3,4,5,6]);assert.deepEqual(loads,[0]);assert.equal(cursor.seq,6);
});
test('gap repair pages a backlog without skipping or counting duplicate REST events',async()=>{
  const delivered:number[]=[],loads:number[]=[],cursor=new RoomEventCursor('room_test',1,async after=>{loads.push(after);return [event(after),event(after+1),event(after+2)];},frame=>delivered.push(frame.seq));
  await cursor.accept(event(8));assert.deepEqual(delivered,[2,3,4,5,6,7,8]);assert.deepEqual(loads,[1,3,5]);
});
test('a missing REST fact or invalid sequence fails without consuming the live event',async()=>{
  const delivered:number[]=[],cursor=new RoomEventCursor('room_test',1,async()=>[],frame=>delivered.push(frame.seq));
  await assert.rejects(cursor.accept(event(4)),/gap/);assert.equal(cursor.seq,1);assert.deepEqual(delivered,[]);
  const malformed=new RoomEventCursor('room_test',1,async()=>[event(3),event(2)],()=>{});
  await assert.rejects(malformed.accept(event(4)),/contiguous/);assert.equal(malformed.seq,1);
});
test('cross-room frames and reused event identifiers cannot corrupt a cursor',async()=>{
  const cursor=new RoomEventCursor('room_test',0,async()=>[],()=>{});
  await assert.rejects(cursor.accept({...event(1),roomId:'another_room'}),/envelope/);
  await cursor.accept(event(1));await assert.rejects(cursor.accept({...event(2),eventId:'event_1'}),/reused/);assert.equal(cursor.seq,1);
});
test('a consumer failure leaves the event replayable',async()=>{
  let fail=true;const delivered:number[]=[],cursor=new RoomEventCursor('room_test',0,async()=>[],frame=>{if(fail)throw new Error('consumer failed');delivered.push(frame.seq);});
  await assert.rejects(cursor.accept(event(1)),/consumer/);assert.equal(cursor.seq,0);fail=false;await cursor.accept(event(1));assert.deepEqual(delivered,[1]);
});
