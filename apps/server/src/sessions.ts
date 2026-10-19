import { createHash } from 'node:crypto';
import { join,resolve } from 'node:path';
import type { AgentDescriptor,Run } from '../../../packages/protocol/src/index.ts';

export function chatWorkspace(root:string,run:Pick<Run,'roomId'|'agentId'>):string {
  return join(root,'sandboxes','chat',run.roomId,run.agentId,'workspace');
}
export function sessionKey(run:Run,agent:AgentDescriptor,workspace:string):string {
  // Version the scope so legacy sessions with a different cwd are never resumed.
  // Task snapshots, changed launchers and changed model selections get new scopes.
  const binding=createHash('sha256').update(JSON.stringify({workspace:resolve(workspace),provider:agent.provider,executable:agent.executable,runtimeDirectory:agent.runtimeDirectory,model:agent.model,version:agent.version,endpoint:agent.endpoint,credentialEnv:agent.credentialEnv})).digest('hex');
  return `v2:${run.roomId}:${run.agentId}:${run.taskId??'chat'}:${run.taskVersion??0}:${binding}`;
}
