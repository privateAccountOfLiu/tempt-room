import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { createFixture,fixturePath,checkFixtureChanges,unchangedFixture,checkVerifierOutput } from '../scripts/acceptance-fixture.ts';
import { Workspaces } from '../apps/server/src/workspaces.ts';
import { runSandboxProgram } from '../apps/server/src/sandbox-program.ts';
import { ExecutionUnknown } from '../apps/server/src/adapters.ts';

test('acceptance fixture application is limited to one reviewed source change',t=>{
 const parent=resolve('.state/test-data');mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'acceptance-'));t.after(()=>{assert.ok(root.startsWith(parent));rmSync(root,{recursive:true,force:true});});
 const project=createFixture(root,'fixture'),workspaces=new Workspaces(root),snapshot=workspaces.snapshot(project,'run_fixture');
 assert.throws(()=>fixturePath(root,'../original-project'));assert.throws(()=>createFixture(root,'fixture'));unchangedFixture(project);
 writeFileSync(join(snapshot.workspace,'greet.cjs'),"exports.greet = name => 'Hello, friend!';\n");const change=workspaces.changes('run_fixture');checkFixtureChanges(change.changes);
 assert.equal(readFileSync(join(project,'greet.cjs'),'utf8'),"exports.greet = () => 'TODO';\n");
 writeFileSync(join(snapshot.workspace,'greet.spec.cjs'),'altered tests');assert.throws(()=>checkFixtureChanges(workspaces.changes('run_fixture').changes),/one text change/);
});
test('acceptance compares independently observed behavior and rejects wrong versions or missing tool results',()=>{
 const correct={results:['Goodbye, Alice!','Goodbye, friend!','Goodbye, friend!','Goodbye, Bob!'],npm:true,git:true};checkVerifierOutput(JSON.stringify(correct),'Goodbye');
 assert.throws(()=>checkVerifierOutput(JSON.stringify(correct),'Hello'),/incorrect behavior/);
 assert.throws(()=>checkVerifierOutput(JSON.stringify({...correct,npm:false}),'Goodbye'),/missing tool evidence/);
});
test('isolated verifier requires successful exit and proof of an empty process tree',async()=>{
 const host=new EventEmitter() as any;
 host.launch=async({runId}:any)=>{host.emit('notification',{type:'sandbox.started',runId,appContainer:true,job:true});host.emit('notification',{type:'sandbox.output',runId,stream:'stdout',data:'{"results":[]}'});host.emit('notification',{type:'sandbox.exit',runId,exitCode:0,jobEmpty:true});};
 assert.equal(await runSandboxProgram(host,{runId:'verify1',executable:'node.exe',args:[],workspace:'workspace',home:'home',runtimeRoots:[]}),'{"results":[]}');
 host.launch=async({runId}:any)=>{host.emit('notification',{type:'sandbox.started',runId,appContainer:true,job:true});host.emit('notification',{type:'sandbox.exit',runId,exitCode:0,jobEmpty:false});};
 await assert.rejects(runSandboxProgram(host,{runId:'verify2',executable:'node.exe',args:[],workspace:'workspace',home:'home',runtimeRoots:[]}),ExecutionUnknown);
});
