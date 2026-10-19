import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { runAdapter,type AdapterContext } from '../apps/server/src/adapters.ts';
import { agentSchema,capabilitiesFor } from '../packages/protocol/src/index.ts';

function context(transport:any,structured=true):AdapterContext{return {agent:agentSchema.parse({id:'custom',name:'Custom',provider:'api',endpoint:'https://model.example/v1',model:'configured-model',responseFormat:structured?'room-json':'text'}),run:{id:'run-api',roomId:'room-api',agentId:'custom',status:'running',prompt:'make report',basedOnSeq:1,createdAt:'',updatedAt:''},prompt:'make report',workspace:'',home:'',stateRoot:'',signal:new AbortController().signal,host:{} as any,transport};}
const json=(value:unknown)=>Object.assign(Readable.from([Buffer.from(JSON.stringify(value))]),{headers:{'content-type':'application/json'}}) as any;
const stream=(frames:unknown[])=>Object.assign(Readable.from(frames.map(frame=>Buffer.from(`data: ${JSON.stringify(frame)}\n\n`)).concat(Buffer.from('data: [DONE]\n\n'))),{headers:{'content-type':'text/event-stream'}}) as any;
async function collect(ctx:AdapterContext){const result=[];for await(const output of runAdapter(ctx))result.push(output);return result;}
test('custom API structured replies use explicit JSON mode and publish validated artifacts',async()=>{
 let sent:any;
 const result=await collect(context(async(url:string,options:any)=>{assert.equal(url,'https://model.example/v1/chat/completions');sent=options.body;return json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({message:'Report ready',artifacts:[{name:'review.md',text:'# Checked',mediaType:'text/markdown'}]})}}],usage:{prompt_tokens:10,completion_tokens:20}});}));
 assert.deepEqual(sent.response_format,{type:'json_object'});assert.equal(sent.model,'configured-model');assert.ok(sent.messages[0].content.includes('JSON'));assert.equal(sent.tools,undefined);
 assert.deepEqual(result,[{type:'usage',usage:{inputTokens:10,outputTokens:20}},{type:'text',text:'Report ready'},{type:'artifact',name:'review.md',text:'# Checked',mediaType:'text/markdown'}]);
 assert.equal(capabilitiesFor('api',{responseFormat:'room-json'}).artifacts,true);assert.equal(capabilitiesFor('api',{responseFormat:'text'}).artifacts,false);
});
test('structured stream fragments are buffered until complete JSON and schema validation',async()=>{
 const content=JSON.stringify({message:'Done',artifacts:[{name:'data.json',text:'{"passed":true}',mediaType:'application/json'}]});
 const result=await collect(context(async()=>stream([{choices:[{delta:{content:content.slice(0,30)}}]},{choices:[{delta:{content:content.slice(30)},finish_reason:'stop'}]}])));
 assert.equal(result.length,2);assert.equal(result[0].type,'text');assert.deepEqual(result[1],{type:'artifact',name:'data.json',text:'{"passed":true}',mediaType:'application/json'});
 const invalid=context(async()=>json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({message:'Must not be published',artifacts:[{name:'x',text:'x',path:'../host'}]})}}]}));
 const published:unknown[]=[];await assert.rejects(async()=>{for await(const item of runAdapter(invalid))published.push(item);});assert.deepEqual(published,[]);
});
test('API truncation or missing completion markers fail instead of reporting success',async()=>{
 const outputs:unknown[]=[];
 await assert.rejects(async()=>{for await(const item of runAdapter(context(async()=>json({choices:[{finish_reason:'length',message:{content:'partial'}}],usage:{prompt_tokens:4,completion_tokens:5}}),false)))outputs.push(item);},/完成标志/);
 assert.deepEqual(outputs,[{type:'usage',usage:{inputTokens:4,outputTokens:5}}]);
 await assert.rejects(()=>collect(context(async()=>stream([{choices:[{delta:{content:'partial'}}]}]),false)),/完成标志/);
});
