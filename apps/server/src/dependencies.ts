import type { Artifact,Integration,Run,Task } from '../../../packages/protocol/src/index.ts';
import type { Store } from './store.ts';
import type { EventStore } from './ports/event-store.ts';
export function dependencyInputs(store: EventStore,task:Task){
  const versions:Record<string,number>={};
  for(const id of task.dependencies){const dependency=store.get<Task>('tasks',id);if(!dependency||dependency.roomId!==task.roomId||dependency.status!=='completed')throw new Error('依赖任务尚未完成');versions[id]=dependency.version;}
  const artifacts=store.list<Artifact>('artifacts',task.roomId).filter(artifact=>{
    if(!artifact.taskId||versions[artifact.taskId]===undefined||!artifact.runId)return false;
    const run=store.get<Run>('runs',artifact.runId);return run?.status==='completed'&&run.taskVersion===versions[artifact.taskId];
  });
  if(artifacts.length>50)throw new Error('依赖交付物超过 50 个，请拆分审查任务');
  return {versions,artifacts:artifacts.map(artifact=>artifact.id)};
}

export interface DependencyReadiness { ready:boolean; blockedBy:string[]; unmet:string[] }
/** Pure readiness check shared by scheduling and production dispatch. */
export function dependencyRequirementsReady(task:Task,tasks:Task[],integrations:Integration[]=[]):DependencyReadiness {
  const blockedBy:string[]=[],unmet:string[]=[];const byId=new Map(tasks.map(item=>[item.id,item]));
  for(const requirement of task.dependencyRequirements??[]){
    const target=byId.get(requirement.taskId);
    if(!target||target.roomId!==task.roomId){blockedBy.push(requirement.taskId);unmet.push(requirement.taskId+':missing');continue;}
    if(requirement.requirement==='execution'){
      if(target.status!=='completed'||target.version<requirement.taskVersion){blockedBy.push(requirement.taskId);unmet.push(requirement.taskId+':execution');}
    } else if(requirement.requirement==='accepted_artifact'){
      const artifactMatch=!requirement.artifactId||Boolean(target.acceptedArtifactIds?.includes(requirement.artifactId));
      if(target.acceptanceStatus!=='accepted'||target.version!==requirement.taskVersion||!artifactMatch){blockedBy.push(requirement.taskId);unmet.push(requirement.taskId+':accepted_artifact');}
    } else {
      const integrated=integrations.some(integration=>integration.taskId===requirement.taskId&&integration.status==='applied');
      if(!integrated){blockedBy.push(requirement.taskId);unmet.push(requirement.taskId+':integrated');}
    }
  }
  return {ready:blockedBy.length===0,blockedBy:[...new Set(blockedBy)],unmet};
}
