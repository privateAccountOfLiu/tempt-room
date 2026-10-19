import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createApp} from '../apps/server/src/app.ts';
import {uid} from '../apps/server/src/store.ts';
import type {AgentDescriptor,Message} from '../packages/protocol/src/index.ts';
import {RoomAgentClient} from '../packages/client/src/index.ts';

async function setup(t:TestContext){
 const base=resolve('.state/test-data');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'external-'));
 const state=await createApp({root,token:'owner-secret',startWorker:false});
 t.after(async()=>{await state.app.close();assert.ok(root.startsWith(base));rmSync(root,{recursive:true,force:true});});
 const {app,service,store}=state,agentId='demo-planner';
 const ownerHeaders={host:'127.0.0.1:4317',authorization:'Bearer owner-secret','room-protocol-version':'0.1'};
 const room=(name:string)=>service.execute({version:'0.1',commandId:uid(),type:'room.create',payload:{name,members:[agentId]}}).result.roomId as string;
 const roomId=room('First'),otherRoom=room('Second');
 const connected=await app.inject({url:`/api/agents/${agentId}/connect?roomId=${roomId}`,headers:ownerHeaders});assert.equal(connected.statusCode,200);
 const headers={...ownerHeaders,authorization:'Bearer '+connected.json().token};
 const call=(name:string,args:Record<string,unknown>={},commandId=uid(),target=roomId)=>app.inject({method:'POST',url:'/api/agent/tool',headers,payload:{roomId:target,commandId,name,arguments:args}});
 return {...state,root,roomId,otherRoom,agentId,headers,ownerHeaders,call};
}

test('external HTTP binds room and author, enforces protocol version and revokes access',async t=>{
 const {app,store,roomId,otherRoom,agentId,headers,call}=await setup(t);
 assert.equal((await call('room_read')).statusCode,200);
 const before=store.room(otherRoom)!.seq;
 assert.equal((await call('room_read',{},uid(),otherRoom)).statusCode,401);
 assert.equal((await call('room_post',{text:'wrong room'},uid(),otherRoom)).statusCode,401);
 assert.equal(store.room(otherRoom)!.seq,before);
 const payload={roomId,commandId:uid(),name:'room_post',arguments:{text:'forged'},actor:{id:'owner',kind:'human'}};
 assert.equal((await app.inject({method:'POST',url:'/api/agent/tool',headers,payload})).statusCode,400);
 assert.equal((await call('room_post',{text:'unknown permission',sandboxed:true})).statusCode,400);
 assert.equal((await app.inject({method:'POST',url:'/api/agent/tool',headers:{...headers,'room-protocol-version':'0.3'},payload:{roomId,commandId:uid(),name:'room_read'}})).statusCode,426);
 await call('room_post',{text:'bound author'});
 assert.deepEqual(store.list<Message>('messages',roomId).at(-1)!.actor,{id:agentId,kind:'agent'});
 const room=store.room(roomId)!;room.members=[];store.putRoom(room);
 assert.notEqual((await call('room_read')).statusCode,200);
 room.members=[agentId];store.putRoom(room);
 const agent=store.get<AgentDescriptor>('agents',agentId)!;agent.enabled=false;store.put('agents',agent);
 assert.notEqual((await call('room_read')).statusCode,200);
});

test('external message, task and artifact retries retain one result and reject changed content',async t=>{
 const {store,root,roomId,agentId,call}=await setup(t);
 const cases:[string,Record<string,unknown>][]=[['room_post',{text:'one message'}],['task_propose',{title:'one proposal',agentId}],['artifact_publish',{name:'one report',text:'report bytes'}]];
 for(const [name,args] of cases){
  const id=uid(),first=await call(name,args,id),retry=await call(name,args,id);
  assert.equal(first.statusCode,200);assert.equal(retry.statusCode,200);assert.deepEqual(retry.json(),first.json());
  const changed=await call(name,{...args,...(name==='task_propose'?{title:'different'}:{text:'different'})},id);
  assert.equal(changed.statusCode,409);assert.equal(changed.json().code,'idempotency_conflict');
 }
 assert.equal(store.list('messages',roomId).length,1);assert.equal(store.list('tasks',roomId).length,1);assert.equal(store.list('artifacts',roomId).length,1);
 assert.equal(readdirSync(join(root,'artifacts')).length,1);
});

test('external wait pages every message in order without skipping a busy event backlog',async t=>{
 const {store,service,roomId,call}=await setup(t),start=store.room(roomId)!.seq;
 store.atomic(()=>{for(let i=0;i<1010;i++)store.event(roomId,'audit.recorded',{id:'system',kind:'system'},{action:'fixture.progress',index:i});});
 for(let i=0;i<45;i++)service.execute({version:'0.1',commandId:uid(),roomId,type:'message.send',payload:{text:`message ${i}`}});
 let cursor=start;const received:Message[]=[];
 for(let page=0;page<3;page++){
  const response=await call('room_wait',{afterSeq:cursor,timeoutMs:500});assert.equal(response.statusCode,200);
  const result=response.json().result;assert.equal(result.timeout,false);assert.ok(result.throughSeq>cursor);
  cursor=result.throughSeq;received.push(...result.messages);
 }
 assert.deepEqual(received.map(message=>message.text),Array.from({length:45},(_,i)=>`message ${i}`));
 assert.equal(new Set(received.map(message=>message.id)).size,45);
 assert.equal((await call('room_wait',{afterSeq:store.room(roomId)!.seq+1000,timeoutMs:500})).json().code,'invalid_cursor');
});

test('a pending external wait does not disclose messages after room membership is removed',async t=>{
 const {store,roomId,call}=await setup(t),cursor=store.room(roomId)!.seq;
 const pending=call('room_wait',{afterSeq:cursor,timeoutMs:1000});
 const timer=setTimeout(()=>{const room=store.room(roomId)!;room.members=[];store.putRoom(room);},50);
 try{const response=await pending;assert.equal(response.statusCode,403);assert.equal(response.json().code,'forbidden');}finally{clearTimeout(timer);}
});

test('Agent SDK retains the command across a lost response and rejects a different room locally',async t=>{
 const {app,store,roomId,headers}=await setup(t);let loseResponse=true;
 const transport=(async(input:any,init:any)=>{
  const url=new URL(String(input));const response=await app.inject({url:url.pathname,method:init.method,headers:{host:url.host,...init.headers},payload:init.body});
  if(loseResponse){loseResponse=false;throw new Error('Response lost after commit');}
  return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});
 }) as typeof fetch;
 const client=new RoomAgentClient('http://127.0.0.1:4317',roomId,headers.authorization.slice(7),{fetch:transport});
 const command=client.prepare('room_post',{text:'once despite transport loss'});
 await assert.rejects(client.send(command),(error:any)=>error.commandId===command.commandId);
 const retried:any=await client.send(command);assert.equal(retried.accepted,true);
 assert.equal(store.list<Message>('messages',roomId).length,1);
 await assert.rejects(client.send({...command,roomId:'another_room'}),/another room/);
});
