import { ProtocolError, type AgentDescriptor } from '../../../packages/protocol/src/index.ts';

const readOnlyTools = new Set(['room_read', 'room_status', 'room_inbox']);
/** Per-agent pre-tool policy for Room tools. Authorization still comes from the run/connection token. */
export function assertRoomPostLength(agent: Pick<AgentDescriptor,'maxRoomPostChars'> | undefined, text: string): void {
  const limit = agent?.maxRoomPostChars ?? 32000;
  if (text.length > limit) throw new ProtocolError('tool_policy_denied', `单条发言超过该 Agent 的上限（${limit} 字符）`, 403);
}

export function assertRoomToolAllowed(policy: AgentDescriptor['roomToolPolicy'] | undefined, toolName: string, allowedTools?: readonly string[]): void {
  if (policy === 'deny') throw new ProtocolError('tool_policy_denied', '该 Agent 的房间工具权限为禁止', 403);
  if (policy === 'read-only' && !readOnlyTools.has(toolName)) throw new ProtocolError('tool_policy_denied', '该 Agent 的房间工具权限为只读', 403);
  if (allowedTools && !allowedTools.includes(toolName)) throw new ProtocolError('tool_policy_denied', '该 Agent 未被允许使用此房间工具', 403);
}
