import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Plain ESM connector helpers are also used by the standalone runner.
import {parseAgentOutput,heartbeatDelayMs} from '../scripts/room-runner-output.mjs';

test('external runner publishes only completed top-level text and keeps the correct session',()=>{
 const frames=[{type:'system',subtype:'init',session_id:'parent'},{type:'assistant',message:{content:[{type:'thinking',thinking:'private reasoning'}]}},{type:'result',parent_tool_use_id:'child',session_id:'child',result:'private child result'},{type:'result',subtype:'success',session_id:'parent',result:'public answer'}];
 assert.deepEqual(parseAgentOutput(frames.map(frame=>JSON.stringify(frame)).join('\n')),{text:'public answer',sessionId:'parent'});
 assert.deepEqual(parseAgentOutput('plain CLI answer'),{text:'plain CLI answer',sessionId:undefined});
 for(const frames of [[{type:'assistant',message:{content:[{type:'thinking',thinking:'private'}]}}],[{type:'result',subtype:'error_during_execution',result:'failure',is_error:true}],[{type:'result',subtype:'success'}]])assert.throws(()=>parseAgentOutput(frames.map(frame=>JSON.stringify(frame)).join('\n')));
 assert.throws(()=>parseAgentOutput(JSON.stringify({type:'system',subtype:'init'})+'\ninvalid line'));
});

test('external heartbeat renews before short leases expire and refuses expired or invalid leases',()=>{
 const now=Date.now();
 assert.ok(heartbeatDelayMs(new Date(now+5000).toISOString(),now)<2000);
 assert.ok(heartbeatDelayMs(new Date(now+600000).toISOString(),now)<=30000);
 assert.throws(()=>heartbeatDelayMs(new Date(now).toISOString(),now));
 assert.throws(()=>heartbeatDelayMs('invalid',now));
});
