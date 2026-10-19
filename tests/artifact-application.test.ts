import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createApp} from '../apps/server/src/app.ts';
import {uid} from '../apps/server/src/store.ts';
import type {Run,Artifact,Task} from '../packages/protocol/src/index.ts';

test('HTTP application rejects handed-off upstream and review patches, then applies the current reviewed bytes idempotently',async t=>{
 const base=resolve('.state/test-data');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'artifact-flow-'));
 const {app,store,service,worker}=await createApp({root,startWorker:false,token:'fixture-owner'});
 t.after(async()=>{await app.close();assert.ok(root.startsWith(base));rmSync(root,{recursive:true,force:true});});
 const project=join(root,'fixture-project');mkdirSync(project);writeFileSync(join(project,'answer.txt'),'original\n');
 const roomId=store.rooms()[0].id;
 const command=(type:any,payload:any)=>service.execute({version:'0.1',commandId:uid(),roomId,type,payload});
 const parentId=command('task.create',{title:'fixture implementation',agentId:'demo-planner',projectPath:project}).result.taskId as string;
 // Fixtures contain only text files written here; no Agent or generated code runs.
 const patch=(run:Run,text:string)=>{
  run.status='running';store.event(run.roomId,'run.started',{id:'system',kind:'system'},{run});
  const snapshot=worker.workspaces.snapshot(project,run.id);writeFileSync(join(snapshot.workspace,'answer.txt'),text);
  const changes=worker.workspaces.changes(run.id),artifact=worker.publishArtifact(run,'fixture.patch',changes.patch,'text/x-diff','patch');
  writeFileSync(join(root,'artifacts',artifact.id+'.changes.json'),JSON.stringify(changes));worker.finish(run,'completed');return artifact;
 };
 const parentRun=store.list<Run>('runs')[0],parentPatch=patch(parentRun,'old implementation\n');
 const childId=command('task.create',{title:'fixture review',agentId:'demo-reviewer',projectPath:project,dependencies:[parentId]}).result.taskId as string;
 const childRun=store.list<Run>('runs').find(run=>run.taskId===childId)!;childRun.dependencyVersions={[parentId]:1};
 const childPatch=patch(childRun,'old review\n');
 command('task.handoff',{taskId:parentId,agentId:'demo-reviewer'});
 const apply=(artifactId:string,commandId=uid())=>app.inject({method:'POST',url:'/api/commands',headers:{host:'127.0.0.1:4317',authorization:'Bearer fixture-owner','room-protocol-version':'0.1'},payload:{version:'0.1',commandId,roomId,type:'artifact.apply',payload:{artifactId}}});
 for(const artifact of [parentPatch,childPatch]){const rejected=await apply(artifact.id);assert.equal(rejected.statusCode,409);assert.equal(rejected.json().code,'stale_artifact');assert.ok(!store.get<Artifact>('artifacts',artifact.id)?.applied);}
 assert.equal(readFileSync(join(project,'answer.txt'),'utf8'),'original\n');assert.equal(existsSync(join(root,'apply')),false);
 assert.equal(store.get<Task>('tasks',childId)?.version,2);
 const nextParent=store.list<Run>('runs').find(run=>run.taskId===parentId&&run.taskVersion===2)!,currentPatch=patch(nextParent,'current implementation\n');
 const id=uid(),accepted=await apply(currentPatch.id,id),replay=await apply(currentPatch.id,id);
 assert.equal(accepted.statusCode,200);assert.equal(replay.statusCode,200);assert.deepEqual(replay.json(),accepted.json());
 assert.equal(readFileSync(join(project,'answer.txt'),'utf8'),'current implementation\n');
 assert.equal(store.get<Artifact>('artifacts',currentPatch.id)?.applied,true);
 const duplicate=await apply(currentPatch.id);assert.equal(duplicate.statusCode,409);assert.equal(duplicate.json().code,'already_applied');
 assert.equal(store.events(roomId).filter(event=>event.type==='artifact.applied').length,1);
});
