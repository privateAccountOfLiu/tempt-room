import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexOutputParser,answerCodexQuestions } from '../apps/server/src/codex.ts';

test('Codex message deduplication is per item and never discards a later final item',()=>{
 const parser=new CodexOutputParser();
 assert.deepEqual(parser.accept({method:'item/agentMessage/delta',params:{itemId:'commentary',delta:'Working'}}),[{type:'text',text:'Working'}]);
 assert.deepEqual(parser.accept({method:'item/completed',params:{item:{id:'commentary',type:'agentMessage',text:'Working'}}}),[]);
 const final={method:'item/completed',params:{item:{id:'final',type:'agentMessage',text:'Finished'}}};
 assert.deepEqual(parser.accept(final),[{type:'text',text:'Finished'}]);assert.deepEqual(parser.accept(final),[]);
 assert.deepEqual(parser.accept({method:'item/completed',params:{item:{id:'private',type:'reasoning',text:'Hidden'}}}),[]);
});
test('Codex records the last reported request without mislabeling session totals or inventing cost',()=>{
 const parser=new CodexOutputParser();
 const frame={method:'thread/tokenUsage/updated',params:{tokenUsage:{total:{inputTokens:10000,outputTokens:2000},last:{inputTokens:12,outputTokens:3}}}};
 assert.deepEqual(parser.accept(frame),[{type:'usage',usage:{inputTokens:12,outputTokens:3,scope:'last-request'}}]);
 assert.deepEqual(parser.accept({method:frame.method,params:{tokenUsage:{last:{inputTokens:-1,outputTokens:NaN}}}}),[]);
});
test('Codex questions reach the human input channel and answers retain their opaque question identifiers',async()=>{
 const questions=[{id:'question-one',header:'Target',question:'Which target?',isSecret:false,options:[{label:'A',description:'First'}]},{id:'question-two',header:'Notes',question:'Any note?',isSecret:false,options:null}],seen:string[]=[],controller=new AbortController();
 const response=await answerCodexQuestions({questions},async(question,signal)=>{assert.equal(signal,controller.signal);seen.push(question);return seen.length===1?'A':'Keep it simple';},controller.signal);
 assert.deepEqual(JSON.parse(JSON.stringify(response)),{answers:{'question-one':{answers:['A']},'question-two':{answers:['Keep it simple']}}});
 assert.ok(seen[0].includes('A: First'));assert.equal(seen.length,2);
 let asked=false;await assert.rejects(answerCodexQuestions({questions:[{...questions[0],isSecret:true}]},async()=>{asked=true;return '';},controller.signal),/敏感输入/);assert.equal(asked,false);
 controller.abort();await assert.rejects(answerCodexQuestions({questions},async()=>{throw new Error('Must not ask');},controller.signal),/abort/i);
});
