import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { NativeChannel,ExecutionUnknown,RemoteCanceled,runAdapter,type AdapterContext } from '../apps/server/src/adapters.ts';
import { agentSchema } from '../packages/protocol/src/index.ts';

test('native cancellation requires a trusted exit with an empty job',async()=>{
 const host=new EventEmitter() as any;host.cancel=async()=>{host.emit('notification',{type:'sandbox.exit',runId:'r1',exitCode:130,jobEmpty:true});};
 const channel=new NativeChannel(host,'r1');host.emit('notification',{type:'sandbox.started',runId:'r1',appContainer:true,job:true});await channel.terminate();assert.equal(channel.ended,true);channel.dispose();
 const unknown=new NativeChannel(host,'r2');host.emit('notification',{type:'sandbox.started',runId:'r2',appContainer:true,job:true});host.emit('closed','host disconnected');await assert.rejects(unknown.terminate(),ExecutionUnknown);unknown.dispose();
});
test('native RPC failure details survive for diagnosis and redact before publication',async()=>{
 const host=new EventEmitter() as any;host.write=async()=>{};const channel=new NativeChannel(host,'details');
 const result=channel.request('initialize',{});channel.accept({id:1,error:{message:'Internal error',data:{reason:'Cannot open runtime',credential:'selected-secret',request_id:'private-trace'}}});
 await assert.rejects(result,error=>{const publicError=channel.diagnostic(error,['selected-secret']).message;assert.match(publicError,/Cannot open runtime/);assert.ok(!publicError.includes('selected-secret'));assert.ok(!publicError.includes('private-trace'));return true;});channel.dispose();
});
function context(transport:any,extra:Partial<AdapterContext>={}):AdapterContext{return{agent:agentSchema.parse({id:'remote',name:'Remote',provider:'a2a',endpoint:'https://agent.example'}),run:{id:'run1',roomId:'room1',agentId:'remote',status:'running',prompt:'hello',basedOnSeq:1,createdAt:'',updatedAt:''},prompt:'hello',workspace:'',home:'',stateRoot:'',signal:new AbortController().signal,host:{} as any,transport,...extra};}
const response=(body:unknown)=>Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]),{headers:{'content-type':'application/json'}}) as any;
const card={supportedInterfaces:[{protocolVersion:'1.0',protocolBinding:'HTTP+JSON',url:'https://agent.example/a2a'}]};
test('A2A input continuation preserves the opaque task and context identifiers',async()=>{
 let sends=0;const requests:any[]=[];
 const transport=async(url:string,options:any)=>{requests.push({url,options});if(url.includes('.well-known'))return response(card);sends++;if(sends===1)return response({task:{id:'opaque-task',contextId:'opaque-context',status:{state:'TASK_STATE_INPUT_REQUIRED',message:{parts:[{text:'Which file?'}]}}}});return response({task:{id:'opaque-task',contextId:'opaque-context',status:{state:'TASK_STATE_COMPLETED',message:{parts:[{text:'Done'}]}},artifacts:[{name:'report',parts:[{text:'checked'}]}]}});};
 const output=[];for await(const item of runAdapter(context(transport,{requestInput:async question=>{assert.equal(question,'Which file?');return 'main.ts';}})))output.push(item);
 assert.equal(requests[2].options.body.message.taskId,'opaque-task');assert.equal(requests[2].options.body.message.contextId,'opaque-context');assert.equal(requests[2].options.body.message.parts[0].text,'main.ts');assert.ok(output.some(o=>o.type==='remote-task'));assert.ok(output.some(o=>o.type==='text'&&o.text==='Done'));assert.ok(output.some(o=>o.type==='artifact'));
});
test('A2A abort requests cancellation and only confirms an actual canceled state',async()=>{
 const controller=new AbortController();let canceled=false;
 const transport=async(url:string)=>{if(url.includes('.well-known'))return response(card);if(url.endsWith(':cancel')){canceled=true;return response({id:'task',status:{state:'TASK_STATE_CANCELED'}});}return response({task:{id:'task',status:{state:'TASK_STATE_INPUT_REQUIRED'}}});};
 await assert.rejects(async()=>{for await(const item of runAdapter(context(transport,{signal:controller.signal,requestInput:async()=>{controller.abort();throw new Error('aborted');}}))){}},RemoteCanceled);assert.equal(canceled,true);
});
test('A2A refuses credential forwarding to a different interface origin',async()=>{
 await assert.rejects(async()=>{for await(const item of runAdapter(context(async()=>response({supportedInterfaces:[{protocolVersion:'1.0',protocolBinding:'JSONRPC',url:'https://other.example'}]})))){}},/同源/);
});
