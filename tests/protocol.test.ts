import test from 'node:test';
import assert from 'node:assert/strict';
import { agentSchema, commandSchema, eventSchema, VERSION } from '../packages/protocol/src/index.ts';
import { publicAddress } from '../apps/server/src/network.ts';
import { parseClaudeFrame } from '../apps/server/src/adapters.ts';

test('protocol negotiation rejects unknown versions and forged authors',()=>{
  const valid={version:VERSION,commandId:'cmd_1',roomId:'room_1',type:'message.send',payload:{text:'hello'}};
  assert.equal(commandSchema.safeParse(valid).success,true);
  assert.equal(commandSchema.safeParse({...valid,version:'0.3'}).success,false);
  assert.equal(commandSchema.safeParse({...valid,actor:{id:'owner',kind:'human'}}).success,false);
  assert.equal(commandSchema.safeParse({...valid,commandId:'../../state'}).success,false);
});
test('network boundary rejects local, private, mapped and reserved addresses',()=>{
  for(const ip of ['127.0.0.1','10.1.1.1','172.16.1.1','192.168.0.1','169.254.169.254','100.64.1.1','0.0.0.0','224.0.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','64:ff9b::7f00:1','2001:db8::1'])assert.equal(publicAddress(ip),false,ip);
  assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true);
});
test('Claude adapter parses text without leaking reasoning or subagent output',()=>{
  assert.deepEqual(parseClaudeFrame({type:'stream_event',event:{delta:{type:'text_delta',text:'hello'}}}),[{type:'text',text:'hello'}]);
  assert.deepEqual(parseClaudeFrame({type:'stream_event',event:{delta:{type:'thinking_delta',thinking:'private'}}}),[]);
  assert.deepEqual(parseClaudeFrame({type:'stream_event',parent_tool_use_id:'child',event:{delta:{type:'text_delta',text:'child'}}}),[]);
  assert.deepEqual(parseClaudeFrame({type:'result',total_cost_usd:0.12,usage:{input_tokens:10,output_tokens:20}}),[{type:'usage',usage:{inputTokens:10,outputTokens:20,costUsd:0.12}}]);
});

test('Agent execution mode defaults to sandbox and accepts explicit host trust',()=>{
  const base={id:'claude',name:'Claude',provider:'claude'};
  assert.equal(agentSchema.parse(base).executionMode,'sandbox');
  assert.equal(agentSchema.parse({...base,executionMode:'host'}).executionMode,'host');
  assert.equal(agentSchema.safeParse({...base,executionMode:'root'}).success,false);
});