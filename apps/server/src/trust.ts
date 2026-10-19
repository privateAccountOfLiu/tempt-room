import type { Actor, AgentDescriptor, Message } from '../../../packages/protocol/src/index.ts';

/**
 * Source trust is derived from the authenticated actor and the local Agent
 * descriptor. It is a display/prompt-injection signal, not a new capability:
 * authorization still comes from the token and room membership.
 */
export function trustForActor(
  store: { get<T>(table: 'agents', id: string): T | undefined },
  actor: Actor
): Message['trust'] {
  if (actor.kind === 'human') return 'owner';
  if (actor.kind !== 'agent') return undefined;
  const agent = store.get<AgentDescriptor>('agents', actor.id);
  if (agent?.connectionMode === 'external') return 'external';
  if (agent?.provider === 'a2a') return 'remote';
  return 'managed';
}
export function trustLabel(trust: Message['trust']): string {
  return trust === 'owner' ? '你' : trust === 'managed' ? '本地托管' : trust === 'external' ? '外部来源' : trust === 'remote' ? '远程来源' : '未知来源';
}
