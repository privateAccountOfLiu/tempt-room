// Browser-only fixtures. These routes are never registered by the product entry.
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {createApp} from '../apps/server/src/app.ts';
import {uid,SYSTEM} from '../apps/server/src/store.ts';
import type {Run} from '../packages/protocol/src/index.ts';

const parent=resolve('.state/browser-probes');mkdirSync(parent,{recursive:true});
const root=resolve(process.env.ROOM_FIXTURE_STATE_DIR??mkdtempSync(join(parent,'fixture-'))),path=relative(parent,root);
if(!path||path==='..'||path.startsWith('..\\')||path.startsWith('../')||isAbsolute(path))throw new Error('Fixture state must be a dedicated child of .state/browser-probes');
const {app,store,service,worker,token}=await createApp({root,dev:true,startWorker:false});
const roomId=store.rooms()[0].id;
service.execute({version:'0.1',commandId:uid(),roomId,type:'room.update',payload:{name:'浏览器回归 · 流式去重',description:'确定性演示，不调用模型'}});
service.execute({version:'0.1',commandId:uid(),roomId,type:'room.members.set',payload:{members:['demo-planner']}});
const text='流式去重验证：这条回复只应保留一次。';let current:Run|undefined,streamId='';
app.post('/api/fixture/start',()=>{
 if(current)throw new Error('Fixture already started');
 current=service.enqueue(roomId,'demo-planner','deterministic browser fixture',store.room(roomId)!.seq);current.status='running';
 store.atomic(()=>{store.event(roomId,'run.started',SYSTEM,{run:current},null,current!.id);});
 service.execute({version:'0.1',commandId:uid(),roomId,type:'message.send',payload:{text}},{id:'demo-planner',kind:'agent'},{runId:current.id});
 streamId=uid('stream');for(const listener of worker.streamListeners)listener({type:'message.delta',roomId,runId:current.id,messageId:streamId,index:0,text});
 return {roomId,runId:current.id,streamId};
});
app.post('/api/fixture/finish',()=>{
 if(!current)throw new Error('Start the fixture first');
 worker.publishFinalMessage(current,text,streamId);worker.finish(current,'completed');
 return {roomId,runId:current.id,persistedReplies:store.list<any>('messages',roomId).filter(message=>message.actor.kind==='agent'&&message.text===text).length};
});
const port=Number(process.env.ROOM_FIXTURE_PORT??4318);await app.listen({host:'127.0.0.1',port});
writeFileSync(join(parent,'latest.json'),JSON.stringify({root,pid:process.pid,port,roomId},null,2));
console.log(`Browser fixture ready. Open: http://127.0.0.1:${port}/#session=${token}`);
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{void app.close().then(()=>process.exit(0));});
