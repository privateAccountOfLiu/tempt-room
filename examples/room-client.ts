import { RoomClient } from '../packages/client/src/index.ts';
// Start the application first. This is a trusted human application client.
// ROOM_TOKEN is the startup token; never pass it to an Agent or publish it.
const token=process.env.ROOM_TOKEN;
if(!token)throw new Error('Set ROOM_TOKEN to the current local startup token');
const client=new RoomClient(process.env.ROOM_URL??'http://127.0.0.1:4317',{token});
const rooms=await client.rooms(),room=rooms[0];
if(!room)throw new Error('No room');
const snapshot=await client.snapshot(room.id);
const unsubscribe=client.subscribe(room.id,snapshot.room.seq,event=>{
  if('eventId'in event)console.log(event.seq,event.type);
});
const commandId=`example_${crypto.randomUUID().replaceAll('-','')}`;
const receipt=await client.command('message.send',{text:'来自 TypeScript 客户端的消息',mentions:[]},room.id,commandId);
console.log(receipt);
// A retry MUST reuse both the commandId and the same payload.
await client.command('message.send',{text:'来自 TypeScript 客户端的消息',mentions:[]},room.id,commandId);
setTimeout(unsubscribe,3000);
