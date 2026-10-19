import { ProtocolError,sameRunFence,type Run,type RunFence,type Task } from '../../../packages/protocol/src/index.ts';
import type { Store } from './store.ts';

export function executionFence(run:Run):Readonly<RunFence> {
  if(!run.executionId)throw new ProtocolError('execution_identity_required','运行没有独立执行标识',409);
  return Object.freeze({runId:run.id,roomId:run.roomId,agentId:run.agentId,generation:run.generation??1,executionId:run.executionId});
}
export function assertRunFence(store:Store,fence:RunFence,options:{allowTerminal?:boolean;allowStaleTask?:boolean}={}):Run {
  const run=store.get<Run>('runs',fence.runId);
  if(!run||!sameRunFence(run,fence))throw new ProtocolError('stale_generation','执行标识或 generation 已变化，拒绝旧执行写入',409);
  if(!options.allowTerminal&&run.leaseUntil&&Date.parse(run.leaseUntil)<=Date.now())throw new ProtocolError('lease_expired','执行租约已过期，拒绝旧执行写入',409);
  if(!options.allowTerminal&&!['running','waiting_input'].includes(run.status))throw new ProtocolError('run_not_active','运行没有活动授权',409);
  if(!options.allowStaleTask&&run.taskId&&store.get<Task>('tasks',run.taskId)?.version!==run.taskVersion)throw new ProtocolError('stale_task_version','任务目标已变化，拒绝旧执行结果',409);
  return run;
}

/** Also used by trusted completion/reconciliation paths, including legacy rows. */
export function assertRunIdentity(store:Store,run:Run,allowStaleTask=false):Run {
  const current=store.get<Run>('runs',run.id);
  if(!current||current.roomId!==run.roomId||current.agentId!==run.agentId||
    (current.generation??1)!==(run.generation??1)||current.executionId!==run.executionId)
    throw new ProtocolError('stale_generation','执行标识或 generation 已变化，拒绝旧执行写入',409);
  if(!allowStaleTask&&run.taskId&&store.get<Task>('tasks',run.taskId)?.version!==run.taskVersion)throw new ProtocolError('stale_task_version','任务目标已变化，拒绝旧执行结果',409);
  if(!allowStaleTask&&current.leaseUntil&&Date.parse(current.leaseUntil)<=Date.now())throw new ProtocolError('lease_expired','执行租约已过期，拒绝旧执行写入',409);
  return current;
}
