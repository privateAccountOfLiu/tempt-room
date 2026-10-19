import type { Artifact,Run,Task } from '../../../packages/protocol/src/index.ts';
import type { Store } from './store.ts';
export function dependencyInputs(store:Store,task:Task){
  const versions:Record<string,number>={};
  for(const id of task.dependencies){const dependency=store.get<Task>('tasks',id);if(!dependency||dependency.roomId!==task.roomId||dependency.status!=='completed')throw new Error('依赖任务尚未完成');versions[id]=dependency.version;}
  const artifacts=store.list<Artifact>('artifacts',task.roomId).filter(artifact=>{
    if(!artifact.taskId||versions[artifact.taskId]===undefined||!artifact.runId)return false;
    const run=store.get<Run>('runs',artifact.runId);return run?.status==='completed'&&run.taskVersion===versions[artifact.taskId];
  });
  if(artifacts.length>50)throw new Error('依赖交付物超过 50 个，请拆分审查任务');
  return {versions,artifacts:artifacts.map(artifact=>artifact.id)};
}
