import { ProtocolError, type AgentDescriptor } from '../../../packages/protocol/src/index.ts';

const readOnlyTools = new Set(['room_read', 'room_status']);
/** Per-agent pre-tool policy for Room tools. Authorization still comes from the run/connection token. */
export function assertRoomToolAllowed(policy: AgentDescriptor['roomToolPolicy'] | undefined, toolName: string): void {
  if (policy === 'deny') throw new ProtocolError('tool_policy_denied', '该 Agent 的房间工具权限为禁止', 403);
  if (policy === 'read-only' && !readOnlyTools.has(toolName)) throw new ProtocolError('tool_policy_denied', '该 Agent 的房间工具权限为只读', 403);
}
