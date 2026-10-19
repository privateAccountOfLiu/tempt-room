import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';

const project=resolve('.'),parent=join(project,'.state','sdk-probes');mkdirSync(parent,{recursive:true});
const root=mkdtempSync(join(parent,'run-')),packages=join(root,'packages'),consumer=join(root,'consumer'),cache=join(root,'npm-cache');
for(const path of [packages,consumer,cache])mkdirSync(path);
const npm=process.env.npm_execpath??join(dirname(process.execPath),'node_modules','npm','bin','npm-cli.js');
const report={checkedAt:new Date().toISOString(),root,realModels:false,checks:[],packages:[]};
function run(args,cwd=project){
 const result=spawnSync(process.execPath,args,{cwd,windowsHide:true,encoding:'utf8',timeout:90000,maxBuffer:4*1024*1024});
 if(result.error)throw result.error;if(result.status!==0)throw new Error(`Command failed (${result.status}): ${args[0]}\n${result.stderr||result.stdout}`);return result.stdout;
}
function check(name,action){action();report.checks.push({name,passed:true});console.log(`${name}: PASS`);}
const npmArgs=['--offline','--ignore-scripts','--no-audit','--no-fund','--cache',cache];
function pack(path){
 const [result]=JSON.parse(run([npm,...npmArgs,'pack',path,'--json','--pack-destination',packages]));
 const file=join(packages,result.filename),bytes=readFileSync(file);
 report.packages.push({name:result.name,version:result.version,file,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});return {file,result};
}
try{
 for(const directory of ['protocol','client'])if(!existsSync(join(project,'packages',directory,'dist','index.js')))throw new Error('Build the SDK first: npm run build:sdk');
 const protocol=pack('./packages/protocol'),client=pack('./packages/client');
 check('published-file-shape',()=>{
  for(const entry of [protocol,client]){const paths=entry.result.files.map(file=>file.path);assert.ok(paths.includes('dist/index.js'));assert.ok(paths.includes('dist/index.d.ts'));assert.ok(paths.includes('package.json'));assert.ok(!paths.some(path=>path.startsWith('src/')||path.startsWith('.state/')));}
  assert.ok(protocol.result.files.some(file=>file.path==='schema/agent-tool-call.schema.json'));
  for(const schema of ['run-fence','tool-operation','run-partial','context-policy','context-delta','task-context','native-operation','native-reconciliation'])assert.ok(protocol.result.files.some(file=>file.path===`schema/${schema}.schema.json`));
 });
 // Pack the already-installed Zod dependency too: the consumer installation is
 // fully offline and cannot silently satisfy it from this repo's node_modules.
 const zod=pack('./node_modules/zod');
 writeFileSync(join(consumer,'package.json'),JSON.stringify({name:'room-sdk-consumer-test',private:true,type:'module'}));
 check('offline-install',()=>{
  run([npm,...npmArgs,'install','--package-lock=false',protocol.file,client.file,zod.file],consumer);
  for(const name of ['@tempt/room-protocol','@tempt/room-client','zod'])assert.ok(existsSync(join(consumer,'node_modules',name,'package.json')));
 });
 writeFileSync(join(consumer,'verify.mjs'),`
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {VERSION,commandSchema,agentSchema,agentToolCallSchema,messageSchema,runFenceSchema,sameRunFence,runPartialSchema,terminalStates,contextPolicySchema,contextSeqOf,taskContextSchema,nativeOperationSchema,nativeReconciliationSchema} from '@tempt/room-protocol';
import {RoomClient,RoomAgentClient} from '@tempt/room-client';
const require=createRequire(import.meta.url);
assert.equal(VERSION,'0.1');
const fence=runFenceSchema.parse({runId:'run_fixture',roomId:'room_fixture',agentId:'agent_fixture',generation:2,executionId:'execution_fixture'});
assert.equal(sameRunFence({id:fence.runId,...fence},fence),true);
assert.equal(sameRunFence({id:fence.runId,...fence,generation:1},fence),false);
assert.equal(typeof RoomClient.prototype.operations,'function');
assert.equal(terminalStates.has('superseded'),true);
const taskReceipt=taskContextSchema.parse({token:'context_receipt',baseSeq:1,throughSeq:7,hasMore:false,policy:{}});assert.equal(taskReceipt.throughSeq,7);
assert.equal(agentToolCallSchema.parse({commandId:'task_context_read',roomId:'room_fixture',name:'task_context'}).name,'task_context');
assert.equal(contextPolicySchema.parse({}).maxRounds,3);assert.equal(contextSeqOf({basedOnSeq:1,contextSeq:7}),7);
const native=nativeOperationSchema.parse({provider:'codex',scope:'execution',evidence:'execution-intent',inputId:'a'.repeat(64),kind:'execution'});assert.equal(native.scope,'execution');
assert.equal(nativeReconciliationSchema.safeParse({threadId:'thread',turnId:'turn',clientUserMessageId:'client',status:'completed',itemsView:'full'}).success,true);
const partialSchema=JSON.parse(readFileSync(require.resolve('@tempt/room-protocol/schema/run-partial.schema.json'),'utf8'));assert.equal(partialSchema.properties.text['x-maxUtf8Bytes'],65536);
assert.equal(runPartialSchema.safeParse({id:'draft',messageId:'stream',text:'Draft',createdAt:new Date().toISOString(),streamIndex:0,truncated:false}).success,true);
assert.equal(agentSchema.parse({id:'external',name:'External',provider:'api',connectionMode:'external'}).executionMode,'sandbox');
const schema=JSON.parse(readFileSync(require.resolve('@tempt/room-protocol/schema/agent-tool-call.schema.json'),'utf8'));
assert.ok(schema.required.includes('commandId'));assert.equal(schema.additionalProperties,false);
const versioned=messageSchema.parse({id:'message_fixture',roomId:'room_fixture',actor:{id:'external',kind:'agent'},text:'versioned result',mentions:[],attachments:[],createdAt:new Date().toISOString(),taskId:'task_fixture',taskVersion:2});assert.equal(versioned.taskVersion,2);
const messageJson=JSON.parse(readFileSync(require.resolve('@tempt/room-protocol/schema/message.schema.json'),'utf8'));assert.ok(messageJson.properties.taskId);assert.ok(messageJson.properties.taskVersion);
const observed=[];
const owner=new RoomClient('http://127.0.0.1:4317',{token:'fixture-owner',fetch:async(url,init)=>{
 assert.equal(init.headers['Room-Protocol-Version'],'0.1');assert.equal(init.headers['Room-Client-Type'],'sdk');assert.equal(init.headers.authorization,'Bearer fixture-owner');
 const input=commandSchema.parse(JSON.parse(init.body));observed.push(input);return new Response(JSON.stringify({commandId:input.commandId,accepted:true,result:{messageId:'fixture-message'}}));
}});
await owner.command('message.send',{text:'installed SDK'},'room_fixture','sdk_retry');
await owner.command('message.send',{text:'installed SDK'},'room_fixture','sdk_retry');
assert.deepEqual(observed[0],observed[1]);
const commands=[];let lose=true;
const external=new RoomAgentClient('http://127.0.0.1:4317','room_fixture','fixture-agent-token',{fetch:async(url,init)=>{
 assert.equal(url,'http://127.0.0.1:4317/api/agent/tool');assert.equal(init.headers.authorization,'Bearer fixture-agent-token');
 assert.equal(init.headers['Room-Protocol-Version'],'0.1');const command=agentToolCallSchema.parse(JSON.parse(init.body));commands.push(command);
 if(lose){lose=false;throw new Error('fixture lost response');}return new Response(JSON.stringify({result:{commandId:command.commandId,accepted:true,result:{messageId:'agent-message'}}}));
}});
const prepared=external.prepare('room_post',{text:'installed Agent SDK'},'agent_retry');
await assert.rejects(external.send(prepared),error=>error.commandId==='agent_retry');
const receipt=await external.send(prepared);assert.equal(receipt.result.messageId,'agent-message');assert.deepEqual(commands[0],commands[1]);
await assert.rejects(external.send({...prepared,roomId:'room_other'}),/another room/);
console.log('Installed ESM modules, schemas, author credentials and retry identities verified');
`);
 check('installed-esm-and-protocol',()=>run([join(consumer,'verify.mjs')],consumer));
 writeFileSync(join(consumer,'usage.ts'),`
import {agentSchema,commandSchema,type Task,type Run,type Command,type RunFence,type ToolOperation,type TaskContext,type NativeOperation} from '@tempt/room-protocol';
import {RoomClient,RoomAgentClient,type AgentToolCall,type Receipt} from '@tempt/room-client';
const agent=agentSchema.parse({id:'fixture',name:'Fixture',provider:'api'});
const command:Command=commandSchema.parse({version:'0.1',commandId:'one',type:'message.send',roomId:'room_fixture',payload:{text:'hello'}});
const owner=new RoomClient('http://127.0.0.1:4317',{token:'fixture-owner'});
const accepted:Promise<Receipt>=owner.command(command.type,command.payload,command.roomId,command.commandId);
const operations:Promise<ToolOperation[]>=owner.operations('run_fixture');
const fence:RunFence={runId:'run_fixture',roomId:'room_fixture',agentId:'agent_fixture',generation:2,executionId:'execution_fixture'};
const external=new RoomAgentClient('http://127.0.0.1:4317','room_fixture','fixture-agent-token');
const prepared:AgentToolCall=external.prepare('room_status');
const result:Promise<unknown>=external.send(prepared);
function taskVersion(task:Task,run:Run){return task.version===run.taskVersion;}
const taskInput:TaskContext={token:'context_input',baseSeq:1,throughSeq:7,hasMore:false,policy:{maxLag:64,maxRounds:0,maxDeltaBytes:262144}};
const nativeInput:NativeOperation={provider:'claude',scope:'tool',evidence:'provider-notification',inputId:'b'.repeat(64),kind:'Bash',itemId:'native_tool'};
void [agent,accepted,result,taskVersion,operations,fence,taskInput,nativeInput];
`);
 writeFileSync(join(consumer,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',strict:true,noEmit:true,types:[],lib:['ES2023','DOM'],skipLibCheck:false},files:['usage.ts']}));
 check('installed-typescript-declarations',()=>run([join(project,'node_modules/typescript/bin/tsc'),'--project',join(consumer,'tsconfig.json')],consumer));
}catch(error){report.checks.push({name:'sdk-consumer',passed:false,detail:error.message});console.error(error.message);process.exitCode=1;}
finally{writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2));console.log(`SDK consumer report: ${join(root,'report.json')}`);}
